import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { once } from "node:events";
import { finished as finishedCb } from "node:stream";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readGtfsCsv } from "./gtfs-csv.js";

const exec = promisify(execFile);
const finished = promisify(finishedCb);

/**
 * Write one chunk, respecting backpressure.
 *
 * Without the drain wait, Node buffers everything the consumer hasn't drained
 * yet in memory — which would put the whole file back on the heap and defeat
 * the point of streaming it.
 */
async function write(out: WriteStream, chunk: string): Promise<void> {
  if (!out.write(chunk)) await once(out, "drain");
}

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
  /**
   * Path to the derived trip mappings, as CSV.
   *
   * The rows are deliberately NOT returned as an array. There are roughly a
   * million of them, and holding them — then building one joined string to
   * write them out — was several hundred MB of peak heap in a pipeline that
   * already runs this server out of memory. They stream to disk as trips.txt is
   * read, and everything downstream reads the file.
   */
  tripMappingCsv: string;
  tripMappingCount: number;
  /** Small enough to keep in memory: a few thousand rows, and every caller needs it. */
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

    // trips.txt -> trip_mapping rows (trip_headsign = train UID), written
    // straight out rather than collected. readGtfsCsv is already an async
    // iterator, so nothing bigger than one row is ever held.
    const tripMappingCsv = path.join(outDir, "trip_mapping.csv");
    const csvOut = createWriteStream(`${tripMappingCsv}.tmp`);
    let tripMappingCount = 0;
    let missingService = 0;
    try {
      await write(csvOut, "gtfs_trip_id,train_uid,date_runs_from,date_runs_to,days_mask,stp_indicator\n");
      for await (const row of readGtfsCsv(path.join(tmp, "trips.txt"))) {
        const service = services.get(row["service_id"]!);
        if (!service) {
          missingService++;
          continue;
        }
        // stp_indicator is always 'P' — dtd2mysql has already merged overlays.
        await write(
          csvOut,
          `${row["trip_id"]},${row["trip_headsign"]},${service.from},${service.to},${service.daysMask},P\n`,
        );
        tripMappingCount++;
      }
    } finally {
      await finished(csvOut.end());
    }
    if (tripMappingCount === 0) throw new Error("postprocess: no trips found in GTFS export");
    if (missingService > 0) {
      console.warn(`postprocess: ${missingService} trips had no calendar.txt entry (skipped)`);
    }
    // Rename only once complete, so a crash never leaves a short CSV that a
    // later run would happily load as if it were the whole timetable.
    await rename(`${tripMappingCsv}.tmp`, tripMappingCsv);

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

    // Publish the GTFS atomically. copyFile truncates the destination in place,
    // so a crash mid-copy left a corrupt zip at the exact path MOTIS imports.
    // Write beside it and rename, which is atomic within the volume.
    const gtfsZip = path.join(outDir, "gb-rail.gtfs.zip");
    await copyFile(rawGtfsZip, `${gtfsZip}.tmp`);
    await rename(`${gtfsZip}.tmp`, gtfsZip);

    console.log(
      `postprocess: ${tripMappingCount} trips mapped, ${stations.length} stations, ` +
        `${interchange.size} interchange times, ${degenerate} stops without coords`,
    );
    return { gtfsZip, tripMappingCsv, tripMappingCount, stations };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
