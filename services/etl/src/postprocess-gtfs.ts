import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readGtfsCsv } from "./gtfs-csv.js";

const exec = promisify(execFile);

/**
 * Post-processes the dtd2mysql GTFS export (verified against RJTTF906 output):
 *  - trips.txt carries train_uid in trip_headsign (and RSID in trip_short_name),
 *    so trip_mapping is derived from trips.txt + calendar.txt directly.
 *  - transfers.txt is emitted from .MSN interchange times (+ .FLF fixed links);
 *    we sanity-check its presence rather than regenerate it.
 *  - stops.txt lat/lons come from OS grid conversion + bundled overrides;
 *    we count degenerate (0,0) stops and fail loudly if widespread.
 */

export interface TripMappingRow {
  gtfsTripId: string;
  trainUid: string;
  dateRunsFrom: string; // YYYY-MM-DD
  dateRunsTo: string;
  daysMask: number;
  stpIndicator: string; // overlays already merged by dtd2mysql -> always 'P'
}

export interface StationRow {
  crs: string;
  name: string;
  tiploc: string;
  lat: number;
  lon: number;
  interchangeMin: number;
}

export interface PostprocessResult {
  gtfsZip: string;
  tripMappingCsv: string;
  tripMappings: TripMappingRow[];
  stations: StationRow[];
}

const DAY_COLUMNS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function isoDate(gtfsDate: string): string {
  return `${gtfsDate.slice(0, 4)}-${gtfsDate.slice(4, 6)}-${gtfsDate.slice(6, 8)}`;
}

export async function postprocessGtfs(rawGtfsZip: string, outDir: string): Promise<PostprocessResult> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gtfs-post-"));
  try {
    await exec("unzip", ["-o", "-q", rawGtfsZip, "-d", tmp]);

    for (const required of ["trips.txt", "calendar.txt", "stops.txt", "stop_times.txt"]) {
      if (!existsSync(path.join(tmp, required))) {
        throw new Error(`postprocess: GTFS export is missing ${required}`);
      }
    }
    if (!existsSync(path.join(tmp, "transfers.txt"))) {
      throw new Error(
        "postprocess: transfers.txt missing — interchange times were expected from .MSN; investigate before routing",
      );
    }

    // calendar.txt -> service_id => {from, to, daysMask}
    const services = new Map<string, { from: string; to: string; daysMask: number }>();
    for await (const row of readGtfsCsv(path.join(tmp, "calendar.txt"))) {
      let mask = 0;
      DAY_COLUMNS.forEach((day, i) => {
        if (row[day] === "1") mask |= 1 << i;
      });
      services.set(row["service_id"]!, {
        from: isoDate(row["start_date"]!),
        to: isoDate(row["end_date"]!),
        daysMask: mask,
      });
    }

    // trips.txt -> trip_mapping rows (trip_headsign = train UID)
    const tripMappings: TripMappingRow[] = [];
    let missingService = 0;
    for await (const row of readGtfsCsv(path.join(tmp, "trips.txt"))) {
      const service = services.get(row["service_id"]!);
      if (!service) {
        missingService++;
        continue;
      }
      tripMappings.push({
        gtfsTripId: row["trip_id"]!,
        trainUid: row["trip_headsign"]!,
        dateRunsFrom: service.from,
        dateRunsTo: service.to,
        daysMask: service.daysMask,
        stpIndicator: "P",
      });
    }
    if (tripMappings.length === 0) throw new Error("postprocess: no trips found in GTFS export");
    if (missingService > 0) {
      console.warn(`postprocess: ${missingService} trips had no calendar.txt entry (skipped)`);
    }

    // stops.txt -> stations (stop_id = CRS, stop_code = TIPLOC)
    const stations: StationRow[] = [];
    let degenerate = 0;
    for await (const row of readGtfsCsv(path.join(tmp, "stops.txt"))) {
      const lat = Number(row["stop_lat"] ?? "0");
      const lon = Number(row["stop_lon"] ?? "0");
      if (!lat && !lon) degenerate++;
      stations.push({
        crs: row["stop_id"]!,
        name: row["stop_name"] ?? row["stop_id"]!,
        tiploc: row["stop_code"] ?? "",
        lat,
        lon,
        interchangeMin: 5, // refined below from transfers.txt
      });
    }
    if (degenerate > stations.length * 0.05) {
      throw new Error(
        `postprocess: ${degenerate}/${stations.length} stops have no coordinates — MOTIS needs usable lat/lons`,
      );
    }

    // transfers.txt same-station rows -> per-station minimum interchange minutes
    const interchange = new Map<string, number>();
    for await (const row of readGtfsCsv(path.join(tmp, "transfers.txt"))) {
      if (row["from_stop_id"] === row["to_stop_id"] && row["min_transfer_time"]) {
        interchange.set(row["from_stop_id"]!, Math.round(Number(row["min_transfer_time"]) / 60));
      }
    }
    for (const s of stations) {
      const minutes = interchange.get(s.crs);
      if (minutes !== undefined) s.interchangeMin = minutes;
    }

    const tripMappingCsv = path.join(outDir, "trip_mapping.csv");
    await writeFile(
      tripMappingCsv,
      "gtfs_trip_id,train_uid,date_runs_from,date_runs_to,days_mask,stp_indicator\n" +
        tripMappings
          .map((t) => `${t.gtfsTripId},${t.trainUid},${t.dateRunsFrom},${t.dateRunsTo},${t.daysMask},${t.stpIndicator}`)
          .join("\n"),
    );

    const gtfsZip = path.join(outDir, "gb-rail.gtfs.zip");
    await copyFile(rawGtfsZip, gtfsZip);

    console.log(
      `postprocess: ${tripMappings.length} trips mapped, ${stations.length} stations, ` +
        `${interchange.size} interchange times, ${degenerate} stops without coords`,
    );
    return { gtfsZip, tripMappingCsv, tripMappings, stations };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
