import {
  alert,
  commute,
  commuteCorridor,
  commuteLeg,
  commuteLegPin,
  darwinStopForecast,
  darwinTrain,
  getSharedDb,
  user,
} from "@signaller/db";
import { londonDate, londonDayOfWeek, londonTime, parseHhmm } from "@signaller/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { DELAY_THRESHOLD_MIN, isUserOnHoliday, publishAndPush } from "./alerts.js";
import { hhmmDeltaMinutes } from "./train-status.js";

/**
 * Pre-departure digest: ~30-45 minutes before a commute leg's AM/PM window
 * opens, push its current status — "On time", "Delayed N min", or
 * "Cancelled" — even when there's nothing wrong. One push per
 * commute/direction/day (see the alert dedupe key below), gated by
 * `pushPreDeparture`. Runs every 2 minutes from index.ts.
 *
 * "Their usual train" is whichever of these resolves first for today:
 *   1. A pinned service (commute_leg_pin) for this leg/direction.
 *   2. The earliest train in the leg's precomputed corridor (commute_corridor).
 * If neither exists yet (precompute hasn't run, or the leg has no coverage
 * today), this skips silently rather than fabricating an "all clear".
 */

const db = getSharedDb();

/** Minutes before window-open this digest should fire (a 15-minute band). */
const LOOKAHEAD_MIN_LOW = 30;
const LOOKAHEAD_MIN_HIGH = 45;

interface DueLeg {
  commuteId: string;
  legId: string;
  userId: string;
  commuteLabel: string;
  pushSubscription: unknown;
  pushPreDeparture: boolean;
  direction: "am" | "pm";
}

/** Commute legs (with owner) whose AM or PM window opens 30-45 min from now, today. */
async function dueLegs(): Promise<DueLeg[]> {
  const dow = londonDayOfWeek();
  const nowMin = parseHhmm(londonTime());
  if (nowMin === null) return [];

  const rows = await db
    .select({
      commuteId: commute.id,
      legId: commuteLeg.id,
      userId: commute.userId,
      commuteLabel: commute.label,
      pushSubscription: user.pushSubscription,
      pushPreDeparture: user.pushPreDeparture,
      amWindowStart: commuteLeg.amWindowStart,
      pmWindowStart: commuteLeg.pmWindowStart,
    })
    .from(commuteLeg)
    .innerJoin(commute, eq(commute.id, commuteLeg.commuteId))
    .innerJoin(user, eq(user.id, commute.userId))
    .where(eq(commuteLeg.dayOfWeek, dow));

  const due: DueLeg[] = [];
  for (const row of rows) {
    for (const [direction, windowStart] of [
      ["am", row.amWindowStart],
      ["pm", row.pmWindowStart],
    ] as const) {
      if (!windowStart) continue;
      const startMin = parseHhmm(windowStart);
      if (startMin === null) continue;
      const aheadBy = startMin - nowMin;
      if (aheadBy < LOOKAHEAD_MIN_LOW || aheadBy > LOOKAHEAD_MIN_HIGH) continue;
      due.push({
        commuteId: row.commuteId,
        legId: row.legId,
        userId: row.userId,
        commuteLabel: row.commuteLabel,
        pushSubscription: row.pushSubscription,
        pushPreDeparture: row.pushPreDeparture,
        direction,
      });
    }
  }
  return due;
}

interface UsualTrain {
  trainUid: string;
  originCrs: string;
}

/** Resolve "their usual train" for one leg/direction today: pin first, else earliest corridor row. */
async function resolveUsualTrain(legId: string, direction: "am" | "pm", serviceDate: string): Promise<UsualTrain | null> {
  const pins = await db
    .select({ trainUid: commuteLegPin.trainUid, originCrs: commuteLegPin.originCrs })
    .from(commuteLegPin)
    .where(and(eq(commuteLegPin.commuteLegId, legId), eq(commuteLegPin.direction, direction)))
    .orderBy(asc(commuteLegPin.sequence))
    .limit(1);
  if (pins[0]) return pins[0];

  const corridor = await db
    .select({ trainUid: commuteCorridor.trainUid, originCrs: commuteCorridor.originCrs })
    .from(commuteCorridor)
    .where(
      and(
        eq(commuteCorridor.commuteLegId, legId),
        eq(commuteCorridor.direction, direction),
        eq(commuteCorridor.serviceDate, serviceDate),
      ),
    )
    .orderBy(asc(commuteCorridor.schedDep))
    .limit(1);
  if (!corridor[0] || !corridor[0].originCrs) return null;
  return { trainUid: corridor[0].trainUid, originCrs: corridor[0].originCrs };
}

interface TrainStatus {
  cancelled: boolean;
  cancelReason: string | null;
  delayMinutes: number;
}

/** Today's live status for a train_uid at its origin CRS, or null if Darwin has no schedule for it yet. */
async function statusFor(uid: string, originCrs: string, serviceDate: string): Promise<TrainStatus | null> {
  const trains = await db
    .select({ rid: darwinTrain.rid, cancelled: darwinTrain.cancelled, cancelReason: darwinTrain.cancelReason })
    .from(darwinTrain)
    .where(and(eq(darwinTrain.uid, uid), eq(darwinTrain.ssd, serviceDate)))
    .limit(1);
  const train = trains[0];
  if (!train) return null;

  if (train.cancelled) {
    return { cancelled: true, cancelReason: train.cancelReason, delayMinutes: 0 };
  }

  const stops = await db
    .select({ schedDep: darwinStopForecast.schedDep, estDep: darwinStopForecast.estDep })
    .from(darwinStopForecast)
    .where(and(eq(darwinStopForecast.rid, train.rid), eq(darwinStopForecast.crs, originCrs)))
    .limit(1);
  const stop = stops[0];
  const delay =
    stop?.schedDep && stop?.estDep ? (hhmmDeltaMinutes(stop.schedDep, stop.estDep) ?? 0) : 0;
  return { cancelled: false, cancelReason: null, delayMinutes: Math.max(0, delay) };
}

function headlineFor(status: TrainStatus, dirWord: string): { headline: string; detail?: string } {
  if (status.cancelled) {
    return {
      headline: `Your ${dirWord} train is cancelled`,
      detail: status.cancelReason ?? undefined,
    };
  }
  if (status.delayMinutes >= DELAY_THRESHOLD_MIN) {
    return { headline: `Your ${dirWord} train is delayed ${status.delayMinutes} min` };
  }
  return { headline: `Your ${dirWord} train is on time` };
}

/** One digest run: check every due leg and push its current status. */
export async function runPreDepartureDigest(redis: Redis | null): Promise<void> {
  const legs = await dueLegs();
  if (legs.length === 0) return;

  const serviceDate = londonDate();
  for (const leg of legs) {
    if (await isUserOnHoliday(leg.userId, serviceDate)) continue;

    const usual = await resolveUsualTrain(leg.legId, leg.direction, serviceDate);
    if (!usual) continue; // no pin, no corridor coverage yet — skip, don't fabricate

    const status = await statusFor(usual.trainUid, usual.originCrs, serviceDate);
    if (!status) continue; // Darwin hasn't sent today's schedule for this train yet

    const dirWord = leg.direction === "pm" ? "evening" : "morning";
    const { headline, detail } = headlineFor(status, dirWord);

    const inserted = await db
      .insert(alert)
      .values({
        commuteId: leg.commuteId,
        kind: "pre_departure",
        ref: leg.direction,
        commuteLegId: leg.legId,
        direction: leg.direction,
        serviceDate,
        headline,
        detail,
      })
      .onConflictDoNothing({
        target: [alert.commuteId, alert.ref, alert.kind, alert.serviceDate],
      })
      .returning({ id: alert.id });

    if (inserted.length === 0) continue; // already sent today's digest for this leg/direction

    await publishAndPush({
      alertId: inserted[0]!.id,
      commuteId: leg.commuteId,
      userId: leg.userId,
      commuteLabel: leg.commuteLabel,
      kind: "pre_departure",
      headline,
      detail,
      direction: leg.direction,
      serviceDate,
      pushSubscription: leg.pushSubscription,
      category: "pre_departure",
      categoryEnabled: leg.pushPreDeparture,
      redis,
    });
  }
}
