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
import { pushGtfsAndReimport } from "./motis-reimport.js";

/**
 * Pipeline commands shared by the CLI dispatcher (index.ts) and the HTTP
 * server (server.ts) — kept out of index.ts because that file runs its
 * command dispatch as a top-level module side effect, so importing it (as
 * server.ts would need to) would trigger a CLI run on every import.
 */

const ARCHIVE_DIR = process.env.ETL_ARCHIVE_DIR ?? "/data/dtd/archive";
const GTFS_OUT_DIR = process.env.ETL_GTFS_OUT_DIR ?? "/data/gtfs";

// SFTP is RDG's push/pull delivery alternative to the NRDP HTTPS staticfeed
// API — separate account from NRDP_USERNAME/PASSWORD. Used automatically
// when DTD_SFTP_HOST is set; otherwise falls back to the HTTPS download.
function useSftp(): boolean {
  return Boolean(process.env.DTD_SFTP_HOST);
}

/** Latest source mtime (epoch ms) among successfully imported runs for a feed, per etl_run. */
async function latestImportedFeedMtime(feed: "timetable" | "fares"): Promise<number> {
  const db = createDb();
  const rows = await db
    .select({ sourceModifiedAt: etlRun.sourceModifiedAt })
    .from(etlRun)
    .where(and(eq(etlRun.feed, feed), eq(etlRun.ok, true)));
  let latest = 0;
  for (const r of rows) {
    const ms = r.sourceModifiedAt?.getTime() ?? 0;
    if (ms > latest) latest = ms;
  }
  return latest;
}

/**
 * Times one stage and reports it.
 *
 * There was no instrumentation here at all, so "which step is slow" and "which
 * step ran the box out of memory" were both guesswork. Peak RSS is per-process
 * rather than per-stage, but it still shows which stage the high-water mark
 * appeared during.
 */
async function stage<T>(name: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const peakMb = (process.resourceUsage().maxRSS / 1024).toFixed(0);
    console.log(`[etl] ${name}: ${seconds}s (peak rss ${peakMb}MB)`);
  }
}

/** Runs the full pipeline (dtd2mysql import -> GTFS export -> postprocess -> Postgres) for one zip. */
export async function importTimetableZip(rawZip: string, sourceModifiedAt?: number): Promise<void> {
  const feedVersion = path.basename(rawZip, path.extname(rawZip));
  const zip = await stage("prepare", () => prepareTimetableZip(rawZip, ARCHIVE_DIR));
  await stage("dtd2mysql import", () => importTimetable(zip));
  const rawGtfs = path.join(GTFS_OUT_DIR, "gb-rail.raw.gtfs.zip");
  await stage("gtfs export", () => exportGtfs(rawGtfs));
  const result = await stage("postprocess", () => postprocessGtfs(rawGtfs, GTFS_OUT_DIR));
  await stage("postgres load", () =>
    loadIntoPostgres(result, feedVersion, sourceModifiedAt ? new Date(sourceModifiedAt) : undefined),
  );
  console.log(`GTFS ready: ${result.gtfsZip} (${feedVersion})`);
  await stage("motis reimport", () => pushGtfsAndReimport(result.gtfsZip));
}

export async function timetable(source?: string): Promise<void> {
  if (source) {
    await importTimetableZip(source);
  } else if (useSftp()) {
    // RDG drops both a monthly full timetable and daily updates in the same
    // SFTP folder — process every zip newer than the last successful import,
    // oldest first, so a full followed by same-day/since-last-run updates
    // all land in delivery order instead of only the single newest file.
    const since = await latestImportedFeedMtime("timetable");
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
}

/**
 * Runs the full timetable pipeline (download -> dtd2mysql -> postprocess) but,
 * instead of writing to Postgres, packages the derived station/trip_mapping
 * rows and GTFS zip into one bundle for upload via the web app's
 * /settings/timetable page — so a low-memory server never has to run
 * dtd2mysql itself. Run this locally: `docker run --rm ... etl package`.
 */
export async function packageCommand(source?: string): Promise<void> {
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
export async function postprocessOnly(feedVersion = "unknown"): Promise<void> {
  const rawGtfs = path.join(GTFS_OUT_DIR, "gb-rail.raw.gtfs.zip");
  const result = await postprocessGtfs(rawGtfs, GTFS_OUT_DIR);
  await loadIntoPostgres(result, feedVersion);
  console.log(`GTFS ready: ${result.gtfsZip}`);
}

async function importFaresZip(zip: string, sourceModifiedAt?: number): Promise<void> {
  const feedVersion = path.basename(zip, path.extname(zip));
  await importFares(zip);
  await loadFares({
    version: feedVersion,
    sourceModifiedAt: sourceModifiedAt ? new Date(sourceModifiedAt) : undefined,
  });
  console.log("Fares loaded into Postgres.");
}

export async function fares(source?: string): Promise<void> {
  if (source) {
    await importFaresZip(source);
  } else if (useSftp()) {
    const since = await latestImportedFeedMtime("fares");
    const pending = await downloadPendingFeedsViaSftp("fares", ARCHIVE_DIR, since);
    if (pending.length === 0) {
      console.log("No new fares files on SFTP — nothing to do.");
      return;
    }
    console.log(`${pending.length} new fares file(s) to import: ${pending.map((p) => path.basename(p.path)).join(", ")}`);
    for (const file of pending) {
      await importFaresZip(file.path, file.sourceModifiedAt);
    }
  } else {
    await importFaresZip(await downloadFeed("fares", ARCHIVE_DIR));
  }
}
