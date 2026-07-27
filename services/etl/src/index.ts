import path from "node:path";
import { createDb, etlRun } from "@mainline/db";
import { eq, and } from "drizzle-orm";
import { downloadFeed } from "./download.js";
import { downloadFeedViaSftp, downloadPendingFeedsViaSftp } from "./sftp-download.js";
import { prepareTimetableZip } from "./prepare.js";
import { exportGtfs, importFares, importTimetable } from "./run-dtd2mysql.js";
import { postprocessGtfs } from "./postprocess-gtfs.js";
import { loadFares } from "./load-fares.js";
import { loadIntoPostgres } from "./load-postgres.js";
import { packageBundle } from "./package-bundle.js";

const ARCHIVE_DIR = process.env.ETL_ARCHIVE_DIR ?? "/data/dtd/archive";
const GTFS_OUT_DIR = process.env.ETL_GTFS_OUT_DIR ?? "/data/gtfs";

// SFTP is RDG's push/pull delivery alternative to the NRDP HTTPS staticfeed
// API — separate account from NRDP_USERNAME/PASSWORD. Used automatically
// when DTD_SFTP_HOST is set; otherwise falls back to the HTTPS download.
function useSftp(): boolean {
  return Boolean(process.env.DTD_SFTP_HOST);
}

/** Feed versions ("RJTTF512") already successfully imported, per etl_run. */
async function importedTimetableVersions(): Promise<Set<string>> {
  const db = createDb();
  const rows = await db
    .select({ version: etlRun.version })
    .from(etlRun)
    .where(and(eq(etlRun.feed, "timetable"), eq(etlRun.ok, true)));
  return new Set(rows.map((r) => r.version));
}

/** Runs the full pipeline (dtd2mysql import -> GTFS export -> postprocess -> Postgres) for one zip. */
async function importTimetableZip(rawZip: string): Promise<void> {
  const feedVersion = path.basename(rawZip, path.extname(rawZip));
  const zip = await prepareTimetableZip(rawZip, ARCHIVE_DIR);
  await importTimetable(zip);
  const rawGtfs = path.join(GTFS_OUT_DIR, "gb-rail.raw.gtfs.zip");
  await exportGtfs(rawGtfs);
  const result = await postprocessGtfs(rawGtfs, GTFS_OUT_DIR);
  await loadIntoPostgres(result, feedVersion);
  console.log(`GTFS ready: ${result.gtfsZip} (${feedVersion})`);
}

async function timetable(source?: string): Promise<void> {
  if (source) {
    await importTimetableZip(source);
  } else if (useSftp()) {
    // RDG drops both a monthly full timetable and daily updates in the same
    // SFTP folder — process every zip not yet recorded in etl_run, oldest
    // first, so a full followed by same-day/since-last-run updates all land
    // in delivery order instead of only the single newest file.
    const imported = await importedTimetableVersions();
    const pending = await downloadPendingFeedsViaSftp("timetable", ARCHIVE_DIR, imported);
    if (pending.length === 0) {
      console.log("No new timetable files on SFTP — nothing to do.");
      return;
    }
    console.log(`${pending.length} new timetable file(s) to import: ${pending.map((p) => path.basename(p)).join(", ")}`);
    for (const rawZip of pending) {
      await importTimetableZip(rawZip);
    }
  } else {
    await importTimetableZip(await downloadFeed("timetable", ARCHIVE_DIR));
  }
  console.log("Next: docker compose --profile routing up -d motis (reimports on refreshed GTFS).");
}

/**
 * Runs the full timetable pipeline (download -> dtd2mysql -> postprocess) but,
 * instead of writing to Postgres, packages the derived station/trip_mapping
 * rows and GTFS zip into one bundle for upload via the web app's
 * /settings/timetable page — so a low-memory server never has to run
 * dtd2mysql itself. Run this locally: `docker compose --profile etl run --rm etl package`.
 */
async function packageCommand(source?: string): Promise<void> {
  const rawZip =
    source ??
    (useSftp() ? await downloadFeedViaSftp("timetable", ARCHIVE_DIR) : await downloadFeed("timetable", ARCHIVE_DIR));
  const feedVersion = path.basename(rawZip, path.extname(rawZip));
  const zip = await prepareTimetableZip(rawZip, ARCHIVE_DIR);
  await importTimetable(zip);
  const rawGtfs = path.join(GTFS_OUT_DIR, "gb-rail.raw.gtfs.zip");
  await exportGtfs(rawGtfs);
  const result = await postprocessGtfs(rawGtfs, GTFS_OUT_DIR);
  const bundlePath = await packageBundle(result, feedVersion, GTFS_OUT_DIR);
  console.log(`Bundle ready: ${bundlePath}`);
  console.log("Upload it at /settings/timetable on the running web app.");
}

/** Resume from an already-exported raw GTFS zip (skips download + dtd2mysql). */
async function postprocessOnly(feedVersion = "unknown"): Promise<void> {
  const rawGtfs = path.join(GTFS_OUT_DIR, "gb-rail.raw.gtfs.zip");
  const result = await postprocessGtfs(rawGtfs, GTFS_OUT_DIR);
  await loadIntoPostgres(result, feedVersion);
  console.log(`GTFS ready: ${result.gtfsZip}`);
}

async function fares(source?: string): Promise<void> {
  const zip =
    source ??
    (useSftp() ? await downloadFeedViaSftp("fares", ARCHIVE_DIR) : await downloadFeed("fares", ARCHIVE_DIR));
  await importFares(zip);
  await loadFares();
  console.log("Fares loaded into Postgres.");
}

const command = process.argv[2];
switch (command) {
  case "timetable":
    await timetable(process.argv[3]);
    break;
  case "package":
    await packageCommand(process.argv[3]);
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
    console.error("Usage: etl <timetable|package|fares|load-fares|postprocess>");
    process.exit(1);
}
