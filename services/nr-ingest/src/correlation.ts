import { hhmmToIso, resolvePatternTimes } from "@signaller/shared";

/**
 * The pure half of headcode-to-rid correlation: given a candidate's calling
 * pattern, how well does it explain a report from a place at a time?
 *
 * Split out of store.ts so it can be tested without a database. The logic here
 * is unchanged from when it lived there — only the data source moved. That
 * matters because this is the most carefully tuned code in the project and the
 * easiest to break silently: a wrong answer here links a train to the wrong
 * service and nothing downstream can tell.
 *
 * Everything in this file is a pure function. No queries, no clock reads beyond
 * what is passed in.
 */

/** One stop on a candidate's booked calling pattern. */
export interface PatternRow {
  seq: number;
  tiploc: string;
  crs: string | null;
  schedArr: string | null;
  schedDep: string | null;
  schedPass: string | null;
}

/**
 * How far from its booked time at a tiploc a report can be and still
 * plausibly belong to that candidate rid. Same tolerance and reasoning as
 * apps/web/lib/service-match.ts's TD_TOLERANCE_MS — wide enough for a badly
 * delayed service, far tighter than "any train standing at a shared station".
 * Duplicated rather than imported: service-match.ts lives in apps/web, which
 * this service (a separate package) doesn't depend on. Keep the two values in
 * sync if either changes.
 */
export const TD_TOLERANCE_MS = 90 * 60_000;

/**
 * How close a candidate's booked time must be to TRUST's OWN booked time
 * (`planned_timestamp`) to count as a booked-vs-booked match.
 *
 * Deliberately tight. Both sides are *plan*, not observation, so there is no
 * delay to absorb — the only slack needed covers the two sources rounding to
 * different granularities (Darwin publishes HH:MM and HH:MM:30, TRUST to the
 * minute) and minor timetable-version skew.
 */
export const BOOKED_TOLERANCE_MS = 5 * 60_000;

/**
 * Confidence that a candidate rid explains a report at a given location.
 * Ordered, and compared with STRICT inequality when picking a winner, so two
 * candidates with equally good evidence resolve to "ambiguous" rather than an
 * arbitrary pick.
 */
export const SCORE_NONE = 0;
/** Interpolated time, only within the loose actual-time window. Weakest. */
export const SCORE_INTERPOLATED = 1;
/** Real booked row within the loose actual-time window. */
export const SCORE_ACTUAL_IN_WINDOW = 2;
/** Interpolated time, but agreeing with TRUST's booked time. */
export const SCORE_INTERPOLATED_BOOKED = 3;
/** Published booked time agreeing with TRUST's booked time. Strongest. */
export const SCORE_BOOKED_MATCH = 4;

/**
 * Put a calling pattern into TRAVEL order.
 *
 * `seq` looks like travel order and mostly is, but it is not reliable: measured
 * across 400 of today's schedules, **5.7% of consecutive stop pairs go
 * backwards in time**. darwin-ingest assigns seq on a best-effort basis when a
 * TS message patches in a stop it hasn't seen (applyTS's seqForTime), reusing
 * the lower neighbour's seq because the column is a smallint with no room for
 * fractional values — so ties and mis-slotted stops are expected by design.
 *
 * Confirmed live on rid 202607297100735, where the train physically ran
 * TGM -> DWL -> DWW -> EXD -> TVP -> TAU but the stored pattern lists EXD/TVP/
 * TAU at seq 3-5 and TGM/DWL/DWW at seq 26-28.
 *
 * Booked time is the real ordering signal, so sort on it and keep seq only as
 * a tiebreak for stops sharing a time. Untimed stops can't be placed by time,
 * so they hold their seq-relative position.
 *
 * This matters to two callers for different reasons:
 *  - trajectory scoring compares an observed sequence against this one, so a
 *    scrambled pattern makes the comparison meaningless;
 *  - resolvePatternTimes ASSUMES travel order (it rolls the day forward
 *    whenever the clock goes backwards), so feeding it a scrambled pattern
 *    invents midnight rollovers that never happened.
 */
export function inTravelOrder<
  T extends { seq: number; schedArr: string | null; schedDep: string | null; schedPass: string | null },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = a.schedArr ?? a.schedDep ?? a.schedPass;
    const tb = b.schedArr ?? b.schedDep ?? b.schedPass;
    // Both timed: order by clock, seq breaking exact ties.
    if (ta && tb) return ta === tb ? a.seq - b.seq : ta < tb ? -1 : 1;
    // Only one timed: fall back to seq, which is all that relates them.
    return a.seq - b.seq;
  });
}

/** Does this pattern row describe the reported location? */
function atLocation(row: PatternRow, tiploc: string | null, crs: string | null): boolean {
  return Boolean((tiploc && row.tiploc === tiploc) || (crs && row.crs === crs));
}

/**
 * Best-effort instant for a stop that carries no booked time of its own.
 *
 * Resolves the WHOLE pattern via resolvePatternTimes (correct midnight-rollover
 * handling, same as used for journey display), then derives the target's
 * instant: interpolating between the nearest timed neighbours when the target
 * sits between two, and extrapolating from the two nearest timed stops when it
 * sits in an untimed head or tail. Returns null when the stop isn't in the
 * pattern, when fewer than two stops carry a time, or when the timings are
 * degenerate.
 *
 * `pattern` must already be in travel order.
 */
export function interpolateTimeFromPattern(
  pattern: PatternRow[],
  tiploc: string | null,
  crs: string | null,
  at: Date,
): string | null {
  const targetIdx = pattern.findIndex((p) => atLocation(p, tiploc, crs));
  if (targetIdx === -1) return null;
  const target = pattern[targetIdx]!;
  if (target.schedArr || target.schedDep || target.schedPass) {
    return null; // has its own time after all; not this function's job
  }

  const resolved = resolvePatternTimes(
    pattern.map((p) => p.schedArr ?? p.schedDep ?? p.schedPass),
    at,
  );

  let beforeIdx = -1;
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (resolved[i]) {
      beforeIdx = i;
      break;
    }
  }
  let afterIdx = -1;
  for (let i = targetIdx + 1; i < resolved.length; i++) {
    if (resolved[i]) {
      afterIdx = i;
      break;
    }
  }
  // Interpolate when the target sits between two timed stops.
  if (beforeIdx !== -1 && afterIdx !== -1) {
    const beforeMs = Date.parse(resolved[beforeIdx]!);
    const afterMs = Date.parse(resolved[afterIdx]!);
    const fraction = (targetIdx - beforeIdx) / (afterIdx - beforeIdx);
    return new Date(beforeMs + (afterMs - beforeMs) * fraction).toISOString();
  }

  // Otherwise EXTRAPOLATE from the two nearest timed stops on whichever side
  // exists. Darwin routinely emits a run of untimed junction rows AFTER the
  // last timed stop (measured: 11,429 rids, 17.7% of those with any untimed
  // row) and, less often, before the first (1,707 rids) — a target in either
  // tail has no enclosing pair, so interpolation alone silently gave up on it.
  //
  // Confirmed live: TRUST 422K88MY29 (headcode 2K88) reporting from CREWSJN,
  // whose only candidate had CREWSJN at seq 1 with the timed stops all at seq
  // <= 0. The candidate was rejected for want of a comparable time even though
  // it was the right train.
  //
  // Extrapolation is deliberately linear over the nearest known pair's rate
  // per PATTERN POSITION (not per seq — seq isn't a total order). These tail
  // rows are consecutive junctions passed within a few minutes, so a modest
  // error is fine: the result is only ever compared against a +/-90min
  // plausibility window, never shown to a user.
  const timedIdxs = resolved.map((iso, i) => (iso ? i : -1)).filter((i) => i !== -1);
  if (timedIdxs.length < 2) return null;

  const [i0, i1] =
    beforeIdx !== -1
      ? [timedIdxs[timedIdxs.length - 2]!, timedIdxs[timedIdxs.length - 1]!] // trailing tail
      : [timedIdxs[0]!, timedIdxs[1]!]; // leading tail

  const t0 = Date.parse(resolved[i0]!);
  const t1 = Date.parse(resolved[i1]!);
  const perStop = (t1 - t0) / (i1 - i0);
  // Reject a degenerate pattern (zero/negative rate, or a pair so close
  // together that extrapolating over a long tail explodes) rather than
  // inventing a time hours from reality. 30 min/stop is already far beyond any
  // real junction-to-junction gap.
  if (!Number.isFinite(perStop) || perStop <= 0 || perStop > 30 * 60_000) return null;
  return new Date(t1 + perStop * (targetIdx - i1)).toISOString();
}

/**
 * Confidence that a candidate explains a report from `tiploc`/`crs` at `at`.
 *
 * `pattern` is the candidate's full calling pattern in travel order.
 * `deactivated` short-circuits to no-confidence: a deactivated run explains
 * nothing, and the query this replaced enforced that with a join.
 */
export function scoreAtLocation(
  pattern: PatternRow[],
  deactivated: boolean,
  tiploc: string | null,
  crs: string | null,
  at: Date,
  bookedAt?: Date | null,
): number {
  if (deactivated) return SCORE_NONE;
  if (!tiploc && !crs) return SCORE_NONE;

  const here = pattern.filter((p) => atLocation(p, tiploc, crs));

  let anyBlank = false;
  let best = SCORE_NONE;
  for (const r of here) {
    let matched = false;
    for (const hhmm of [r.schedArr, r.schedDep, r.schedPass]) {
      const iso = hhmmToIso(hhmm, at);
      if (!iso) continue;
      matched = true;
      const bookedMs = Date.parse(iso);

      // STRONGEST evidence: this candidate's booked time at this location
      // matches TRUST's OWN booked time for the report. Booked-vs-booked needs
      // no delay slack, so it separates candidates that the actual-time window
      // below cannot. Measured over 1,686 live movements, |actual - planned| is
      // p50 1min / p90 11.5min / p99 38min — which is exactly why comparing
      // actuals needs +/-90min and can't discriminate.
      if (bookedAt && Math.abs(bookedMs - bookedAt.getTime()) <= BOOKED_TOLERANCE_MS) {
        return SCORE_BOOKED_MATCH;
      }
      if (Math.abs(bookedMs - at.getTime()) <= TD_TOLERANCE_MS) {
        best = Math.max(best, SCORE_ACTUAL_IN_WINDOW);
      }
    }
    if (!matched) anyBlank = true;
  }
  if (best > SCORE_NONE) return best;
  if (!anyBlank) return SCORE_NONE;

  // At least one matching row has no sched_arr/sched_dep/sched_pass at all —
  // measured live, 47% of darwin_stop_forecast rows are like this (minor
  // timing points, e.g. Castle Cary on a Paddington-Penzance working, that
  // CORPUS gives a CRS to but Darwin's Push Port never carries a WTT time
  // for). Without a fallback, a headcode whose ONLY current-location match is
  // one of these rows can never be found plausible, however obviously right
  // it is — confirmed live: 1,553 unresolved TD trains had exactly one
  // same-day candidate, and it was consistently one of these no-time rows
  // that rejected them. Interpolate an instant from the candidate's own
  // neighbouring TIMED stops instead of giving up: 61,466 of 61,498 rids with
  // any blank-timing row have plenty of others to interpolate between.
  const iso = interpolateTimeFromPattern(pattern, tiploc, crs, at);
  if (!iso) return SCORE_NONE;
  const ms = Date.parse(iso);
  if (bookedAt && Math.abs(ms - bookedAt.getTime()) <= BOOKED_TOLERANCE_MS) {
    // Interpolated, but it lines up with TRUST's booked time — better than a
    // loose actual-time hit, yet still weaker than a real booked row, since
    // the time itself was inferred rather than published.
    return SCORE_INTERPOLATED_BOOKED;
  }
  return Math.abs(ms - at.getTime()) <= TD_TOLERANCE_MS ? SCORE_INTERPOLATED : SCORE_NONE;
}
