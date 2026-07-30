import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadTiplocAliases } from "./load-postgres.js";
import type { PostprocessResult } from "./postprocess-gtfs.js";

const exec = promisify(execFile);

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Bundles a completed timetable pipeline run (GTFS zip + derived station/trip
 * mapping rows) into a single tar.gz for upload to the server's /settings
 * page, so the server never needs to run dtd2mysql itself (that's the memory-
 * heavy step this whole flow exists to avoid running on the low-memory box).
 */
export async function packageBundle(
  result: PostprocessResult,
  feedVersion: string,
  outDir: string,
): Promise<string> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "etl-bundle-"));
  try {
    // Include the subsidiary TIPLOCs, not just the primary one.
    //
    // Darwin's live messages reference TIPLOCs beyond the one GTFS gives each
    // station — Waterloo is WATRLOO in stops.txt but live messages also use
    // WATRLMN. The normal pipeline adds them via loadTiplocAliases(); the bundle
    // carried only the primary, so any train first seen at a subsidiary TIPLOC
    // could never be matched to its origin and live tracking silently failed for
    // it. Pipe-separated so old bundles, which have a single value and no pipes,
    // still load correctly.
    const aliasesByCrs = await loadTiplocAliases();
    const stationsCsv = [
      "crs,name,tiplocs,lat,lon,interchange_min",
      ...result.stations.map((s) => {
        const tiplocs = new Set(s.tiploc ? [s.tiploc] : []);
        for (const alias of aliasesByCrs.get(s.crs) ?? []) tiplocs.add(alias);
        return [
          s.crs,
          csvEscape(s.name),
          csvEscape([...tiplocs].join("|")),
          s.lat,
          s.lon,
          s.interchangeMin,
        ].join(",");
      }),
    ].join("\n");
    await writeFile(path.join(tmp, "stations.csv"), stationsCsv);

    // Copy the CSV postprocess already streamed out, rather than rebuilding it
    // from an in-memory array — there are roughly a million rows and holding
    // them was a large part of what made this pipeline run out of memory.
    await exec("cp", [result.tripMappingCsv, path.join(tmp, "trip_mappings.csv")]);

    await writeFile(
      path.join(tmp, "manifest.json"),
      JSON.stringify(
        {
          feedVersion,
          createdAt: new Date().toISOString(),
          stationCount: result.stations.length,
          tripMappingCount: result.tripMappingCount,
        },
        null,
        2,
      ),
    );

    await exec("cp", [result.gtfsZip, path.join(tmp, "gb-rail.gtfs.zip")]);

    const bundlePath = path.join(outDir, `bundle-${feedVersion}.tar.gz`);
    await exec("tar", [
      "-czf",
      bundlePath,
      "-C",
      tmp,
      "manifest.json",
      "stations.csv",
      "trip_mappings.csv",
      "gb-rail.gtfs.zip",
    ]);

    return bundlePath;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
