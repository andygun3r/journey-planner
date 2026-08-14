/**
 * Turning Track Model centrelines into "how many running lines are there here".
 *
 * The signalling blueprint used to draw a fixed four running lines from
 * Waterloo to Weymouth. The real South West Main Line is four-track only as far
 * as Worting Junction and two-track beyond, so most of that diagram was
 * decoration. Network Rail's Track Model already knows the true shape; this
 * reads it out.
 *
 * The derivation lives here rather than in services/etl because both sides need
 * it: `etl track-sections` writes the result to Postgres, and the renderer
 * reads the same shape back. It is deliberately pure — no database, no file
 * access — so it can be tested against known railway geography.
 *
 * Mileage note: Track Model records miles-and-chains, so 53.15 means 53 miles
 * 15 chains, not 53.15 miles. Values are kept exactly as the source gives them
 * and only ever compared against each other. Use `milesAndChainsToMiles` before
 * doing arithmetic that assumes decimal miles.
 */

/**
 * A track counts as a through line if it covers at least this fraction of its
 * ELR's total extent.
 *
 * Measured on MLN1 (Waterloo–Weymouth, 246 miles) the split is not marginal:
 * the two main lines cover 98.8% of the route each, the slow pair 23–25%, and
 * the next largest thing is 3.1% — a loop. Anything genuinely carrying traffic
 * along the corridor sits far above this line; every siding, refuge and
 * crossover sits far below it.
 */
const THROUGH_LINE_MIN_FRACTION = 0.05;

/** …and at least this far in absolute terms, so a short ELR can't promote a siding. */
const THROUGH_LINE_MIN_MILES = 1;

/** Ignore slivers this short when cutting sections — survey noise, not layout. */
const MIN_SECTION_MILES = 0.5;

/**
 * Bridge gaps up to this long between two otherwise identical sections.
 *
 * Centreline records break at every junction and crossing, so a continuous
 * four-track railway arrives as many abutting records with hairline gaps
 * between them. Without this the sweep emits hundreds of one-chain sections
 * that all say the same thing.
 */
const MERGE_GAP_MILES = 0.6;

export interface TrackSpan {
  trackId: string;
  start: number;
  end: number;
}

export interface TrackSection {
  elr: string;
  startMileage: number;
  endMileage: number;
  trackIds: string[];
}

/** Miles-and-chains (53.15 = 53m 15ch) to decimal miles. 80 chains to the mile. */
export function milesAndChainsToMiles(value: number): number {
  const miles = Math.trunc(value);
  const chains = Math.round((value - miles) * 100);
  return miles + chains / 80;
}

export function deriveSections(elr: string, spans: TrackSpan[]): TrackSection[] {
  const usable = spans.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
  if (usable.length === 0) return [];

  const normalised = usable.map((s) => ({
    trackId: s.trackId,
    start: Math.min(s.start, s.end),
    end: Math.max(s.start, s.end),
  }));

  const routeStart = Math.min(...normalised.map((s) => s.start));
  const routeEnd = Math.max(...normalised.map((s) => s.end));
  const extent = routeEnd - routeStart;
  if (extent <= 0) return [];

  const coverage = new Map<string, number>();
  for (const s of normalised) {
    coverage.set(s.trackId, (coverage.get(s.trackId) ?? 0) + (s.end - s.start));
  }
  const threshold = Math.max(extent * THROUGH_LINE_MIN_FRACTION, THROUGH_LINE_MIN_MILES);
  const throughLines = new Set(
    [...coverage.entries()].filter(([, miles]) => miles >= threshold).map(([id]) => id),
  );
  if (throughLines.size === 0) return [];

  const running = normalised.filter((s) => throughLines.has(s.trackId));

  // Cut at every span boundary, then ask which lines are live in each slice.
  const cuts = [...new Set(running.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const slices: TrackSection[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const lo = cuts[i]!;
    const hi = cuts[i + 1]!;
    if (hi - lo < 0.05) continue;
    const mid = (lo + hi) / 2;
    const live = [
      ...new Set(running.filter((s) => s.start <= mid && mid <= s.end).map((s) => s.trackId)),
    ].sort();
    if (live.length === 0) continue;
    slices.push({ elr, startMileage: lo, endMileage: hi, trackIds: live });
  }

  const merged: TrackSection[] = [];
  for (const slice of slices) {
    const prev = merged[merged.length - 1];
    const sameLines =
      prev &&
      prev.trackIds.length === slice.trackIds.length &&
      prev.trackIds.every((id, i) => id === slice.trackIds[i]);
    if (prev && sameLines && slice.startMileage - prev.endMileage <= MERGE_GAP_MILES) {
      prev.endMileage = slice.endMileage;
    } else {
      merged.push({ ...slice });
    }
  }

  return merged.filter((s) => s.endMileage - s.startMileage >= MIN_SECTION_MILES);
}

/** The section covering a mileage, or the nearest one if it falls in a gap. */
export function sectionAt(sections: TrackSection[], mileage: number): TrackSection | undefined {
  const hit = sections.find((s) => mileage >= s.startMileage && mileage <= s.endMileage);
  if (hit) return hit;
  let nearest: TrackSection | undefined;
  let bestGap = Infinity;
  for (const s of sections) {
    const gap =
      mileage < s.startMileage ? s.startMileage - mileage : mileage - s.endMileage;
    if (gap < bestGap) {
      bestGap = gap;
      nearest = s;
    }
  }
  return nearest;
}
