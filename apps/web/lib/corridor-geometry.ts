import { railCorridor } from "@signaller/db";
import { inArray, sql } from "drizzle-orm";
import { getDb } from "./db";

/**
 * Track-following geometry for station-to-station legs, read from the
 * precomputed rail_corridor table (built by services/etl/src/rail-corridors.ts).
 *
 * This is the fallback the journey planner uses when MOTIS gives a leg no
 * shape of its own. Without it a rail leg would have to be drawn as a straight
 * line between two stations, which cuts across country and reads as wrong on
 * a map — better to draw nothing than to draw a lie, so callers get null and
 * omit the leg.
 *
 * apps/web/lib/live-trains.ts has its own bulk version of this query
 * (corridorsForPaths) because it also needs along-track interpolation for
 * moving trains. This one is the simple "just give me the line" case.
 */

/** rail_corridor.geometry is a flat [lon0, lat0, lon1, lat1, …] real[]. */
function toPairs(flat: number[]): [number, number][] {
  const coords: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) coords.push([flat[i]!, flat[i + 1]!]);
  return coords;
}

/**
 * Corridors for many station pairs in one query. Keyed `"FROM|TO"`; pairs with
 * no precomputed corridor are simply absent from the map.
 *
 * Corridors are directional, so ask for the direction you want to draw.
 */
export async function corridorGeometries(
  pairs: [string, string][],
): Promise<Map<string, [number, number][]>> {
  const out = new Map<string, [number, number][]>();
  const wanted = new Map<string, [string, string]>();
  for (const [from, to] of pairs) {
    if (from && to && from !== to) wanted.set(`${from}|${to}`, [from, to]);
  }
  if (wanted.size === 0) return out;

  const rows = await getDb()
    .select({
      fromCrs: railCorridor.fromCrs,
      toCrs: railCorridor.toCrs,
      geometry: railCorridor.geometry,
    })
    .from(railCorridor)
    .where(
      inArray(
        sql`(${railCorridor.fromCrs}, ${railCorridor.toCrs})`,
        [...wanted.values()].map((p) => sql`(${p[0]}, ${p[1]})`),
      ),
    );

  for (const r of rows) {
    const coords = toPairs(r.geometry);
    if (coords.length >= 2) out.set(`${r.fromCrs}|${r.toCrs}`, coords);
  }
  return out;
}

/** Single-pair convenience wrapper. Null when no corridor is precomputed. */
export async function corridorGeometry(
  fromCrs: string,
  toCrs: string,
): Promise<[number, number][] | null> {
  const found = await corridorGeometries([[fromCrs, toCrs]]);
  return found.get(`${fromCrs}|${toCrs}`) ?? null;
}
