import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
    const stationsCsv = [
      "crs,name,tiploc,lat,lon,interchange_min",
      ...result.stations.map((s) =>
        [s.crs, csvEscape(s.name), s.tiploc, s.lat, s.lon, s.interchangeMin].join(","),
      ),
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
