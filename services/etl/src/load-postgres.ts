import { createDb, etlRun, station, tripMapping } from "@mainline/db";
import { isCrs } from "@mainline/shared";
import mysql from "mysql2/promise";
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
async function loadTiplocAliases(): Promise<Map<string, string[]>> {
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
  const db = createDb();
  // stops.txt carries the odd junk row with a fake CRS (e.g. "3/0") from
  // tiploc-only locations — real stations always have a 3-letter CRS.
  const stations = result.stations.filter((s) => isCrs(s.crs));
  const dropped = result.stations.length - stations.length;
  if (dropped > 0) console.warn(`postgres: dropped ${dropped} rows with invalid CRS`);
  result = { ...result, stations };

  const aliasesByCrs = await loadTiplocAliases();

  const repairs: string[] = [];

  await db.transaction(async (tx) => {
    await tx.delete(station);
    for (let i = 0; i < result.stations.length; i += BATCH) {
      await tx.insert(station).values(
        result.stations.slice(i, i + BATCH).map((s) => {
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
            interchangeMin: s.interchangeMin,
          };
        }),
      );
    }

    await tx.delete(tripMapping);
    for (let i = 0; i < result.tripMappings.length; i += BATCH) {
      await tx.insert(tripMapping).values(
        result.tripMappings.slice(i, i + BATCH).map((t) => ({
          gtfsTripId: t.gtfsTripId,
          trainUid: t.trainUid,
          dateRunsFrom: t.dateRunsFrom,
          dateRunsTo: t.dateRunsTo,
          daysMask: t.daysMask,
          stpIndicator: t.stpIndicator,
        })),
      );
    }

    await tx.insert(etlRun).values({
      feed: "timetable",
      version: feedVersion,
      sourceModifiedAt,
      ok: true,
      detail: `${result.stations.length} stations, ${result.tripMappings.length} trip mappings`,
    });
  });

  if (repairs.length > 0) {
    console.warn(`postgres: repaired/dropped ${repairs.length} station coordinates`);
    for (const r of repairs) console.warn(`  - ${r}`);
  }

  console.log(
    `postgres: loaded ${result.stations.length} stations + ${result.tripMappings.length} trip mappings (${feedVersion})`,
  );
}
