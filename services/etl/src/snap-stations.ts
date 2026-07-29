import { station } from "@mainline/db";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Snap every station's coordinate onto the nearest OpenRailwayMap running
 * line, into station.track_lat/track_lon.
 *
 * Why: the .MSN-derived lat/lon is the station entrance/centroid, not the
 * track. Measured across all 3109 GB stations with coordinates, the median
 * offset from the nearest running line is ~12m and the 95th percentile is
 * several hundred metres — enough that a train plotted at its station
 * visibly sits beside the rails rather than on them.
 *
 * This is a precompute, not a request-path dependency: orm-db exposes no host
 * port and the geometry only changes when the OSM extract is re-imported, so
 * results are materialised into the main Postgres and the web app reads them
 * with no knowledge of PostGIS. Re-run after each `orm-import`.
 *
 * Deliberately NOT attempted here: interpolating a train's position *along*
 * the track between two stations. orm-db has no pgrouting, and GB corridors
 * carry many parallel running lines, sidings and depot spurs — sampling a
 * station-to-station chord and snapping each sample jumps between different
 * lines (measured on King's Cross->Finsbury Park: snap distances swinging
 * 13-452m and wildly uneven steps). That would render fabricated motion as
 * though it were measured. Between-station position stays an explicit
 * straight-line approximation, as the map legend already states.
 */

/**
 * Metres (true ground distance) beyond which a match is treated as bogus
 * rather than a real platform offset. Some `station` rows carry bad source
 * coordinates — TCR has lat/lon transposed, and a cluster of stations sit at
 * a placeholder point in the South Atlantic — which would otherwise "snap" to
 * whatever track happens to be least far away. Bus-only interchanges (no
 * track exists nearby at all) and newer/rebuilt stations whose platform track
 * isn't surveyed yet in the OSM extract (Thanet Parkway, Heathrow T5, Bond
 * Street Elizabeth line, Armadale, etc., measured 130-290m out) also land out
 * here. Those keep a null track_*, and callers fall back to the original
 * lat/lon rather than showing a train snapped onto the wrong line.
 */
const MAX_SNAP_METERS = 150;

interface Snapped {
  crs: string;
  lat: number;
  lon: number;
}

async function snapAll(stations: { crs: string; lat: number; lon: number }[]): Promise<Snapped[]> {
  const url = process.env.ORM_DATABASE_URL ?? "postgresql://postgres@orm-db:5432/gis";
  const sqlClient = postgres(url);
  try {
    // One statement for all ~3k stations: unnest the input and use a LATERAL
    // nearest-neighbour (`<->`, index-assisted) per row. Looping per station
    // would mean 3k round trips.
    //
    // railway_line is EPSG:3857, whose metres are inflated by 1/cos(latitude);
    // multiplying by cos(lat) converts back to true ground metres so
    // MAX_SNAP_METERS means what it says at GB latitudes.
    const rows = await sqlClient<{ crs: string; lat: number; lon: number }[]>`
      with input as (
        select * from unnest(
          ${stations.map((s) => s.crs)}::text[],
          ${stations.map((s) => s.lat)}::float8[],
          ${stations.map((s) => s.lon)}::float8[]
        ) as t(crs, lat, lon)
      )
      select i.crs,
             ST_Y(ST_Transform(ST_ClosestPoint(n.way, p.g), 4326)) as lat,
             ST_X(ST_Transform(ST_ClosestPoint(n.way, p.g), 4326)) as lon
      from input i
      cross join lateral (
        select ST_Transform(ST_SetSRID(ST_MakePoint(i.lon, i.lat), 4326), 3857) as g
      ) p
      cross join lateral (
        select l.way
        from railway_line l
        where l.feature in ('rail', 'light_rail', 'subway')
          and (l.usage in ('main', 'branch') or l.usage is null)
          -- Without state='present' a station can snap onto an abandoned or
          -- razed trackbed running closer than the live line — GB's extract
          -- has ~22k such ways inside the filter above.
          and l.state = 'present'
        order by l.way <-> p.g
        limit 1
      ) n
      where ST_Distance(p.g, n.way) * cos(radians(i.lat)) <= ${MAX_SNAP_METERS}
    `;
    return rows.map((r) => ({ crs: r.crs, lat: Number(r.lat), lon: Number(r.lon) }));
  } finally {
    await sqlClient.end();
  }
}

export async function snapStations(): Promise<void> {
  // createDb() has no idle_timeout on its pool, so — unlike a long-running
  // server — this one-shot CLI command would hang after finishing rather
  // than let the process exit. (Observed directly: `docker compose run` sat
  // "Up" indefinitely after logging its last success line.) Own the
  // connection here instead, so it can be closed explicitly once done.
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const mainClient = postgres(url);
  const db = drizzle(mainClient);
  try {
    const rows = await db
      .select({ crs: station.crs, lat: station.lat, lon: station.lon })
      .from(station);

    const withCoords = rows.filter(
      (r): r is { crs: string; lat: number; lon: number } => r.lat != null && r.lon != null,
    );
    console.log(`[snap-stations] ${withCoords.length} stations with coordinates`);

    const snapped = await snapAll(withCoords);
    console.log(
      `[snap-stations] snapped ${snapped.length}; ` +
        `${withCoords.length - snapped.length} had no track within ${MAX_SNAP_METERS}m`,
    );

    if (snapped.length === 0) return;

    // Single UPDATE ... FROM over a VALUES list, rather than a statement per
    // station.
    const values = sql.join(
      snapped.map((s) => sql`(${s.crs}, ${s.lat}::real, ${s.lon}::real)`),
      sql`, `,
    );
    await db.execute(sql`
      update ${station} set track_lat = v.lat, track_lon = v.lon
      from (values ${values}) as v(crs, lat, lon)
      where ${station.crs} = v.crs
    `);

    console.log(`[snap-stations] updated ${snapped.length} rows`);
  } finally {
    await mainClient.end();
  }
}
