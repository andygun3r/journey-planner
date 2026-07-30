import { isCrs } from "@mainline/shared";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import mysql from "mysql2/promise";
import postgres from "postgres";
import type { PostprocessResult } from "./postprocess-gtfs.js";

const BATCH = 2000;

/**
 * Rough GB bounding box, generously drawn (Scilly/Shetland to the Channel and
 * the East Anglian coast). Anything outside is a source defect rather than a
 * station we can plot.
 */
const GB_BOUNDS = { minLat: 49.8, maxLat: 61.0, minLon: -8.7, maxLon: 2.1 };

function inGb(lat: number, lon: number): boolean {
  return (
    lat >= GB_BOUNDS.minLat &&
    lat <= GB_BOUNDS.maxLat &&
    lon >= GB_BOUNDS.minLon &&
    lon <= GB_BOUNDS.maxLon
  );
}

/**
 * Hand-verified coordinates for stations whose source values are wrong but
 * still land inside GB, so no automatic rule can catch them.
 *
 * Bond Street arrives as lon +0.15 rather than -0.15. Both are plausible GB
 * longitudes and both sit ~20-35m from a railway (the stored one lands on a
 * line in Essex), so neither a bounds check nor a nearest-track test can tell
 * them apart. Its Elizabeth line neighbours are spread across London, so a
 * timetable-neighbour consistency check doesn't flag it either — it was
 * confirmed by hand against the real station position instead.
 *
 * Keep this list minimal: it's a standing claim that the source is wrong and
 * we are right, and it silently overrides upstream fixes. Each entry should be
 * verifiable from the station's actual location, not merely plausible.
 */
const COORD_OVERRIDES: Record<string, { lat: number; lon: number }> = {
  // Bond Street (Elizabeth line) — Hanover Square entrance.
  BDS: { lat: 51.514, lon: -0.15 },
};

/**
 * Validate a station's .MSN-derived coordinate, repairing the two defects the
 * source is known to emit and discarding anything else implausible.
 *
 * Measured on the live feed: Tottenham Court Road arrived with lat/lon
 * transposed (lat -0.1306, lon 51.5163 — the Southern Ocean), and Bond Street
 * with a flipped longitude sign (lon 0.15 rather than -0.15, putting it in the
 * North Sea). Both are busy Elizabeth line stations, together ~1,900 calling
 * -point legs a day, so the bad rows propagated into route lines, snapping and
 * corridor solving. Repairing them here — at the single point coordinates enter
 * Postgres — fixes every downstream consumer at once and survives the next ETL
 * run, which hand-editing the table would not.
 *
 * A repair is only accepted if it lands inside GB, so this can't invent a
 * plausible-looking position for a genuinely unknown location. Coordinates that
 * stay out of bounds are nulled: the CIE (Irish) and Q-prefixed pseudo-stations
 * in the source share placeholder points and aren't GB stations at all, and
 * callers already handle a null coordinate by not plotting the station.
 */
function sanitiseCoords(
  crs: string,
  lat: number | null | undefined,
  lon: number | null | undefined,
): { lat: number | null; lon: number | null; repair?: string } {
  if (lat == null || lon == null) return { lat: null, lon: null };

  const override = COORD_OVERRIDES[crs];
  if (override && (!inGb(lat, lon) || Math.abs(lon - override.lon) > 0.05)) {
    return { ...override, repair: `${crs} override` };
  }

  if (inGb(lat, lon)) return { lat, lon };
  // Transposed lat/lon.
  if (inGb(lon, lat)) return { lat: lon, lon: lat, repair: `${crs} transposed` };
  // Flipped longitude sign (a GB station's longitude is almost always negative).
  if (inGb(lat, -lon)) return { lat, lon: -lon, repair: `${crs} lon sign` };
  return { lat: null, lon: null, repair: `${crs} out of bounds, dropped` };
}

/**
 * Darwin's real-time TS/SC messages reference TIPLOCs beyond each station's
 * primary one from GTFS stops.txt — large stations have extra platform-area
 * or subsidiary TIPLOCs (e.g. Waterloo's WATRLOO is primary, but live
 * messages also use WATRLMN) that share the same STANOX but carry no CRS of
 * their own in the .MSN-derived `tiploc` table dtd2mysql loads into the
 * MariaDB scratch DB. Without these aliases, any train whose first-seen stop
 * uses a subsidiary TIPLOC can never be matched to its origin station, so
 * live position tracking silently fails for it. Join on STANOX to pull in
 * every subsidiary TIPLOC per CRS, best-effort — if the scratch table is
 * unavailable for any reason, station rows just fall back to the primary
 * tiploc only (same as before this existed), not a hard failure.
 */
export async function loadTiplocAliases(): Promise<Map<string, string[]>> {
  const aliasesByCrs = new Map<string, string[]>();
  const mysqlUrl = process.env.ETL_MYSQL_URL ?? "mysql://root:etl@mariadb:3306/dtd";
  let conn: mysql.Connection | undefined;
  try {
    conn = await mysql.createConnection(mysqlUrl);
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT t1.tiploc_code AS alias, t2.crs_code AS crs
       FROM tiploc t1
       JOIN tiploc t2 ON t1.stanox = t2.stanox AND t2.crs_code IS NOT NULL
       WHERE t1.stanox <> '00000'`,
    );
    for (const r of rows) {
      const crs = r.crs as string | null;
      const alias = r.alias as string | null;
      if (!crs || !alias || !isCrs(crs)) continue;
      const list = aliasesByCrs.get(crs) ?? [];
      if (!list.includes(alias)) list.push(alias);
      aliasesByCrs.set(crs, list);
    }
    console.log(`postgres: loaded ${rows.length} tiploc aliases for ${aliasesByCrs.size} stations`);
  } catch (err) {
    console.warn(`postgres: tiploc alias lookup skipped (${(err as Error).message})`);
  } finally {
    await conn?.end();
  }
  return aliasesByCrs;
}

export async function loadIntoPostgres(
  result: PostprocessResult,
  feedVersion: string,
  sourceModifiedAt?: Date,
): Promise<void> {
  // stops.txt carries the odd junk row with a fake CRS (e.g. "3/0") from
  // tiploc-only locations — real stations always have a 3-letter CRS.
  const stations = result.stations.filter((s) => isCrs(s.crs));
  const dropped = result.stations.length - stations.length;
  if (dropped > 0) console.warn(`postgres: dropped ${dropped} rows with invalid CRS`);
  result = { ...result, stations };

  const aliasesByCrs = await loadTiplocAliases();

  const repairs: string[] = [];

  // Raw postgres.js rather than Drizzle for this one function, because the trip
  // mappings are loaded with COPY and Drizzle has no way to expose the copy
  // stream. Everything still happens in ONE transaction, which is what keeps
  // readers on a consistent snapshot for the whole load.
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`delete from station`;
      for (let i = 0; i < result.stations.length; i += BATCH) {
        const rows = result.stations.slice(i, i + BATCH).map((s) => {
          const tiplocs = new Set(s.tiploc ? [s.tiploc] : []);
          for (const alias of aliasesByCrs.get(s.crs) ?? []) tiplocs.add(alias);
          const coords = sanitiseCoords(s.crs, s.lat, s.lon);
          if (coords.repair) repairs.push(coords.repair);
          return {
            crs: s.crs,
            name: s.name,
            tiplocs: [...tiplocs],
            lat: coords.lat,
            lon: coords.lon,
            interchange_min: s.interchangeMin,
          };
        });
        // A few thousand rows total, so plain inserts are fine here — and
        // `tiplocs` is a text[], whose COPY encoding is easy to get silently
        // wrong for no gain.
        await tx`insert into station ${tx(rows, "crs", "name", "tiplocs", "lat", "lon", "interchange_min")}`;
      }

      await tx`delete from trip_mapping`;
      // Stream the CSV straight in. This used to be ~500 round trips of
      // 2,000-row parameterised inserts, built from an array of a million
      // objects that no longer exists.
      const copy = await tx`
        copy trip_mapping (gtfs_trip_id, train_uid, date_runs_from, date_runs_to, days_mask, stp_indicator)
        from stdin with (format csv, header true)
      `.writable();
      await pipeline(createReadStream(result.tripMappingCsv), copy);

      await tx`
        insert into etl_run (feed, version, source_modified_at, ok, detail)
        values ('timetable', ${feedVersion}, ${sourceModifiedAt ?? null}, true,
                ${`${result.stations.length} stations, ${result.tripMappingCount} trip mappings`})
      `;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (repairs.length > 0) {
    console.warn(`postgres: repaired/dropped ${repairs.length} station coordinates`);
    for (const r of repairs) console.warn(`  - ${r}`);
  }

  console.log(
    `postgres: loaded ${result.stations.length} stations + ${result.tripMappingCount} trip mappings (${feedVersion})`,
  );
}
