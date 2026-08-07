import { darwinTrain, getSharedDb, tripMappingForUid } from "@signaller/db";
import type { CommuteLegPinRecord } from "@signaller/shared";
import { londonWallTimeToIso } from "@signaller/shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import type { JourneyLegView, JourneyView } from "./journeys";
import { stopForecastLegView } from "./service-details";

/**
 * Turns a commute leg's pinned services into a JourneyView-shaped result for
 * TODAY, using live Darwin data where available. CommutePanel (and the leg
 * cards it renders) consume a plain JourneyView and don't know or care how
 * it was produced — this is the only file that needs to know pins exist.
 */

export type PinnedJourneyOutcome =
  | { ok: true; journey: JourneyView }
  | { ok: false; reason: "pin-stale" | "no-data" };

function minutesLate(scheduled: string, live?: string): number | undefined {
  if (!live) return undefined;
  const delta = Math.round((Date.parse(live) - Date.parse(scheduled)) / 60_000);
  return Number.isFinite(delta) ? delta : undefined;
}

/** Placeholder leg from the pin's own scheduled times — used before Darwin has spoken today. */
function scheduledLegView(pin: CommuteLegPinRecord, serviceDate: string): JourneyLegView {
  return {
    mode: "rail",
    originCrs: pin.originCrs,
    originName: pin.originLabel,
    destCrs: pin.destCrs,
    destName: pin.destLabel,
    departs: londonWallTimeToIso(serviceDate, pin.schedDep),
    arrives: londonWallTimeToIso(serviceDate, pin.schedArr),
    operator: pin.toc ?? undefined,
    staySeated: false,
    cancelled: false,
    callCount: 0,
  };
}

/**
 * Builds a JourneyView for one direction's pinned legs on `serviceDate`
 * (today). Returns `pin-stale` the moment any pin fails trip_mapping
 * revalidation for today (decision: alert, never silently fall back without
 * telling the user — the caller does the operational fallback).
 */
export async function buildPinnedJourney(
  pins: CommuteLegPinRecord[], // one direction, sequence-ordered
  dayOfWeek: number,
  serviceDate: string,
): Promise<PinnedJourneyOutcome> {
  if (pins.length === 0) return { ok: false, reason: "no-data" };

  const sharedDb = getSharedDb();
  const db = getDb();
  const legs: JourneyLegView[] = [];

  for (const pin of pins) {
    const mapping = await tripMappingForUid(sharedDb, pin.trainUid, serviceDate, dayOfWeek);
    if (!mapping) return { ok: false, reason: "pin-stale" };

    // Today's rid for this train_uid, if Darwin has broadcast a Schedule yet
    // — bounded to this specific service date, mirroring darwin_train's
    // (uid, ssd) index, so an older run of the same recurring uid can't match.
    const trainRows = await db
      .select({ rid: darwinTrain.rid })
      .from(darwinTrain)
      .where(and(eq(darwinTrain.uid, pin.trainUid), eq(darwinTrain.ssd, serviceDate)))
      .limit(1);
    const todayRid = trainRows[0]?.rid;

    let legView: JourneyLegView | null = null;
    if (todayRid) {
      legView = await stopForecastLegView(todayRid, pin.originCrs, pin.destCrs).catch(() => null);
    }
    legs.push(legView ?? scheduledLegView(pin, serviceDate));
  }

  if (legs.length === 0) return { ok: false, reason: "no-data" };

  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const firstPin = pins[0]!;
  const lastPin = pins[pins.length - 1]!;

  const scheduledDeparts = londonWallTimeToIso(serviceDate, firstPin.schedDep);
  const scheduledArrives = londonWallTimeToIso(serviceDate, lastPin.schedArr);
  const liveDeparts = first.departs !== scheduledDeparts ? first.departs : undefined;
  const liveArrives = last.arrives !== scheduledArrives ? last.arrives : undefined;
  const delay = minutesLate(scheduledArrives, liveArrives);
  const cancelled = legs.some((l) => l.cancelled);

  let status: JourneyView["status"] = "scheduled";
  if (cancelled) status = "cancelled";
  else if (delay !== undefined) status = delay > 1 ? "delayed" : "on-time";

  const durationMinutes = Math.round((Date.parse(scheduledArrives) - Date.parse(scheduledDeparts)) / 60_000);

  return {
    ok: true,
    journey: {
      id: `pinned-${firstPin.trainUid}-${serviceDate}`,
      departs: scheduledDeparts,
      arrives: scheduledArrives,
      liveDeparts,
      liveArrives,
      durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 0,
      changes: Math.max(legs.length - 1, 0),
      status,
      delayMinutes: delay !== undefined && delay > 1 ? delay : undefined,
      legs,
    },
  };
}
