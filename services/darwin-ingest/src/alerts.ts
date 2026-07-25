import { alert, commute, commuteCorridor, commuteHoliday, createDb, device } from "@mainline/db";
import { isDateInHolidayRange } from "@mainline/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { ParsedSchedule, ParsedTS } from "./pushport.js";
import { sendPush } from "./push.js";

/**
 * Commute alert matching. When Darwin reports a cancellation or a significant
 * delay for a train, this checks whether that train (train_uid + scheduled
 * start date) is in any commute's precomputed corridor, and if so raises an
 * alert: an `alert` row (deduped), a Redis publish for the live feed/SSE, and a
 * Web Push to the device if it has a subscription.
 *
 * A small in-memory set of "uids we care about today/tomorrow" is refreshed
 * periodically so the vast majority of Darwin events (not on anyone's commute)
 * are dropped without touching the database.
 */

const db = createDb();

/** Minutes late before a delay is worth alerting on. */
const DELAY_THRESHOLD_MIN = 5;

let trackedUids = new Set<string>();
let trackedLoadedAt = 0;
const TRACKED_TTL_MS = 5 * 60_000;

async function ensureTrackedUids(): Promise<Set<string>> {
  if (trackedUids.size > 0 && Date.now() - trackedLoadedAt < TRACKED_TTL_MS) return trackedUids;
  const rows = await db
    .selectDistinct({ trainUid: commuteCorridor.trainUid })
    .from(commuteCorridor)
    .where(sql`${commuteCorridor.serviceDate} >= current_date`);
  trackedUids = new Set(rows.map((r) => r.trainUid));
  trackedLoadedAt = Date.now();
  return trackedUids;
}

/** Force a refresh — called right after a corridor precompute. */
export function invalidateTrackedUids(): void {
  trackedLoadedAt = 0;
}

interface MatchedCommute {
  commuteId: string;
  deviceId: string;
  commuteLabel: string;
  commuteLegId: string | null;
  direction: string | null;
  serviceDate: string;
  originCrs: string | null;
  destCrs: string | null;
  pushSubscription: unknown;
}

/** Corridors (with device + commute) that this train serves on this date. */
async function matchingCommutes(uid: string, ssd: string): Promise<MatchedCommute[]> {
  return db
    .select({
      commuteId: commuteCorridor.commuteId,
      deviceId: commute.deviceId,
      commuteLabel: commute.label,
      commuteLegId: commuteCorridor.commuteLegId,
      direction: commuteCorridor.direction,
      serviceDate: commuteCorridor.serviceDate,
      originCrs: commuteCorridor.originCrs,
      destCrs: commuteCorridor.destCrs,
      pushSubscription: device.pushSubscription,
    })
    .from(commuteCorridor)
    .innerJoin(commute, eq(commute.id, commuteCorridor.commuteId))
    .innerJoin(device, eq(device.id, commute.deviceId))
    .where(and(eq(commuteCorridor.trainUid, uid), eq(commuteCorridor.serviceDate, ssd)));
}

async function isDeviceOnHoliday(deviceId: string, date: string): Promise<boolean> {
  const rows = await db
    .select({ startDate: commuteHoliday.startDate, endDate: commuteHoliday.endDate })
    .from(commuteHoliday)
    .where(eq(commuteHoliday.deviceId, deviceId));
  return isDateInHolidayRange(date, rows);
}

interface RaiseArgs {
  match: MatchedCommute;
  kind: "cancellation" | "delay";
  rid: string;
  headline: string;
  detail?: string;
  redis: Redis | null;
}

/** Insert (deduped), publish, and push a single alert for one matched commute. */
async function raiseAlert({ match, kind, rid, headline, detail, redis }: RaiseArgs): Promise<void> {
  if (await isDeviceOnHoliday(match.deviceId, match.serviceDate)) return;

  const inserted = await db
    .insert(alert)
    .values({
      commuteId: match.commuteId,
      kind,
      ref: rid,
      commuteLegId: match.commuteLegId,
      direction: match.direction,
      serviceDate: match.serviceDate,
      headline,
      detail,
    })
    .onConflictDoNothing({
      target: [alert.commuteId, alert.ref, alert.kind, alert.serviceDate],
    })
    .returning({ id: alert.id });

  // Dedupe hit — already alerted for this train/commute/kind/date. Stop here so
  // we don't re-publish or re-push.
  if (inserted.length === 0) return;
  const alertId = inserted[0]!.id;

  const payload = {
    id: alertId,
    commuteId: match.commuteId,
    kind,
    headline,
    detail,
    direction: match.direction,
  };
  if (redis) {
    await redis.publish(`commute:alert:${match.deviceId}`, JSON.stringify(payload));
  }

  if (match.pushSubscription) {
    const failStatus = await sendPush(match.pushSubscription, {
      title: headline,
      body: detail ?? match.commuteLabel,
      url: "/commute",
      tag: `commute-${match.commuteId}-${match.serviceDate}`,
    });
    if (failStatus === 404 || failStatus === 410) {
      // Subscription is gone — clear it so we stop trying.
      await db
        .update(device)
        .set({ pushSubscription: null })
        .where(eq(device.id, match.deviceId));
    }
  }
}

/** A schedule update carrying a cancellation. */
export async function matchCancellation(sch: ParsedSchedule, redis: Redis | null): Promise<void> {
  if (!sch.cancelled) return;
  const tracked = await ensureTrackedUids();
  if (!tracked.has(sch.uid)) return;

  const matches = await matchingCommutes(sch.uid, sch.ssd);
  for (const match of matches) {
    const dir = match.direction === "pm" ? "evening" : "morning";
    await raiseAlert({
      match,
      kind: "cancellation",
      rid: sch.rid,
      headline: `Your ${dir} train is cancelled`,
      detail: sch.cancelReason ?? undefined,
      redis,
    });
  }
}

/** Largest delay (minutes) implied by a TS update's estimated vs working times. */
function maxDelayMinutes(ts: ParsedTS): number {
  let worst = 0;
  for (const s of ts.stops) {
    for (const [sched, est] of [
      [s.wtd, s.depEt],
      [s.wta, s.arrEt],
    ] as const) {
      if (!sched || !est) continue;
      const d = hhmmDeltaMinutes(sched, est);
      if (d !== null && d > worst) worst = d;
    }
  }
  return worst;
}

/** Minutes from a scheduled HH:MM[:SS] to an estimated HH:MM[:SS] (same day). */
function hhmmDeltaMinutes(sched: string, est: string): number | null {
  const s = toMinutes(sched);
  const e = toMinutes(est);
  if (s === null || e === null) return null;
  let delta = e - s;
  // Handle midnight wrap (est just after midnight, sched just before).
  if (delta < -720) delta += 1440;
  return delta;
}

function toMinutes(t: string): number | null {
  const m = /^(\d{2}):(\d{2})/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** A TS (train status) update — check for a significant delay. */
export async function matchDelay(ts: ParsedTS, redis: Redis | null): Promise<void> {
  const tracked = await ensureTrackedUids();
  if (!tracked.has(ts.uid)) return;

  const delay = maxDelayMinutes(ts);
  if (delay < DELAY_THRESHOLD_MIN) return;

  const matches = await matchingCommutes(ts.uid, ts.ssd);
  for (const match of matches) {
    const dir = match.direction === "pm" ? "evening" : "morning";
    await raiseAlert({
      match,
      kind: "delay",
      rid: ts.rid,
      headline: `Your ${dir} train is delayed ${delay} min`,
      detail: ts.lateReason ?? undefined,
      redis,
    });
  }
}
