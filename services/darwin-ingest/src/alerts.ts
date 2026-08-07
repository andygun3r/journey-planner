import { alert, commute, commuteCorridor, commuteHoliday, getSharedDb, user } from "@signaller/db";
import { isDateInHolidayRange } from "@signaller/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { ParsedSchedule, ParsedTS } from "./pushport.js";
import { sendPush } from "./push.js";
import { hhmmDeltaMinutes } from "./train-status.js";

/**
 * Commute alert matching. When Darwin reports a cancellation or a significant
 * delay for a train, this checks whether that train (train_uid + scheduled
 * start date) is in any commute's precomputed corridor, and if so raises an
 * alert: an `alert` row (deduped), a Redis publish for the live feed/SSE, and a
 * Web Push to the user if they have a subscription.
 *
 * A small in-memory set of "uids we care about today/tomorrow" is refreshed
 * periodically so the vast majority of Darwin events (not on anyone's commute)
 * are dropped without touching the database.
 */

const db = getSharedDb();

/** Minutes late before a delay is worth alerting on. */
export const DELAY_THRESHOLD_MIN = 5;

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
  userId: string;
  commuteLabel: string;
  commuteLegId: string | null;
  direction: string | null;
  serviceDate: string;
  originCrs: string | null;
  destCrs: string | null;
  pushSubscription: unknown;
  pushCommuteDisruptions: boolean;
}

/** Corridors (with owning user + commute) that this train serves on this date. */
async function matchingCommutes(uid: string, ssd: string): Promise<MatchedCommute[]> {
  return db
    .select({
      commuteId: commuteCorridor.commuteId,
      userId: commute.userId,
      commuteLabel: commute.label,
      commuteLegId: commuteCorridor.commuteLegId,
      direction: commuteCorridor.direction,
      serviceDate: commuteCorridor.serviceDate,
      originCrs: commuteCorridor.originCrs,
      destCrs: commuteCorridor.destCrs,
      pushSubscription: user.pushSubscription,
      pushCommuteDisruptions: user.pushCommuteDisruptions,
    })
    .from(commuteCorridor)
    .innerJoin(commute, eq(commute.id, commuteCorridor.commuteId))
    .innerJoin(user, eq(user.id, commute.userId))
    .where(and(eq(commuteCorridor.trainUid, uid), eq(commuteCorridor.serviceDate, ssd)));
}

/** Skip alerting for a user's holiday date ranges — shared by every alert producer. */
export async function isUserOnHoliday(userId: string, date: string): Promise<boolean> {
  const rows = await db
    .select({ startDate: commuteHoliday.startDate, endDate: commuteHoliday.endDate })
    .from(commuteHoliday)
    .where(eq(commuteHoliday.userId, userId));
  return isDateInHolidayRange(date, rows);
}

/** Which push-preference column gates a given alert. */
export type AlertCategory = "commute" | "pre_departure" | "network";

export interface PublishAndPushArgs {
  alertId: string;
  commuteId: string;
  userId: string;
  commuteLabel: string;
  kind: string;
  headline: string;
  detail?: string;
  direction: string | null;
  serviceDate: string;
  pushSubscription: unknown;
  /** Which category this alert belongs to, for the categoryEnabled gate below. */
  category: AlertCategory;
  /** The user's opt-in for `category` — resolved by the caller from its own user join. */
  categoryEnabled: boolean;
  redis: Redis | null;
}

/**
 * Redis-publish + Web Push for one already-inserted alert row (the dedupe
 * insert itself is the caller's job — this is the generic notify tail,
 * shared by raiseAlert (live Darwin events, matched via commute_corridor),
 * raisePinStaleAlerts (precompute.ts, a stale pin has no corridor row to
 * join from, so it inserts directly and calls this with commuteId/userId it
 * already has on hand), and the pre-departure/network-disruption producers.
 *
 * The Redis publish (in-app SSE feed) always fires — a user sees every alert
 * they're eligible for on-screen regardless of push preference. Only the Web
 * Push send is gated by categoryEnabled: that's the "push out of the
 * browser" opt-in, not a filter on what's shown in-app.
 */
export async function publishAndPush({
  alertId,
  commuteId,
  userId,
  commuteLabel,
  kind,
  headline,
  detail,
  direction,
  serviceDate,
  pushSubscription,
  category,
  categoryEnabled,
  redis,
}: PublishAndPushArgs): Promise<void> {
  const payload = { id: alertId, commuteId, kind, headline, detail, direction };
  if (redis) {
    await redis.publish(`commute:alert:${userId}`, JSON.stringify(payload));
  }

  if (pushSubscription && categoryEnabled) {
    const failStatus = await sendPush(pushSubscription, {
      title: headline,
      body: detail ?? commuteLabel,
      url: "/commute",
      tag: `commute-${commuteId}-${serviceDate}`,
    });
    if (failStatus === 404 || failStatus === 410) {
      // Subscription is gone — clear it so we stop trying.
      await db.update(user).set({ pushSubscription: null }).where(eq(user.id, userId));
    }
  }
  void category; // reserved for future per-category diagnostics/metrics
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
  if (await isUserOnHoliday(match.userId, match.serviceDate)) return;

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

  await publishAndPush({
    alertId: inserted[0]!.id,
    commuteId: match.commuteId,
    userId: match.userId,
    commuteLabel: match.commuteLabel,
    kind,
    headline,
    detail,
    direction: match.direction,
    serviceDate: match.serviceDate,
    pushSubscription: match.pushSubscription,
    category: "commute",
    categoryEnabled: match.pushCommuteDisruptions,
    redis,
  });
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
