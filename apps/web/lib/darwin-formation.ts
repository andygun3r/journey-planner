import { darwinFormation } from "@mainline/db";
import { eq, inArray } from "drizzle-orm";
import { stationForecasts } from "./darwin-forecasts";
import type { BoardDeparture, Coach } from "./board";
import { getDb } from "./db";
import { londonDateKey, ukHhmm } from "./uk-time";

/**
 * Fills coach formation on board rows from the Darwin feed (darwin_formation),
 * for the operators/services where LDBWS returned no coaches. Matching:
 *   board row (crs, scheduled HH:MM) -> darwin_stop_forecast.rid -> formation.
 * Runs one bulk query per board; a no-op when the ingester hasn't populated
 * anything (rows pass through unchanged).
 */

interface StoredCoach {
  number: string;
  coachClass?: string;
  first: boolean;
  loading?: number;
}

const hhmm = (iso: string) => ukHhmm(iso);

export async function enrichBoardWithFormation(
  crs: string,
  departures: BoardDeparture[],
): Promise<BoardDeparture[]> {
  // Only bother for rows still missing coach detail.
  const needy = departures.filter((d) => !d.coachCount);
  if (needy.length === 0) return departures;

  const db = getDb();

  // 1. rid by scheduled departure minute at this station, bounded to the
  //    current/previous service day.
  const forecasts = await stationForecasts(crs);
  if (forecasts.length === 0) return departures;

  // Two trains sharing a scheduled minute can't be told apart by it, so an
  // ambiguous minute resolves to nothing rather than to whichever row was
  // written last — that produced another train's coach count on this row.
  const ridsByMinute = new Map<string, Set<string>>();
  for (const f of forecasts) {
    if (!f.schedDep) continue;
    const key = f.schedDep.slice(0, 5);
    const set = ridsByMinute.get(key) ?? new Set<string>();
    set.add(f.rid);
    ridsByMinute.set(key, set);
  }
  const ridForMinute = (minute: string | undefined): string | undefined => {
    if (!minute) return undefined;
    const set = ridsByMinute.get(minute);
    return set && set.size === 1 ? [...set][0] : undefined;
  };

  // 2. formation for the rids we can match.
  const rids = [...new Set(needy.map((d) => ridForMinute(hhmm(d.scheduled))).filter(Boolean))] as string[];
  if (rids.length === 0) return departures;

  const rows = await db
    .select({ rid: darwinFormation.rid, coaches: darwinFormation.coaches })
    .from(darwinFormation)
    .where(inArray(darwinFormation.rid, rids));
  const formationByRid = new Map(rows.map((r) => [r.rid, r.coaches as StoredCoach[]]));

  // 3. attach.
  return departures.map((d) => {
    if (d.coachCount) return d;
    const rid = ridForMinute(hhmm(d.scheduled));
    const stored = rid ? formationByRid.get(rid) : undefined;
    if (!stored || stored.length === 0) return d;
    const coaches: Coach[] = stored.map((c) => ({
      number: c.number,
      first: c.first,
      coachClass: c.coachClass,
      loading: c.loading,
    }));
    return { ...d, rid, coachCount: coaches.length, coaches };
  });
}
