import { z } from "zod";

/**
 * Commute domain: the per-day-of-week schedule model shared by the web app
 * (schedule editor, dashboard) and the darwin-ingest worker (corridor
 * precompute, alert matching). Kept framework-free so both sides import it.
 *
 * All "is this leg active now / today" math is done in UK local time
 * (Europe/London) via Intl, never the host's local timezone — see the date
 * helpers at the bottom.
 */

// ---------------------------------------------------------------------------
// Validation schemas (used by both client editor and server writes)
// ---------------------------------------------------------------------------

const CRS = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Must be a 3-letter CRS code");

/** HH:MM (24h). Stored in Postgres `time` columns. */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:MM");

/** A window is optional, but if either bound is set both must be, start < end. */
const Window = z
  .object({
    start: HHMM.nullish(),
    end: HHMM.nullish(),
  })
  .refine((w) => (w.start == null) === (w.end == null), {
    message: "Set both start and end, or neither",
  })
  .refine((w) => w.start == null || w.end == null || w.start < w.end, {
    message: "Start must be before end",
  });

export const CommuteLegInput = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6), // 0 = Mon ... 6 = Sun
    workCrs: CRS,
    workLabel: z.string().trim().min(1).max(60),
    am: Window,
    pm: Window,
  })
  .refine((l) => l.am.start != null || l.pm.start != null, {
    message: "A day needs at least an AM or a PM window",
  });
export type CommuteLegInput = z.infer<typeof CommuteLegInput>;

export const CommuteInput = z.object({
  label: z.string().trim().min(1).max(60),
  homeCrs: CRS,
  homeLabel: z.string().trim().min(1).max(60),
  legs: z.array(CommuteLegInput).min(1).max(7),
});
export type CommuteInput = z.infer<typeof CommuteInput>;

export const HolidayInput = z
  .object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
    label: z.string().trim().max(60).nullish(),
  })
  .refine((h) => h.startDate <= h.endDate, {
    message: "End date must be on or after start date",
  });
export type HolidayInput = z.infer<typeof HolidayInput>;

// ---------------------------------------------------------------------------
// Resolved-shape types (as read back from the DB by the resolver)
// ---------------------------------------------------------------------------

export type Direction = "am" | "pm";

export interface CommuteRecord {
  id: string;
  label: string;
  homeCrs: string | null;
  homeLabel: string | null;
}

export interface CommuteLegRecord {
  id: string;
  dayOfWeek: number;
  workCrs: string;
  workLabel: string;
  amWindowStart: string | null;
  amWindowEnd: string | null;
  pmWindowStart: string | null;
  pmWindowEnd: string | null;
}

export interface HolidayRange {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD inclusive
}

/** The single leg that is "in play" for a commute at a given moment. */
export interface ActiveLeg {
  legId: string;
  dayOfWeek: number;
  direction: Direction;
  originCrs: string;
  originLabel: string;
  destCrs: string;
  destLabel: string;
  /** Window bounds HH:MM for the chosen direction. */
  windowStart: string;
  windowEnd: string;
  /** True when the window has not started yet (upcoming), false when in it. */
  upcoming: boolean;
}

// ---------------------------------------------------------------------------
// UK-local date/time helpers (Europe/London, no date library)
// ---------------------------------------------------------------------------

const LONDON = "Europe/London";

const ymdFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: LONDON,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const hmFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** UK-local calendar date of an instant, as YYYY-MM-DD. */
export function londonDate(at: Date = new Date()): string {
  return ymdFmt.format(at);
}

/** UK-local wall-clock time of an instant, as HH:MM. */
export function londonTime(at: Date = new Date()): string {
  // en-GB can emit "24:00" at midnight in some engines; normalise to "00:00".
  const hm = hmFmt.format(at);
  return hm === "24:00" ? "00:00" : hm;
}

/** Day-of-week for a UK-local date, 0 = Monday ... 6 = Sunday. */
export function londonDayOfWeek(at: Date = new Date()): number {
  // Build a noon UTC instant for the local date to avoid DST edge slips, then
  // read the weekday name in London and map it. Using the formatter is the
  // most robust way to get the *local* weekday.
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, weekday: "short" }).format(at);
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return order.indexOf(wd);
}

/** Day-of-week for a YYYY-MM-DD service date, 0 = Monday ... 6 = Sunday. */
export function dayOfWeekForDate(ymd: string): number {
  // Interpret as a date at UTC noon — safe for weekday extraction regardless of TZ.
  const d = new Date(`${ymd}T12:00:00Z`);
  const js = d.getUTCDay(); // 0 = Sunday
  return (js + 6) % 7;
}

export function isDateInHolidayRange(ymd: string, ranges: HolidayRange[]): boolean {
  return ranges.some((r) => ymd >= r.startDate && ymd <= r.endDate);
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

function windowFor(leg: CommuteLegRecord, dir: Direction): { start: string; end: string } | null {
  const start = dir === "am" ? leg.amWindowStart : leg.pmWindowStart;
  const end = dir === "am" ? leg.amWindowEnd : leg.pmWindowEnd;
  if (start == null || end == null) return null;
  return { start, end };
}

/**
 * Given a commute, its legs, the device's holidays and "now", decide which
 * single leg+direction the dashboard should focus on.
 *
 * Rules (all in UK local time):
 *  - Today must not be a holiday and must have a leg for that day-of-week.
 *  - AM (home→work) is chosen while now is before or within the AM window.
 *  - Otherwise PM (work→home) is chosen while now is before or within the PM
 *    window.
 *  - Once both windows for today have passed (or the day has neither remaining),
 *    returns null — the caller shows a rest-of-day / next-day state.
 *
 * Returns the active leg, or null when nothing is in play right now.
 */
export function resolveActiveLeg(
  commute: CommuteRecord,
  legs: CommuteLegRecord[],
  holidays: HolidayRange[],
  now: Date = new Date(),
): ActiveLeg | null {
  const today = londonDate(now);
  if (isDateInHolidayRange(today, holidays)) return null;

  const dow = londonDayOfWeek(now);
  const leg = legs.find((l) => l.dayOfWeek === dow);
  if (!leg) return null;

  const homeCrs = commute.homeCrs;
  const homeLabel = commute.homeLabel ?? "Home";
  if (!homeCrs) return null;

  const nowHm = londonTime(now);

  const am = windowFor(leg, "am");
  if (am && nowHm <= am.end) {
    return {
      legId: leg.id,
      dayOfWeek: dow,
      direction: "am",
      originCrs: homeCrs,
      originLabel: homeLabel,
      destCrs: leg.workCrs,
      destLabel: leg.workLabel,
      windowStart: am.start,
      windowEnd: am.end,
      upcoming: nowHm < am.start,
    };
  }

  const pm = windowFor(leg, "pm");
  if (pm && nowHm <= pm.end) {
    return {
      legId: leg.id,
      dayOfWeek: dow,
      direction: "pm",
      originCrs: leg.workCrs,
      originLabel: leg.workLabel,
      destCrs: homeCrs,
      destLabel: homeLabel,
      windowStart: pm.start,
      windowEnd: pm.end,
      upcoming: nowHm < pm.start,
    };
  }

  return null;
}

/**
 * Build the ISO datetime (offset-aware) for a service date + HH:MM in UK local
 * time — used to seed routing-engine `plan()` queries at a window's start.
 * Determines the London UTC offset for that date via Intl and applies it.
 */
export function londonWallTimeToIso(ymd: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  // Find London's offset (minutes) on that date by formatting a probe instant.
  const probe = new Date(`${ymd}T${hhmm}:00Z`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
    timeZoneName: "shortOffset",
  }).formatToParts(probe);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  // tzName is like "GMT" or "GMT+1"; parse the hour offset.
  const match = /GMT([+-]\d+)?/.exec(tzName);
  const offsetHours = match?.[1] ? Number(match[1]) : 0;
  const sign = offsetHours >= 0 ? "+" : "-";
  const abs = Math.abs(offsetHours);
  const offset = `${sign}${String(abs).padStart(2, "0")}:00`;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${ymd}T${hh}:${mm}:00${offset}`;
}
