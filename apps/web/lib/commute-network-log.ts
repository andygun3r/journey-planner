import type { CommuteLegRecord } from "@signaller/shared";
import type { CommuteWithLegs } from "./commutes";
import { getBoard, normaliseOperatorName } from "./board";
import { fetchServiceIndicators, type ServiceIndicator } from "./disruptions";

/**
 * Every CRS a commute's legs could depart from or arrive at, across both
 * directions and every configured backup — the full set of stations whose
 * calling operators count as "on my commute." Per-direction origin/dest
 * overrides fall back to home/work exactly as resolveActiveLegForCommute
 * does, so this reflects the same routes the dashboard would actually plan.
 */
function stationsForLeg(leg: CommuteLegRecord, homeCrs: string | null): string[] {
  const crs = [
    leg.amOriginCrs ?? homeCrs,
    leg.amDestCrs ?? leg.workCrs,
    leg.pmOriginCrs ?? leg.workCrs,
    leg.pmDestCrs ?? homeCrs,
    leg.backupHomeCrs,
    leg.backupWorkCrs,
  ];
  return crs.filter((c): c is string => Boolean(c));
}

function stationsForCommutes(commutes: CommuteWithLegs[]): string[] {
  const set = new Set<string>();
  for (const c of commutes) {
    for (const leg of c.legs) {
      for (const crs of stationsForLeg(leg, c.homeCrs)) set.add(crs);
    }
  }
  return [...set];
}

/**
 * The set of operator names actually running services from/to the user's
 * commute stations, found by checking each station's live board — the same
 * departure-board data the rest of the app already trusts, not a geographic
 * guess. One board fetch per distinct station (board-cache.ts dedupes and
 * caches these, so repeat dashboard loads and boards already open elsewhere
 * don't multiply the cost), all best-effort: a station whose board can't be
 * reached just contributes nothing rather than failing the whole lookup.
 */
async function operatorsForStations(crsList: string[]): Promise<Set<string>> {
  const names = new Set<string>();
  await Promise.all(
    crsList.map(async (crs) => {
      try {
        const outcome = await getBoard(crs);
        if (!outcome.ok) return;
        for (const d of [...outcome.board.departures, ...outcome.board.arrivals]) {
          if (d.operator) names.add(normaliseOperatorName(d.operator));
        }
      } catch {
        /* best-effort — a station this fails for just contributes nothing */
      }
    }),
  );
  return names;
}

/**
 * Service indicator rows — one per operator — filtered down to only the
 * operators that actually serve the user's configured commutes, disrupted
 * operators first. Always computed from every commute the user has (not
 * just today's active leg) — this panel is meant to answer "is my commute's
 * operator running normally" even on a day with nothing scheduled, a
 * holiday, or after the last train.
 *
 * Falls back to the unfiltered full-network list when the user has no
 * commutes yet, or when nothing on the board could be matched to an
 * indicator (e.g. RTPPM naming drift) — showing everything is more useful
 * than showing an empty log for someone still setting up.
 */
export async function serviceIndicatorsForCommutes(
  commutes: CommuteWithLegs[],
): Promise<ServiceIndicator[]> {
  const all = await fetchServiceIndicators();
  const sorted = [...all].sort((a, b) => Number(a.good) - Number(b.good));
  if (commutes.length === 0) return sorted;

  const stations = stationsForCommutes(commutes);
  if (stations.length === 0) return sorted;

  const relevantOperators = await operatorsForStations(stations);
  if (relevantOperators.size === 0) return sorted;

  const filtered = sorted.filter((ind) => relevantOperators.has(normaliseOperatorName(ind.tocName)));
  return filtered.length > 0 ? filtered : sorted;
}
