import path from "node:path";
import { downloadFeed } from "./download.js";
import { prepareTimetableZip } from "./prepare.js";
import { exportGtfs, importFares, importTimetable } from "./run-dtd2mysql.js";
import { postprocessGtfs } from "./postprocess-gtfs.js";
import { loadFares } from "./load-fares.js";
import { loadIntoPostgres } from "./load-postgres.js";

const ARCHIVE_DIR = process.env.ETL_ARCHIVE_DIR ?? "/data/dtd/archive";
const GTFS_OUT_DIR = process.env.ETL_GTFS_OUT_DIR ?? "/data/gtfs";

async function timetable(source?: string): Promise<void> {
  // Source precedence: explicit local zip path (RDM download) > NRDP fetch.
  const rawZip = source ?? (await downloadFeed("timetable", ARCHIVE_DIR));
  const feedVersion = path.basename(rawZip, path.extname(rawZip));
  const zip = await prepareTimetableZip(rawZip, ARCHIVE_DIR);
  await importTimetable(zip);
  const rawGtfs = path.join(GTFS_OUT_DIR, "gb-rail.raw.gtfs.zip");
  await exportGtfs(rawGtfs);
  const result = await postprocessGtfs(rawGtfs, GTFS_OUT_DIR);
  await loadIntoPostgres(result, feedVersion);
  console.log(`GTFS ready: ${result.gtfsZip}`);
  console.log("Next: docker compose --profile routing up -d motis (reimports on restart).");
}

/** Resume from an already-exported raw GTFS zip (skips download + dtd2mysql). */
async function postprocessOnly(feedVersion = "unknown"): Promise<void> {
  const rawGtfs = path.join(GTFS_OUT_DIR, "gb-rail.raw.gtfs.zip");
  const result = await postprocessGtfs(rawGtfs, GTFS_OUT_DIR);
  await loadIntoPostgres(result, feedVersion);
  console.log(`GTFS ready: ${result.gtfsZip}`);
}

async function fares(source?: string): Promise<void> {
  const zip = source ?? (await downloadFeed("fares", ARCHIVE_DIR));
  await importFares(zip);
  await loadFares();
  console.log("Fares loaded into Postgres.");
}

const command = process.argv[2];
switch (command) {
  case "timetable":
    await timetable(process.argv[3]);
    break;
  case "postprocess":
    await postprocessOnly(process.argv[3]);
    break;
  case "fares":
    await fares(process.argv[3]);
    break;
  case "load-fares":
    // Re-load fares from the MariaDB scratch DB into Postgres (skips download/import).
    await loadFares();
    break;
  default:
    console.error("Usage: etl <timetable|fares|load-fares|postprocess>");
    process.exit(1);
}
