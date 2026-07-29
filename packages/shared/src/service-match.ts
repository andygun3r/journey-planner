import { parseHhmm, resolvePatternTimes } from "./uk-time";

/**
 * Matching an LDBWS service to the Darwin run that is actually carrying it.
 *
 * Pure and DB-free so it can be tested directly — this is the logic that was
 * putting the wrong train's live progress on the page.
 *
 * What went wrong before, and what each piece here is for:
 *
 *  - The candidate query had no service-date bound, and the score key was
 *    `(crs, HH:MM)` with no date in it. Yesterday's run of the same service
 *    therefore scored IDENTICALLY to today's, and the winner was decided by
 *    `score > best.score` — i.e. whichever the Map happened to yield first.
 *    A stale run has an actual time at every stop, so it resolves as "arrived"
 *    and pins the train icon at the terminus. `pickBestRun` breaks that tie on
 *    which run's schedule actually brackets the current time, and REFUSES when
 *    it genuinely can't tell.
 *  - Darwin stops were indexed into a `Map` keyed by CRS alone. A route that
 *    calls twice at one station (circulars, reversals) has two legitimate rows
 *    for that CRS, the map kept the last, and both calls then read the second
 *    visit's data. `alignCallsToRun` walks the two sequences in order and
 *    consumes each stop at most once, so each visit gets its own row.
 */

export interface RunStop {
  seq: number;
  crs: string | null;
  schedArr: string | null;
  schedDep: string | null;
  schedPass?: string | null;
  actArr?: string | null;
  actDep?: string | null;
}

export interface CandidateRun<S extends RunStop = RunStop> {
  rid: string;
  /** Darwin's scheduled start date, "YYYY-MM-DD". */
  ssd: string;
  stops: S[];
}

/** A run must match at least this share of the overlapping pattern to be trusted. */
const MIN_COVERAGE = 0.6;
/** ...and at least this many stops outright (or the whole pattern, if shorter). */
const MIN_MATCHED = 3;

/** The scheduled time a stop is known by, in feed order of preference. */
function stopTimes(s: RunStop): string[] {
  return [s.schedDep, s.schedArr, s.schedPass].filter((t): t is string => Boolean(t));
}

/**
 * Darwin stops in running order.
 *
 * `seq` can tie: darwin-ingest's applyTS inserts a stop seen without a seeding
 * SC message at its nearest lower neighbour's seq rather than an interpolated
 * one, because seq is a smallint. Fall back to scheduled time so the route
 * still comes out ordered.
 */
export function orderRunStops<S extends RunStop>(stops: S[]): S[] {
  return [...stops].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    const at = stopTimes(a)[0] ?? "";
    const bt = stopTimes(b)[0] ?? "";
    return at.localeCompare(bt);
  });
}

/** `(crs|HH:MM)` keys for the LDBWS calls, used to score candidate runs. */
export function callKeys(calls: Array<{ crs?: string; scheduled?: string }>): Set<string> {
  const keys = new Set<string>();
  for (const c of calls) {
    if (c.crs && c.scheduled) keys.add(`${c.crs}|${c.scheduled.slice(0, 5)}`);
  }
  return keys;
}

export interface RunScore {
  /** Stops of this run that appear in the LDBWS pattern at the same minute. */
  matched: number;
  /** Matched as a share of the overlap that was possible at all. */
  coverage: number;
}

/**
 * Score a candidate run against the LDBWS pattern.
 *
 * Coverage is measured against the SMALLER of the two patterns on purpose:
 * Darwin's schedule for a run can legitimately begin partway through the
 * real-world journey (a service LDBWS shows as starting at Waterloo may only be
 * timed by Darwin from Clapham Junction onward), and scoring against the LDBWS
 * length alone would reject those good matches.
 */
export function scoreRun(stops: RunStop[], keys: Set<string>): RunScore {
  let matched = 0;
  let withCrs = 0;
  for (const s of stops) {
    if (!s.crs) continue;
    withCrs++;
    for (const time of stopTimes(s)) {
      if (keys.has(`${s.crs}|${time.slice(0, 5)}`)) {
        matched++;
        break;
      }
    }
  }
  const denominator = Math.min(keys.size, withCrs) || 1;
  return { matched, coverage: matched / denominator };
}

/** Does this score clear the bar to be trusted at all? */
export function isAcceptable(score: RunScore, patternSize: number): boolean {
  // Short patterns (boarding two stops from the end) can't reach MIN_MATCHED,
  // so for those require the whole thing to line up instead.
  const required = Math.min(MIN_MATCHED, patternSize);
  return score.matched >= required && score.coverage >= MIN_COVERAGE;
}

/**
 * When this run is scheduled to be running, as epoch ms.
 *
 * Times are resolved as a sequence from the run's own start date, so an
 * overnight run gets a window that genuinely spans midnight instead of
 * collapsing to a single day.
 */
export function runWindow(stops: RunStop[], ssd: string): { start: number; end: number } | null {
  const ordered = orderRunStops(stops);
  const times = ordered.map((s) => stopTimes(s)[0] ?? null);
  if (!times.some((t) => parseHhmm(t) !== null)) return null;

  // Midday of the service start date is a safe anchor: it's far from midnight
  // in both directions, so the first stop can't be pulled onto the wrong day.
  const [y, m, d] = ssd.split("-").map(Number);
  if (!y || !m || !d) return null;
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0));

  const iso = resolvePatternTimes(times, anchor);
  const ms = iso.filter(Boolean).map((t) => Date.parse(t!));
  if (ms.length === 0) return null;
  return { start: Math.min(...ms), end: Math.max(...ms) };
}

/** Grace either side of the booked window before a run counts as "not now". */
const WINDOW_LEAD_MS = 15 * 60_000;
const WINDOW_TRAIL_MS = 90 * 60_000;

/** How far `now` sits outside the run's scheduled window (0 = currently due). */
export function windowDistance(window: { start: number; end: number } | null, now: number): number {
  if (!window) return Number.POSITIVE_INFINITY;
  if (now >= window.start - WINDOW_LEAD_MS && now <= window.end + WINDOW_TRAIL_MS) return 0;
  return Math.min(Math.abs(now - window.start), Math.abs(now - window.end));
}

export interface RunPick<S extends RunStop> {
  run: CandidateRun<S>;
  score: RunScore;
  /** Ordered stops of the winning run. */
  stops: S[];
}

/**
 * Choose the run carrying this service, or null if we can't tell.
 *
 * Ranking: best score first, then whichever run is actually due around now.
 * If two candidates are still indistinguishable, we return null rather than
 * pick one — showing the wrong train's position is worse than showing none,
 * and the caller surfaces that as "awaiting report" rather than inventing a
 * location.
 */
export function pickBestRun<S extends RunStop>(
  runs: Array<CandidateRun<S>>,
  keys: Set<string>,
  now: number = Date.now(),
): RunPick<S> | null {
  const scored = runs
    .map((run) => ({
      run,
      score: scoreRun(run.stops, keys),
      distance: windowDistance(runWindow(run.stops, run.ssd), now),
    }))
    .filter((c) => isAcceptable(c.score, keys.size));

  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    if (b.score.matched !== a.score.matched) return b.score.matched - a.score.matched;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return b.score.coverage - a.score.coverage;
  });

  const best = scored[0]!;
  const runnerUp = scored[1];
  // Genuinely indistinguishable — same quality of match, both equally plausible
  // right now. Refuse: this is the yesterday-vs-today case that used to resolve
  // by Map iteration order.
  if (
    runnerUp &&
    runnerUp.score.matched === best.score.matched &&
    runnerUp.distance === best.distance &&
    runnerUp.score.coverage === best.score.coverage
  ) {
    return null;
  }

  return { run: best.run, score: best.score, stops: orderRunStops(best.run.stops) };
}

export interface TdReport {
  headcode: string | null;
  crs: string | null;
  reportedAtMs: number;
  event: string | null;
}

export interface RouteStop {
  /** Index into the calls array. */
  index: number;
  crs: string;
  /** When the train is booked to be here, epoch ms. */
  scheduledMs?: number;
}

export interface TdMatch {
  headcode: string;
  stopIndex: number;
  crs: string;
  event: string | null;
}

/**
 * How far from its booked time at a stop a berth report can be and still
 * plausibly belong to this train. Wide enough for a badly delayed service,
 * far tighter than "any train standing at a station on this route".
 */
export const TD_TOLERANCE_MS = 90 * 60_000;

/**
 * Correlate anonymous TD berth reports to this service by position AND time.
 *
 * This is the fallback used when Darwin never resolved (its schedule/activation
 * message can be missed after a feed outage, while TD keeps flowing). It has to
 * work without a rid, which makes it the weakest link in the chain — so it is
 * deliberately the strictest.
 *
 * The previous version's only test was "exactly one distinct headcode is
 * currently at an intermediate stop of this route", which any unrelated train
 * standing at a shared station satisfies. Its docstring promised a timing
 * tolerance that was never implemented; this is that tolerance. A report is
 * only considered if the train is booked to be near that stop around then, and
 * an ambiguous picture still refuses outright.
 */
export function plausibleTdMatch(
  reports: TdReport[],
  routeStops: RouteStop[],
  toleranceMs: number = TD_TOLERANCE_MS,
): TdMatch | null {
  const byCrs = new Map<string, RouteStop[]>();
  for (const s of routeStops) {
    const list = byCrs.get(s.crs) ?? [];
    list.push(s);
    byCrs.set(s.crs, list);
  }

  const candidates = new Map<string, TdMatch>();
  for (const r of reports) {
    if (!r.headcode || !r.crs) continue;
    const stopsHere = byCrs.get(r.crs);
    if (!stopsHere || stopsHere.length === 0) continue;

    // Of this route's visits to that station, take the one the report is
    // closest to in time; a stop with no booked time can't be corroborated.
    let bestStop: RouteStop | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const s of stopsHere) {
      if (s.scheduledMs === undefined) continue;
      const gap = Math.abs(r.reportedAtMs - s.scheduledMs);
      if (gap < bestGap) {
        bestGap = gap;
        bestStop = s;
      }
    }
    if (!bestStop || bestGap > toleranceMs) continue;

    // One headcode can report at several of our stops; keep its furthest-along
    // one, which is the train's current front.
    const existing = candidates.get(r.headcode);
    if (!existing || bestStop.index > existing.stopIndex) {
      candidates.set(r.headcode, {
        headcode: r.headcode,
        stopIndex: bestStop.index,
        crs: r.crs,
        event: r.event,
      });
    }
  }

  // More than one plausible train means we cannot say which is ours.
  if (candidates.size !== 1) return null;
  return [...candidates.values()][0]!;
}

/**
 * Line the LDBWS calls up with the run's stops, in order.
 *
 * Returns, per call, the index into `runStops` it corresponds to (or undefined).
 * Each run stop is consumed at most once and matching only ever moves forward,
 * which is what makes a route that visits one CRS twice resolve to two
 * different rows instead of both reading the last one.
 *
 * Stops the run has but the calls don't (passing points, unadvertised stops)
 * are simply skipped over.
 */
export function alignCallsToRun(
  callCrs: Array<string | undefined>,
  runStops: Array<{ crs: string | null }>,
): Array<number | undefined> {
  const out: Array<number | undefined> = [];
  let cursor = 0;
  for (const crs of callCrs) {
    if (!crs) {
      out.push(undefined);
      continue;
    }
    let found = -1;
    for (let k = cursor; k < runStops.length; k++) {
      if (runStops[k]!.crs === crs) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      out.push(found);
      cursor = found + 1;
    } else {
      out.push(undefined);
    }
  }
  return out;
}
