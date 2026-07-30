import { etlRun } from "@mainline/db";
import { desc, eq } from "drizzle-orm";
import { getDb } from "./db";

/**
 * How fresh the timetable is, and whether the last attempt worked.
 *
 * `etl_run` has always been written but never read by the app — not by
 * /api/health, not by /status, not by the settings page. So if the nightly
 * import stopped, MOTIS carried on serving an ageing timetable forever and
 * nothing said a word. Journeys past the feed's horizon come back as
 * "no journeys", which looks exactly like a route that genuinely isn't served.
 *
 * This is the query that makes that visible.
 */

/**
 * Hours before the timetable counts as stale.
 *
 * RDG sends a daily update, so a healthy deployment imports every night. 36
 * hours allows one missed run — a transient SFTP failure retries the next night
 * without crying wolf — while still catching a feed that has genuinely stopped.
 */
const STALE_AFTER_HOURS = Number(process.env.TIMETABLE_STALE_AFTER_HOURS ?? 36);

export interface TimetableStatus {
  /** Newest successful import, or null if there has never been one. */
  lastSuccessAt: string | null;
  lastSuccessVersion: string | null;
  hoursSinceSuccess: number | null;
  /** True when the most recent attempt of any kind failed. */
  lastAttemptFailed: boolean;
  lastFailureAt: string | null;
  lastFailureDetail: string | null;
  stale: boolean;
  ok: boolean;
}

export async function timetableStatus(): Promise<TimetableStatus | null> {
  try {
    const rows = await getDb()
      .select({
        version: etlRun.version,
        importedAt: etlRun.importedAt,
        ok: etlRun.ok,
        detail: etlRun.detail,
      })
      .from(etlRun)
      .where(eq(etlRun.feed, "timetable"))
      .orderBy(desc(etlRun.importedAt))
      .limit(20);

    if (rows.length === 0) {
      // Never run at all. Distinct from "ran and failed", and worth saying so —
      // on a fresh deploy the ETL genuinely has not run yet.
      return {
        lastSuccessAt: null,
        lastSuccessVersion: null,
        hoursSinceSuccess: null,
        lastAttemptFailed: false,
        lastFailureAt: null,
        lastFailureDetail: null,
        stale: true,
        ok: false,
      };
    }

    const success = rows.find((r) => r.ok);
    const latest = rows[0]!;
    const failure = latest.ok ? null : latest;

    const hoursSince = success
      ? (Date.now() - success.importedAt.getTime()) / 3_600_000
      : null;
    const stale = hoursSince === null || hoursSince > STALE_AFTER_HOURS;

    return {
      lastSuccessAt: success?.importedAt.toISOString() ?? null,
      lastSuccessVersion: success?.version ?? null,
      hoursSinceSuccess: hoursSince === null ? null : Math.round(hoursSince * 10) / 10,
      lastAttemptFailed: Boolean(failure),
      lastFailureAt: failure?.importedAt.toISOString() ?? null,
      lastFailureDetail: failure?.detail ?? null,
      stale,
      ok: !stale && !failure,
    };
  } catch {
    // The database being unreachable is already reported by the caller's own
    // Postgres check; don't turn it into a second, confusing failure.
    return null;
  }
}
