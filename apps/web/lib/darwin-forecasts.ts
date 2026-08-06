import { darwinStopForecast, darwinTrain } from "@signaller/db";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { londonDateKey } from "./uk-time";

/**
 * The one query that reads "every live forecast at this station".
 *
 * Three separate places used to run it: the formation enricher, the position
 * enricher, and the Darwin board fallback. Two were byte-identical and the third
 * differed only by selecting more columns, so a single board request scanned the
 * same rows two or three times. At a busy interchange that is thousands of rows
 * per scan.
 *
 * They could not simply be run in parallel — the position enricher reads a rid
 * the formation enricher sets — but they never needed separate queries in the
 * first place.
 */

export interface StationForecast {
  rid: string;
  schedDep: string | null;
  estDep: string | null;
  actDep: string | null;
  platform: string | null;
  platformChanged: boolean;
  suppressed: boolean;
  cancelled: boolean;
}

/**
 * Which service days a train at this station could belong to.
 *
 * Yesterday as well as today, because an overnight working still runs under
 * yesterday's service date after midnight. Was defined identically in four
 * different files.
 */
export function candidateServiceDays(now: Date): string[] {
  return [londonDateKey(new Date(now.getTime() - 86_400_000)), londonDateKey(now)];
}

/**
 * Short enough that a board still looks live, long enough to collapse the
 * repeat reads within one request — and, once there is more than one viewer,
 * across everyone looking at the same station. The board response itself is
 * already cached for 15 seconds.
 */
const TTL_MS = 5_000;

const cache = new Map<string, { at: number; rows: StationForecast[] }>();

/** Live forecasts at `crs` for the current or previous service day. */
export async function stationForecasts(crs: string): Promise<StationForecast[]> {
  const hit = cache.get(crs);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  let rows: StationForecast[];
  try {
    rows = await getDb()
      .select({
        rid: darwinStopForecast.rid,
        schedDep: darwinStopForecast.schedDep,
        estDep: darwinStopForecast.estDep,
        actDep: darwinStopForecast.actDep,
        platform: darwinStopForecast.platform,
        platformChanged: darwinStopForecast.platformChanged,
        suppressed: darwinStopForecast.suppressed,
        cancelled: darwinTrain.cancelled,
      })
      .from(darwinStopForecast)
      .innerJoin(darwinTrain, eq(darwinTrain.rid, darwinStopForecast.rid))
      // Bounded to the current/previous service day. Without this, a scheduled
      // minute matches every train that has ever departed at that minute from
      // this station, and the row picks up an arbitrary one.
      .where(
        and(
          eq(darwinStopForecast.crs, crs),
          inArray(darwinTrain.ssd, candidateServiceDays(new Date())),
          eq(darwinTrain.deactivated, false),
        ),
      );
  } catch {
    // Table or database not ready. Callers all treat this as "no live data" and
    // pass their rows through unchanged, so don't cache it — the next request
    // should try again rather than wait out the TTL.
    return [];
  }

  // Bounded by the number of stations anyone actually looks at, and each entry
  // expires, but clear it if a crawler ever walks every CRS.
  if (cache.size > 500) cache.clear();
  cache.set(crs, { at: Date.now(), rows });
  return rows;
}
