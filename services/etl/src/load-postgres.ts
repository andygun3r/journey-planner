import { createDb, etlRun, station, tripMapping } from "@mainline/db";
import { isCrs } from "@mainline/shared";
import mysql from "mysql2/promise";
import type { PostprocessResult } from "./postprocess-gtfs.js";

const BATCH = 2000;

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

export async function loadIntoPostgres(result: PostprocessResult, feedVersion: string): Promise<void> {
  const db = createDb();
  // stops.txt carries the odd junk row with a fake CRS (e.g. "3/0") from
  // tiploc-only locations — real stations always have a 3-letter CRS.
  const stations = result.stations.filter((s) => isCrs(s.crs));
  const dropped = result.stations.length - stations.length;
  if (dropped > 0) console.warn(`postgres: dropped ${dropped} rows with invalid CRS`);
  result = { ...result, stations };

  const aliasesByCrs = await loadTiplocAliases();

  await db.transaction(async (tx) => {
    await tx.delete(station);
    for (let i = 0; i < result.stations.length; i += BATCH) {
      await tx.insert(station).values(
        result.stations.slice(i, i + BATCH).map((s) => {
          const tiplocs = new Set(s.tiploc ? [s.tiploc] : []);
          for (const alias of aliasesByCrs.get(s.crs) ?? []) tiplocs.add(alias);
          return {
            crs: s.crs,
            name: s.name,
            tiplocs: [...tiplocs],
            lat: s.lat,
            lon: s.lon,
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
      ok: true,
      detail: `${result.stations.length} stations, ${result.tripMappings.length} trip mappings`,
    });
  });

  console.log(
    `postgres: loaded ${result.stations.length} stations + ${result.tripMappings.length} trip mappings (${feedVersion})`,
  );
}
