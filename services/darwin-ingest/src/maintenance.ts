import {
  createDb,
  darwinStopForecast,
  darwinTrain,
  nrTrainPosition,
  nrTrainPositionHistory,
} from "@mainline/db";
import { lt, sql } from "drizzle-orm";

const db = createDb();

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
 * Ordering matters: stop forecasts are removed via their parent train's ssd
 * BEFORE the trains themselves, or the join can no longer find them and the
 * rows are orphaned forever.
 */
export async function pruneExpiredData(): Promise<void> {
  const startedAt = Date.now();

  // Child rows first, selected through the parent's service date.
  const stops = await db.execute(sql`
    delete from ${darwinStopForecast}
    where ${darwinStopForecast.rid} in (
      select ${darwinTrain.rid} from ${darwinTrain}
      where ${darwinTrain.ssd} < current_date - 1
    )
  `);

  const trains = await db.delete(darwinTrain).where(sql`${darwinTrain.ssd} < current_date - 1`);

  const positions = await db
    .delete(nrTrainPosition)
    .where(
      lt(nrTrainPosition.updatedAt, new Date(Date.now() - POSITION_STALE_HOURS * 3_600_000)),
    );

  // Replaces the old sweep-on-write in nr-ingest's store.ts, which fired on
  // `Math.random() < 0.001` — unpredictable, and tied cleanup rate to traffic
  // volume rather than to time.
  const history = await db
    .delete(nrTrainPositionHistory)
    .where(
      lt(
        nrTrainPositionHistory.recordedAt,
        new Date(Date.now() - HISTORY_RETENTION_DAYS * 86_400_000),
      ),
    );

  console.log(
    `[maintenance] pruned in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
      `stop_forecast ${stops.count ?? 0}, darwin_train ${trains.count ?? 0}, ` +
      `positions ${positions.count ?? 0}, history ${history.count ?? 0}`,
  );
}
