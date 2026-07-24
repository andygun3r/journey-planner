import { createDb, etlRun, station, tripMapping } from "@mainline/db";
import { isCrs } from "@mainline/shared";
import type { PostprocessResult } from "./postprocess-gtfs.js";

const BATCH = 2000;

export async function loadIntoPostgres(result: PostprocessResult, feedVersion: string): Promise<void> {
  const db = createDb();
  // stops.txt carries the odd junk row with a fake CRS (e.g. "3/0") from
  // tiploc-only locations — real stations always have a 3-letter CRS.
  const stations = result.stations.filter((s) => isCrs(s.crs));
  const dropped = result.stations.length - stations.length;
  if (dropped > 0) console.warn(`postgres: dropped ${dropped} rows with invalid CRS`);
  result = { ...result, stations };

  await db.transaction(async (tx) => {
    await tx.delete(station);
    for (let i = 0; i < result.stations.length; i += BATCH) {
      await tx.insert(station).values(
        result.stations.slice(i, i + BATCH).map((s) => ({
          crs: s.crs,
          name: s.name,
          tiplocs: s.tiploc ? [s.tiploc] : [],
          lat: s.lat,
          lon: s.lon,
          interchangeMin: s.interchangeMin,
        })),
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
