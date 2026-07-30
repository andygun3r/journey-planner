import { getSharedDb } from "@mainline/db";
import { sql } from "drizzle-orm";

const db = getSharedDb();

/**
 * Retention for the append-only position log. Longer than the operational
 * tables below because this one is deliberately historical: it backs the
 * service-detail "advanced view" and trajectory analysis.
 */
const HISTORY_RETENTION_DAYS = Number(process.env.NR_POSITION_HISTORY_RETENTION_DAYS ?? 7);

/**
 * How long a position row survives without a fresh report before it counts as
 * a finished journey. Every reader already filters on `updated_at` (the live
 * map uses a 15-minute window), so anything this old is invisible in the UI —
 * it just makes the table bigger and the queries slower.
 */
const POSITION_STALE_HOURS = Number(process.env.NR_POSITION_STALE_HOURS ?? 6);

/** Keep raised alerts readable for a while, then let them go. */
const ALERT_RETENTION_DAYS = Number(process.env.ALERT_RETENTION_DAYS ?? 30);

/** Short-notice schedules and speed restrictions are only useful while current. */
const VSTP_RETENTION_DAYS = Number(process.env.NR_VSTP_RETENTION_DAYS ?? 7);
const TSR_RETENTION_DAYS = Number(process.env.NR_TSR_RETENTION_DAYS ?? 7);

/**
 * Rows removed per statement.
 *
 * Deleting in chunks matters more than it looks. This job had never actually
 * run (its import was missing, so the nightly cron threw and killed the
 * process instead), which means the first real run has years of backlog to
 * clear — roughly 700k rows from darwin_stop_forecast alone. One unbounded
 * DELETE of that size holds locks for minutes and blocks the ingest writes
 * behind it. Chunking keeps each statement short so writers keep flowing.
 */
const CHUNK = Number(process.env.MAINTENANCE_CHUNK_ROWS ?? 10_000);

/** Stops a runaway loop if something keeps matching rows unexpectedly. */
const MAX_CHUNKS_PER_TABLE = 500;

/**
 * Delete repeatedly until nothing matches, a chunk at a time.
 *
 * `query` must delete at most CHUNK rows per call and report how many it
 * removed. Returns the total. Pauses briefly between chunks so autovacuum and
 * the ingest writers get a turn.
 */
async function deleteInChunks(label: string, query: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_CHUNKS_PER_TABLE; i++) {
    const removed = await query();
    total += removed;
    if (removed < CHUNK) return total;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.warn(`[maintenance] ${label} hit the chunk ceiling — more rows remain for tomorrow`);
  return total;
}

/** Runs one chunked DELETE and returns the row count. */
async function chunk(statement: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(statement);
  return result.count ?? 0;
}

/**
 * Delete daily data that no query can reach any more.
 *
 * Mainline ingests data with a ONE-DAY useful life — schedules, positions —
 * into tables that were built as if it were permanent, and nothing expired it.
 * Measured before this job existed:
 *
 *   darwin_train          104,673 rows, 71% for days already past (six days
 *                         retained: 2026-07-24 .. 07-30)
 *   darwin_stop_forecast  1,491,324 rows, 46.6% unreachable (~695k rows,
 *                         ~150 MB)
 *   nr_train_position     110,341 rows, 86% not updated in hours
 *
 * Every correlation query filters `ssd in (today, yesterday)`, so the older
 * days were pure scan cost. Keeping today and yesterday matches that window
 * exactly (yesterday is needed so an overnight service still resolves after
 * midnight — see findRidForHeadcode's two-day span).
 *
 * Ordering matters: anything keyed by rid must go BEFORE the trains
 * themselves, or the join can no longer find them and the rows are orphaned
 * forever. That applies to stop forecasts and to formations.
 */
export async function pruneExpiredData(): Promise<void> {
  const startedAt = Date.now();

  // --- Children of darwin_train, selected through the parent's service date.

  // Formation is keyed by rid alone with no service date of its own, so the
  // only way to age it is through its train. It was previously never pruned
  // at all, so it grew one row per train per day forever.
  const formations = await deleteInChunks("darwin_formation", () =>
    chunk(sql`
      delete from darwin_formation f
      where f.ctid in (
        select f2.ctid from darwin_formation f2
        join darwin_train d on d.rid = f2.rid
        where d.ssd < current_date - 1
        limit ${CHUNK}
      )
    `),
  );

  // Formation rows whose train is already gone can never be reached again.
  // Nothing creates these today, but a partial prune in the past could have.
  const orphanFormations = await deleteInChunks("darwin_formation orphans", () =>
    chunk(sql`
      delete from darwin_formation f
      where f.ctid in (
        select f2.ctid from darwin_formation f2
        where not exists (select 1 from darwin_train d where d.rid = f2.rid)
        limit ${CHUNK}
      )
    `),
  );

  const stops = await deleteInChunks("darwin_stop_forecast", () =>
    chunk(sql`
      delete from darwin_stop_forecast s
      where s.ctid in (
        select s2.ctid from darwin_stop_forecast s2
        join darwin_train d on d.rid = s2.rid
        where d.ssd < current_date - 1
        limit ${CHUNK}
      )
    `),
  );

  // --- Parents, now safe to remove.

  const trains = await deleteInChunks("darwin_train", () =>
    chunk(sql`
      delete from darwin_train t
      where t.ctid in (
        select t2.ctid from darwin_train t2
        where t2.ssd < current_date - 1
        limit ${CHUNK}
      )
    `),
  );

  // --- Network Rail tables.

  const positions = await deleteInChunks("nr_train_position", () =>
    chunk(sql`
      delete from nr_train_position p
      where p.ctid in (
        select p2.ctid from nr_train_position p2
        where p2.updated_at < now() - make_interval(hours => ${POSITION_STALE_HOURS})
        limit ${CHUNK}
      )
    `),
  );

  const history = await deleteInChunks("nr_train_position_history", () =>
    chunk(sql`
      delete from nr_train_position_history h
      where h.ctid in (
        select h2.ctid from nr_train_position_history h2
        where h2.recorded_at < now() - make_interval(days => ${HISTORY_RETENTION_DAYS})
        limit ${CHUNK}
      )
    `),
  );

  // Short-notice schedules stay until well past the day they applied to. These
  // had no retention at all before — rows for long-expired schedules simply
  // accumulated.
  const vstp = await deleteInChunks("nr_vstp_schedule", () =>
    chunk(sql`
      delete from nr_vstp_schedule v
      where v.ctid in (
        select v2.ctid from nr_vstp_schedule v2
        where coalesce(v2.end_date, v2.start_date) < current_date - make_interval(days => ${VSTP_RETENTION_DAYS})
        limit ${CHUNK}
      )
    `),
  );

  // Speed restrictions that finished a week ago are history, not state.
  const tsr = await deleteInChunks("nr_tsr", () =>
    chunk(sql`
      delete from nr_tsr t
      where t.ctid in (
        select t2.ctid from nr_tsr t2
        where t2.valid_to is not null
          and t2.valid_to < now() - make_interval(days => ${TSR_RETENTION_DAYS})
        limit ${CHUNK}
      )
    `),
  );

  // Alerts grow monotonically with users and days. Keep a month.
  const alerts = await deleteInChunks("alert", () =>
    chunk(sql`
      delete from alert a
      where a.ctid in (
        select a2.ctid from alert a2
        where a2.created_at < now() - make_interval(days => ${ALERT_RETENTION_DAYS})
        limit ${CHUNK}
      )
    `),
  );

  console.log(
    `[maintenance] pruned in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
      `stop_forecast ${stops}, darwin_train ${trains}, ` +
      `formations ${formations + orphanFormations}, positions ${positions}, ` +
      `history ${history}, vstp ${vstp}, tsr ${tsr}, alerts ${alerts}`,
  );
}
