import { createEngine, type RawItinerary, type RawLeg } from "@signaller/routing-adapter";
import { isCrs, isNaptanId, normaliseCrs, operatorFromRouteName, TFL_MODES } from "@signaller/shared";
import { computeStitchedStatus } from "./journey-status";
import { stationName } from "./stations";
import { journeyResults, lineStatus, type TflJourney, type TflJourneyLeg } from "./tfl";
import { cachedStopPoint, nearestRailInterchange } from "./tfl-stop-cache";

/** View models for the results UI (pre-Darwin: engine data only). */
export interface JourneyLegView {
  mode: "rail" | "walk" | (typeof TFL_MODES)[number];
  originName: string;
  /** CRS for a rail leg, NaPTAN id for a TfL leg. */
  originCrs: string;
  destName: string;
  /** CRS for a rail leg, NaPTAN id for a TfL leg. */
  destCrs: string;
  departs: string;
  arrives: string;
  operator?: string;
  lineId?: string;
  lineName?: string;
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

// ---------------------------------------------------------------------------
// Multi-modal (rail + TfL) planning
// ---------------------------------------------------------------------------

const TFL_MODE_QUERY = [...TFL_MODES];

function tflLegView(leg: TflJourneyLeg): JourneyLegView {
  return {
    mode: (TFL_MODES as readonly string[]).includes(leg.mode)
      ? (leg.mode as JourneyLegView["mode"])
      : "walk",
    originName: leg.departurePoint.name,
    originCrs: leg.departurePoint.naptanId ?? "",
    destName: leg.arrivalPoint.name,
    destCrs: leg.arrivalPoint.naptanId ?? "",
    departs: leg.departureTime ?? "",
    arrives: leg.arrivalTime ?? "",
    lineId: leg.lineId,
    lineName: leg.lineName,
    staySeated: false,
    cancelled: false,
    callCount: 0,
  };
}

/** Best-N by arrival time, cheapest way to keep the rail x TfL pairing from blowing up. */
function topN<T>(items: T[], n: number): T[] {
  return items.slice(0, n);
}

async function toStitchedJourneyView(
  index: number,
  railItinerary: RawItinerary,
  tflJourney: TflJourney,
  tflSeverity: number,
): Promise<JourneyView> {
  const railLegs = await Promise.all(railItinerary.legs.map(toLegView));
  const tflLegs = tflJourney.legs.map(tflLegView);

  const railLastCall = railItinerary.legs[railItinerary.legs.length - 1]!.destination;
  const tflFirstLeg = tflJourney.legs[0];
  const scheduledBufferMinutes =
    tflFirstLeg?.departureTime && railLastCall.scheduled
      ? Math.round(
          (Date.parse(tflFirstLeg.departureTime) - Date.parse(railLastCall.scheduled)) / 60000,
        )
      : 10; // unknown-but-plausible default; avoids a false "disrupted" from a missing timestamp

  const railCancelled = railItinerary.legs.some((l) => l.cancelled);
  const tflCancelled = tflJourney.legs.some((l) => l.isDisrupted && l.instruction?.match(/closed/i));

  const { status, delayMinutes } = computeStitchedStatus({
    railCancelled,
    tflCancelled: Boolean(tflCancelled),
    railScheduledArrival: railLastCall.scheduled,
    railLiveArrival: railLastCall.live,
    scheduledBufferMinutes,
    tflLineSeverity: tflSeverity,
  });

  const legs = [...railLegs, ...tflLegs];
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const departsIso = railItinerary.legs[0]!.origin.scheduled;
  const arrivesIso = tflJourney.arrivalDateTime ?? last.arrives;

  return {
    id: `stitched-${index}-${departsIso}`,
    departs: departsIso,
    arrives: arrivesIso,
    liveDeparts: first.mode === "rail" ? railItinerary.legs[0]!.origin.live : undefined,
    liveArrives: undefined,
    durationMinutes:
      arrivesIso && departsIso
        ? Math.round((Date.parse(arrivesIso) - Date.parse(departsIso)) / 60000)
        : Math.round(railItinerary.durationSeconds / 60),
    changes: Math.max(legs.length - 1, 0),
    status: status === "on-time" ? "on-time" : status === "disrupted" ? "delayed" : status,
    delayMinutes,
    legs,
  };
}

/**
 * Plan a journey that may need a TfL leg: either endpoint given as a NaPTAN id
 * (rather than a bare CRS) triggers stitching. CRS-to-CRS requests are always
 * MOTIS-only — National Rail stations are always MOTIS-reachable from each
 * other, so a rail-only request never needs to consult TfL at all.
 */
export async function planMultiModal(
  from: string,
  to: string,
  when?: string,
  arriveBy = false,
): Promise<PlanOutcome> {
  const fromIsNaptan = isNaptanId(from) && !isCrs(from);
  const toIsNaptan = isNaptanId(to) && !isCrs(to);

  if (!fromIsNaptan && !toIsNaptan) {
    return planJourneys(from, to, when, arriveBy);
  }

  // v1 only supports a rail-leg-then-TfL-leg shape (CRS origin, NaPTAN destination).
  // A NaPTAN origin (TfL-then-rail) or NaPTAN-to-NaPTAN request is out of scope.
  if (fromIsNaptan || !isCrs(from)) {
    return { ok: false, reason: "bad-request" };
  }

  const fromCrs = normaliseCrs(from);
  const destPoint = await cachedStopPoint(to);
  if (!destPoint) return { ok: false, reason: "bad-request" };

  // Destination is itself a rail interchange — no TfL leg needed, plan as rail-only.
  if (destPoint.crs) {
    return planJourneys(fromCrs, destPoint.crs, when, arriveBy);
  }

  if (destPoint.lat === undefined || destPoint.lon === undefined) {
    return { ok: false, reason: "no-journeys" };
  }

  const interchange = await nearestRailInterchange(destPoint.lat, destPoint.lon);
  if (!interchange?.crs) {
    return { ok: false, reason: "no-journeys" };
  }

  const engine = createEngine();
  let railItineraries: RawItinerary[];
  try {
    railItineraries = await engine.plan({
      from: fromCrs,
      to: interchange.crs,
      when,
      arriveBy: false, // arriveBy is resolved against the final destination, not the interchange
      numItineraries: 6,
    });
  } catch {
    return { ok: false, reason: "engine-offline" };
  }
  if (railItineraries.length === 0) return { ok: false, reason: "no-journeys" };

  const [severities] = await Promise.all([lineStatus(TFL_MODE_QUERY)]);
  const worstSeverity = severities.length > 0 ? Math.min(...severities.map((s) => s.statusSeverity)) : 10;

  const bestRail = topN(railItineraries, 3);
  const stitched: JourneyView[] = [];
  for (const [i, railItinerary] of bestRail.entries()) {
    const railArrival = railItinerary.legs[railItinerary.legs.length - 1]!.destination.scheduled;
    const tflJourneys = await journeyResults(interchange.naptanId, to, {
      when: railArrival,
      arriveBy: false,
    });
    for (const tflJourney of topN(tflJourneys, 2)) {
      stitched.push(await toStitchedJourneyView(i, railItinerary, tflJourney, worstSeverity));
    }
  }

  if (stitched.length === 0) return { ok: false, reason: "no-journeys" };
  stitched.sort((a, b) => Date.parse(a.arrives) - Date.parse(b.arrives));
  return { ok: true, journeys: topN(stitched, 6) };
}
