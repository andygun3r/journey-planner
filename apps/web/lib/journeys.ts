import { createEngine, type RawItinerary, type RawLeg } from "@mainline/routing-adapter";
import { normaliseCrs, operatorFromRouteName } from "@mainline/shared";
import { stationName } from "./stations";

/** View models for the results UI (pre-Darwin: engine data only). */
export interface JourneyLegView {
  mode: "rail" | "walk";
  originName: string;
  originCrs: string;
  destName: string;
  destCrs: string;
  departs: string;
  arrives: string;
  operator?: string;
  staySeated: boolean;
  cancelled: boolean;
  callCount: number;
}

export interface JourneyView {
  id: string;
  departs: string;
  arrives: string;
  liveDeparts?: string;
  liveArrives?: string;
  durationMinutes: number;
  changes: number;
  status: "on-time" | "delayed" | "cancelled" | "scheduled";
  delayMinutes?: number;
  legs: JourneyLegView[];
}

export type PlanOutcome =
  | { ok: true; journeys: JourneyView[] }
  | { ok: false; reason: "engine-offline" | "no-journeys" | "bad-request" };

function minutesLate(scheduled: string, live?: string): number | undefined {
  if (!live) return undefined;
  const delta = Math.round((Date.parse(live) - Date.parse(scheduled)) / 60000);
  return Number.isFinite(delta) ? delta : undefined;
}

async function toLegView(leg: RawLeg): Promise<JourneyLegView> {
  return {
    mode: leg.mode,
    originCrs: leg.origin.stopId,
    originName: (await stationName(leg.origin.stopId)) || leg.origin.name,
    destCrs: leg.destination.stopId,
    destName: (await stationName(leg.destination.stopId)) || leg.destination.name,
    departs: leg.origin.live ?? leg.origin.scheduled,
    arrives: leg.destination.live ?? leg.destination.scheduled,
    operator: operatorFromRouteName(leg.routeName),
    staySeated: leg.staySeated,
    cancelled: leg.cancelled,
    callCount: leg.intermediateCalls.length,
  };
}

async function toJourneyView(it: RawItinerary, index: number): Promise<JourneyView> {
  const rail = it.legs.filter((l) => l.mode === "rail");
  const first = it.legs[0]!;
  const last = it.legs[it.legs.length - 1]!;
  const liveDeparts = first.origin.live;
  const liveArrives = last.destination.live;
  const delay = minutesLate(last.destination.scheduled, liveArrives);
  const cancelled = rail.some((l) => l.cancelled);

  let status: JourneyView["status"] = "scheduled";
  if (cancelled) status = "cancelled";
  else if (delay !== undefined) status = delay > 1 ? "delayed" : "on-time";

  return {
    id: `${index}-${it.departs}`,
    departs: first.origin.scheduled,
    arrives: last.destination.scheduled,
    liveDeparts,
    liveArrives,
    durationMinutes: Math.round(it.durationSeconds / 60),
    changes: Math.max(rail.filter((l) => !l.staySeated).length - 1, 0),
    status,
    delayMinutes: delay !== undefined && delay > 1 ? delay : undefined,
    legs: await Promise.all(it.legs.map(toLegView)),
  };
}

export async function planJourneys(
  from: string,
  to: string,
  when?: string,
  arriveBy = false,
): Promise<PlanOutcome> {
  let fromCrs: string;
  let toCrs: string;
  try {
    fromCrs = normaliseCrs(from);
    toCrs = normaliseCrs(to);
  } catch {
    return { ok: false, reason: "bad-request" };
  }

  const engine = createEngine();
  let itineraries: RawItinerary[];
  try {
    itineraries = await engine.plan({
      from: fromCrs,
      to: toCrs,
      when,
      arriveBy,
      numItineraries: 6,
    });
  } catch {
    return { ok: false, reason: "engine-offline" };
  }

  if (itineraries.length === 0) return { ok: false, reason: "no-journeys" };
  return {
    ok: true,
    journeys: await Promise.all(itineraries.map(toJourneyView)),
  };
}
