import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, copyFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getDb } from "./db";
import { etlRun, station, tripMapping } from "@mainline/db";

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
  { crs: string; name: string; tiploc: string; lat: number; lon: number; interchangeMin: number }[]
> {
  const rows = parseCsv(await readFile(csvPath, "utf8"));
  return rows.slice(1).map(([crs, name, tiploc, lat, lon, interchangeMin]) => ({
    crs: crs!,
    name: name!,
    tiploc: tiploc!,
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
 * restarts motis so it reimports — all without running dtd2mysql on this
 * (memory-constrained) server.
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
            tiplocs: s.tiploc ? [s.tiploc] : [],
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

    onProgress("Restarting motis to reimport...");
    const motisContainer = process.env.MOTIS_CONTAINER_NAME ?? "mainline-motis-1";
    await exec("docker", ["restart", motisContainer]);

    onProgress("Done.");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
