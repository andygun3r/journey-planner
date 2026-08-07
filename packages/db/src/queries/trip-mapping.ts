import { and, eq, gte, lte, ne } from "drizzle-orm";
import type { Db } from "../client.js";
import { tripMapping } from "../schema.js";

/**
 * Does `trainUid` run on `serviceDate`, per trip_mapping's day-of-week /
 * date-range / STP rules? This is the train_uid-first mirror of the gtfsTripId
 * lookup services/darwin-ingest/src/precompute.ts already does when resolving
 * a routing-engine plan — used here both by the web app (pinning a service:
 * does it run on a future day-of-week?) and by darwin-ingest (nightly
 * revalidation of already-pinned services), so the rule set lives once.
 *
 * A train_uid can have several trip_mapping rows over time (permanent +
 * overlay schedules from different timetable versions) — this returns the one
 * whose validity window covers serviceDate and whose daysMask bit is set for
 * dayOfWeek, ignoring STP-cancelled ('C') rows.
 */
export async function tripMappingForUid(
  db: Db,
  trainUid: string,
  serviceDate: string,
  dayOfWeek: number,
): Promise<{ gtfsTripId: string; daysMask: number; stpIndicator: string } | null> {
  const dowBit = 1 << dayOfWeek;
  const rows = await db
    .select({
      gtfsTripId: tripMapping.gtfsTripId,
      daysMask: tripMapping.daysMask,
      stpIndicator: tripMapping.stpIndicator,
    })
    .from(tripMapping)
    .where(
      and(
        eq(tripMapping.trainUid, trainUid),
        lte(tripMapping.dateRunsFrom, serviceDate),
        gte(tripMapping.dateRunsTo, serviceDate),
        ne(tripMapping.stpIndicator, "C"),
      ),
    );
  return rows.find((r) => (r.daysMask & dowBit) !== 0) ?? null;
}
