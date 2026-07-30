import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, copyFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getDb } from "./db";
import { etlRun, station, tripMapping } from "@mainline/db";
import { reloadMotis } from "./motis-reload";

const exec = promisify(execFile);
const BATCH = 2000;

export type ApplyProgress = (message: string) => void;

interface Manifest {
  feedVersion: string;
  createdAt: string;
  stationCount: number;
  tripMappingCount: number;
}

/** Minimal CSV line splitter for the fixed, simple format package-bundle.ts writes. */
function parseCsv(text: string): string[][] {
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.map((line) => {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') {
          inQuotes = false;
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields;
  });
}

async function loadStationsCsv(csvPath: string): Promise<
  { crs: string; name: string; tiplocs: string[]; lat: number; lon: number; interchangeMin: number }[]
> {
  const rows = parseCsv(await readFile(csvPath, "utf8"));
  return rows.slice(1).map(([crs, name, tiplocs, lat, lon, interchangeMin]) => ({
    crs: crs!,
    name: name!,
    // Pipe-separated, because a station has subsidiary TIPLOCs beyond the one
    // GTFS names — and without them live tracking silently fails for any train
    // first seen at one. Older bundles wrote a single value with no pipe, which
    // splits to a one-element list, so they still load.
    tiplocs: (tiplocs ?? "").split("|").filter(Boolean),
    lat: Number(lat),
    lon: Number(lon),
    interchangeMin: Number(interchangeMin),
  }));
}

async function loadTripMappingsCsv(csvPath: string): Promise<
  {
    gtfsTripId: string;
    trainUid: string;
    dateRunsFrom: string;
    dateRunsTo: string;
    daysMask: number;
    stpIndicator: string;
  }[]
> {
  const rows = parseCsv(await readFile(csvPath, "utf8"));
  return rows
    .slice(1)
    .map(([gtfsTripId, trainUid, dateRunsFrom, dateRunsTo, daysMask, stpIndicator]) => ({
      gtfsTripId: gtfsTripId!,
      trainUid: trainUid!,
      dateRunsFrom: dateRunsFrom!,
      dateRunsTo: dateRunsTo!,
      daysMask: Number(daysMask),
      stpIndicator: stpIndicator!,
    }));
}

/**
 * Applies a bundle produced locally by `etl package` (see
 * services/etl/src/package-bundle.ts): loads the pre-converted station/trip
 * mapping CSVs into Postgres, drops the GTFS zip into the shared volume, and
 * reimports + restarts motis so it serves the new data — all without running
 * dtd2mysql on this (memory-constrained) server. `motis server` only ever
 * serves whatever's already preprocessed under /data/data — restarting alone
 * does NOT reimport, `motis import` must run first.
 */
export async function applyBundle(bundlePath: string, onProgress: ApplyProgress): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "etl-apply-"));
  try {
    onProgress("Extracting bundle...");
    await exec("tar", ["-xzf", bundlePath, "-C", tmp]);

    const manifest = JSON.parse(await readFile(path.join(tmp, "manifest.json"), "utf8")) as Manifest;
    onProgress(
      `Bundle: ${manifest.feedVersion} (${manifest.stationCount} stations, ${manifest.tripMappingCount} trip mappings, created ${manifest.createdAt})`,
    );

    onProgress("Reading stations.csv and trip_mappings.csv...");
    const stations = await loadStationsCsv(path.join(tmp, "stations.csv"));
    const tripMappings = await loadTripMappingsCsv(path.join(tmp, "trip_mappings.csv"));

    onProgress(`Loading ${stations.length} stations into Postgres...`);
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.delete(station);
      for (let i = 0; i < stations.length; i += BATCH) {
        await tx.insert(station).values(
          stations.slice(i, i + BATCH).map((s) => ({
            crs: s.crs,
            name: s.name,
            tiplocs: s.tiplocs,
            lat: s.lat,
            lon: s.lon,
            interchangeMin: s.interchangeMin,
          })),
        );
      }

      onProgress(`Loading ${tripMappings.length} trip mappings into Postgres...`);
      await tx.delete(tripMapping);
      for (let i = 0; i < tripMappings.length; i += BATCH) {
        await tx.insert(tripMapping).values(tripMappings.slice(i, i + BATCH));
      }

      // KNOWN GAP: source_modified_at is left null, because the bundle manifest
      // doesn't carry the source file's SFTP mtime — `package` uses
      // downloadFeedViaSftp, which returns only a path. So an uploaded bundle
      // does not advance the SFTP watermark, and a later cron run will re-import
      // the same file. Harmless (the import is idempotent, just wasted work),
      // but it means the two paths cannot be mixed freely. Fixing it properly
      // means threading the mtime through package -> manifest -> here.
      await tx.insert(etlRun).values({
        feed: "timetable",
        version: manifest.feedVersion,
        ok: true,
        detail: `${stations.length} stations, ${tripMappings.length} trip mappings (uploaded bundle)`,
      });
    });

    onProgress("Copying GTFS zip into the shared volume...");
    const gtfsOutDir = process.env.ETL_GTFS_OUT_DIR ?? "/data/gtfs";
    await mkdir(gtfsOutDir, { recursive: true });
    await copyFile(path.join(tmp, "gb-rail.gtfs.zip"), path.join(gtfsOutDir, "gb-rail.gtfs.zip"));

    await reloadMotis(onProgress);

    onProgress("Done.");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
