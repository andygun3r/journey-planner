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
import { railCorridors } from "./rail-corridors.js";
import { snapStations } from "./snap-stations.js";

const ARCHIVE_DIR = process.env.ETL_ARCHIVE_DIR ?? "/data/dtd/archive";
const GTFS_OUT_DIR = process.env.ETL_GTFS_OUT_DIR ?? "/data/gtfs";

// SFTP is RDG's push/pull delivery alternative to the NRDP HTTPS staticfeed
// API — separate account from NRDP_USERNAME/PASSWORD. Used automatically
// when DTD_SFTP_HOST is set; otherwise falls back to the HTTPS download.
function useSftp(): boolean {
  return Boolean(process.env.DTD_SFTP_HOST);
}

/** Latest source mtime (epoch ms) among successfully imported timetable runs, per etl_run. */
async function latestImportedTimetableMtime(): Promise<number> {
  const db = createDb();
  const rows = await db
    .select({ sourceModifiedAt: etlRun.sourceModifiedAt })
    .from(etlRun)
    .where(and(eq(etlRun.feed, "timetable"), eq(etlRun.ok, true)));
  let latest = 0;
  for (const r of rows) {
    const ms = r.sourceModifiedAt?.getTime() ?? 0;
    if (ms > latest) latest = ms;
  }
  return latest;
}

/** Runs the full pipeline (dtd2mysql import -> GTFS export -> postprocess -> Postgres) for one zip. */
async function importTimetableZip(rawZip: string, sourceModifiedAt?: number): Promise<void> {
  const feedVersion = path.basename(rawZip, path.extname(rawZip));
  const zip = await prepareTimetableZip(rawZip, ARCHIVE_DIR);
  await importTimetable(zip);
  const rawGtfs = path.join(GTFS_OUT_DIR, "gb-rail.raw.gtfs.zip");
  await exportGtfs(rawGtfs);
  const result = await postprocessGtfs(rawGtfs, GTFS_OUT_DIR);
  await loadIntoPostgres(result, feedVersion, sourceModifiedAt ? new Date(sourceModifiedAt) : undefined);
  console.log(`GTFS ready: ${result.gtfsZip} (${feedVersion})`);
}

async function timetable(source?: string): Promise<void> {
  if (source) {
    await importTimetableZip(source);
  } else if (useSftp()) {
    // RDG drops both a monthly full timetable and daily updates in the same
    // SFTP folder — process every zip newer than the last successful import,
    // oldest first, so a full followed by same-day/since-last-run updates
    // all land in delivery order instead of only the single newest file.
    const since = await latestImportedTimetableMtime();
    const pending = await downloadPendingFeedsViaSftp("timetable", ARCHIVE_DIR, since);
    if (pending.length === 0) {
      console.log("No new timetable files on SFTP — nothing to do.");
      return;
    }
    console.log(`${pending.length} new timetable file(s) to import: ${pending.map((p) => path.basename(p.path)).join(", ")}`);
    for (const file of pending) {
      await importTimetableZip(file.path, file.sourceModifiedAt);
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
  case "snap-stations":
    // Recompute station.track_lat/lon from the orm-db PostGIS import.
    // Run after each `orm-import`; independent of the timetable pipeline.
    await snapStations();
    break;
  case "rail-corridors":
    // Recompute track-following geometry between adjacent calling points.
    // Depends on snap-stations having run (it uses track_lat/lon as the
    // corridor endpoints) and on Darwin schedules being loaded, since the
    // pair list comes from real calling patterns.
    await railCorridors();
    break;
  case "load-fares":
    // Re-load fares from the MariaDB scratch DB into Postgres (skips download/import).
    await loadFares();
    break;
  default:
    console.error(
      "Usage: etl <timetable|package|fares|load-fares|postprocess|snap-stations|rail-corridors>",
    );
    process.exit(1);
}
