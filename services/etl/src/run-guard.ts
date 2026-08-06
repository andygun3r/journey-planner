import { acquireSingletonLock, createDb, etlRun } from "@signaller/db";

/**
 * Wraps an ETL command so only one runs at a time, and so a failure leaves a
 * trace.
 *
 * Two problems this solves.
 *
 * **Overlapping runs.** There are four ways to start one: the nightly cron, a
 * manual `docker run --rm etl timetable`, the /api/etl/sftp-sync endpoint,
 * and a bundle upload. They share one MariaDB scratch database, one fixed
 * prepared-zip path, one raw GTFS zip, and they all truncate `station` and
 * `trip_mapping`. Two at once corrupt each other quietly. The ingest services
 * already guard against exactly this; the ETL never did.
 *
 * **Invisible failures.** `etl_run.ok` was only ever written `true`, so a failed
 * night wrote no row at all — indistinguishable from "this has never run". Now a
 * failure is recorded, which is what lets the health endpoint say something
 * useful instead of silently serving an ageing timetable.
 */

/** Lock names. Fares and the timetable don't block each other — different data. */
export type EtlLock = "etl-timetable" | "etl-fares";

export class EtlBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtlBusyError";
  }
}

/**
 * Record a failed run.
 *
 * `source_modified_at` is deliberately left null. The SFTP watermark only reads
 * rows where `ok = true`, so a failure can't advance it today — but if that
 * filter is ever relaxed, a failure row carrying a source timestamp would mark
 * the file as imported forever. Null makes that mistake impossible.
 */
export async function recordFailure(feed: string, version: string, error: unknown): Promise<void> {
  try {
    const db = createDb();
    await db.insert(etlRun).values({
      feed,
      version,
      ok: false,
      detail: (error as Error).message?.slice(0, 500) ?? String(error),
    });
  } catch (err) {
    // Never let the bookkeeping hide the original failure.
    console.error(`[etl] could not record failure: ${(err as Error).message}`);
  }
}

export async function guarded<T>(
  lock: EtlLock,
  feed: string,
  work: () => Promise<T>,
): Promise<T> {
  let release: (() => Promise<void>) | undefined;
  try {
    const handle = await acquireSingletonLock(lock);
    release = handle.release;
  } catch (err) {
    // Refusing to start is the correct outcome, but it must not look like
    // success — record it so the health endpoint reports a missed run.
    const message = (err as Error).message;
    await recordFailure(feed, "skipped", new Error(`another run is in progress: ${message}`));
    throw new EtlBusyError(message);
  }

  try {
    return await work();
  } catch (err) {
    await recordFailure(feed, "failed", err);
    throw err;
  } finally {
    await release?.().catch(() => {});
  }
}
