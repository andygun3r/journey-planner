/**
 * UK-local (Europe/London) time handling, in one place.
 *
 * Every rail feed in this app speaks bare wall-clock time: LDBWS gives "HH:MM",
 * Darwin gives "HH:MM[:SS]", both in UK local time with no date and no offset.
 * Turning those into real instants is the single most error-prone thing the app
 * does, and it used to be done by three subtly different copies of the same
 * code (ldbws.ts, service-progress.ts, and a formatter pasted into ~15 files).
 *
 * Two rules, and the distinction between them matters:
 *
 *  - `hhmmToIso` resolves ONE time against an anchor, choosing the nearest of
 *    yesterday/today/tomorrow. Right for a board row, where every time sits
 *    within a couple of hours of "now".
 *  - `resolvePatternTimes` resolves a WHOLE calling pattern in order, rolling
 *    the day forward whenever the clock goes backwards. Right for a journey,
 *    where an overnight service legitimately runs 23:47 → 00:14 → 01:32 and
 *    each stop must be dated relative to the one before it, not to "now".
 *
 * Resolving a calling pattern stop-by-stop against "now" is what produced
 * out-of-order calling points on overnight services; don't reintroduce it.
 *
 * Never rely on the host timezone — every formatter here pins Europe/London.
 */

export interface UkParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const ukDtf = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const ukHmDtf = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Calendar/clock fields of an instant, as seen in Europe/London. */
export function ukParts(d: Date): UkParts {
  const p = Object.fromEntries(ukDtf.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    // en-GB with hour12:false renders midnight as "24" in some ICU versions.
    hour: Number(p.hour === "24" ? "00" : p.hour),
    month: Number(p.month),
    day: Number(p.day),
    minute: Number(p.minute),
  };
}

/** London's offset from UTC in minutes at that instant (+60 during BST). */
export function londonOffsetMinutes(d: Date): number {
  const p = ukParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - d.getTime()) / 60000);
}

/** London offset as an ISO suffix, e.g. "+01:00". */
export function londonOffsetString(d: Date): string {
  const diffMin = londonOffsetMinutes(d);
  const sign = diffMin >= 0 ? "+" : "-";
  const abs = Math.abs(diffMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" for the London calendar date of an instant. */
export function londonDateKey(d: Date = new Date()): string {
  const p = ukParts(d);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Accepts "HH:MM" or Darwin's "HH:MM:SS"; returns minutes since midnight. */
export function parseHhmm(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * A London wall-clock date+time back to a real instant.
 *
 * The offset has to be read at the resulting instant, not the naive one, or
 * times within an hour of a DST transition land an hour out — hence the
 * refinement pass.
 */
function londonWallToInstant(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  const firstGuess = naive - londonOffsetMinutes(new Date(naive)) * 60000;
  const settled = naive - londonOffsetMinutes(new Date(firstGuess)) * 60000;
  return new Date(settled);
}

/** Midnight-London of the day `dayShift` days from the anchor's London date. */
function shiftedLondonDate(anchor: Date, dayShift: number): UkParts {
  // Step in whole days from midday to stay clear of DST transitions, which
  // would otherwise make "+1 day" land on the same or the wrong calendar date.
  const p = ukParts(anchor);
  const middayUtc = Date.UTC(p.year, p.month - 1, p.day, 12, 0);
  return ukParts(new Date(middayUtc + dayShift * 86_400_000));
}

/**
 * Resolve a single bare "HH:MM" to an ISO instant, picking whichever of
 * yesterday / today / tomorrow lands nearest the anchor.
 *
 * Symmetric on purpose. The previous rule only ever shifted forward, so a board
 * generated at 00:03 still listing the 23:59 departure dated it 23:59 *tonight*
 * — a train four minutes in the past displayed as ~24 hours in the future,
 * which then poisoned its delay figure and countdown.
 */
export function hhmmToIso(
  hhmm: string | null | undefined,
  anchor: Date = new Date(),
): string | undefined {
  const minutesOfDay = parseHhmm(hhmm);
  if (minutesOfDay === null) return undefined;

  let best: { instant: Date; distance: number } | null = null;
  for (const dayShift of [-1, 0, 1]) {
    const d = shiftedLondonDate(anchor, dayShift);
    const instant = londonWallToInstant(d.year, d.month, d.day, minutesOfDay);
    const distance = Math.abs(instant.getTime() - anchor.getTime());
    if (!best || distance < best.distance) best = { instant, distance };
  }
  return best!.instant.toISOString();
}

/**
 * Resolve an ordered calling pattern to ISO instants.
 *
 * The first known time is anchored the same way a board row is; every later
 * stop is dated relative to its predecessor, rolling the day forward whenever
 * the wall clock goes backwards. That is what makes an overnight pattern
 * (23:47 → 00:14 → 01:32) come out monotonic instead of being scattered across
 * three different days by three independent guesses.
 *
 * Entries that don't parse come back as `undefined` and don't disturb the walk.
 */
export function resolvePatternTimes(
  times: Array<string | null | undefined>,
  anchor: Date = new Date(),
): Array<string | undefined> {
  const out: Array<string | undefined> = new Array(times.length).fill(undefined);

  const firstIdx = times.findIndex((t) => parseHhmm(t) !== null);
  if (firstIdx === -1) return out;

  const firstIso = hhmmToIso(times[firstIdx], anchor);
  if (!firstIso) return out;
  out[firstIdx] = firstIso;

  let dayShift = 0;
  let previousMinutes = parseHhmm(times[firstIdx])!;

  for (let i = firstIdx + 1; i < times.length; i++) {
    const minutesOfDay = parseHhmm(times[i]);
    if (minutesOfDay === null) continue;
    // Clock went backwards => the pattern crossed midnight.
    if (minutesOfDay < previousMinutes) dayShift++;
    const day = shiftedLondonDate(new Date(firstIso), dayShift);
    out[i] = londonWallToInstant(day.year, day.month, day.day, minutesOfDay).toISOString();
    previousMinutes = minutesOfDay;
  }

  // Stops before the first parseable one (rare: a pattern whose head has no
  // times) walk backwards under the same rule.
  let backwardShift = 0;
  let nextMinutes = parseHhmm(times[firstIdx])!;
  for (let i = firstIdx - 1; i >= 0; i--) {
    const minutesOfDay = parseHhmm(times[i]);
    if (minutesOfDay === null) continue;
    if (minutesOfDay > nextMinutes) backwardShift--;
    const day = shiftedLondonDate(new Date(firstIso), backwardShift);
    out[i] = londonWallToInstant(day.year, day.month, day.day, minutesOfDay).toISOString();
    nextMinutes = minutesOfDay;
  }

  return out;
}

/** Minutes late, from real instants. Negative means early. */
export function minutesLate(
  scheduledIso: string | null | undefined,
  liveIso: string | null | undefined,
): number | undefined {
  if (!scheduledIso || !liveIso) return undefined;
  const s = Date.parse(scheduledIso);
  const l = Date.parse(liveIso);
  if (!Number.isFinite(s) || !Number.isFinite(l)) return undefined;
  return Math.round((l - s) / 60000);
}

/** "HH:MM" in Europe/London for an ISO instant (or Date). Undefined if unparseable. */
export function ukHhmm(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return undefined;
  return ukHmDtf.format(d);
}
