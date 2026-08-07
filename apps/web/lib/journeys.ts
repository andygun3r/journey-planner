import { createEngine, type RawItinerary, type RawLeg } from "@signaller/routing-adapter";
import { normaliseCrs, operatorFromRouteName, TFL_MODES } from "@signaller/shared";
import { geocodePostcode } from "./geocoding";
import { computeStitchedStatus } from "./journey-status";
import { type JourneyEndpoint, parseEndpoint } from "./journey-endpoint";
import { nearestStations, stationName } from "./stations";
import { journeyResults, lineStatus, tflConfigured, type TflJourney, type TflJourneyLeg } from "./tfl";
import { cachedStopPoint, nearestRailInterchange, nearestRailStationSmart } from "./tfl-stop-cache";

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
  /** Name of the first intermediate stop, when there is one — for "next stop" copy. */
  nextCallName?: string;
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
  /** Set when the destination was a geocoded postcode/coords that fell back to
   * "nearest station" (no TfL last-mile stitch available) — e.g. "≈750m from Victoria". */
  destinationWalkNote?: string;
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
    nextCallName: leg.intermediateCalls[0]?.name,
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
 * Rail (fromCrs) + TfL last-mile leg to a TfL destination point (a real
 * NaPTAN id, or a raw "lat,lon" string TfL's JourneyResults endpoint also
 * accepts as a `to`). Shared by the NaPTAN-destination path and the
 * geocoded-postcode/coords-destination path in planFlexible.
 */
async function stitchRailToTflPoint(
  fromCrs: string,
  interchangeCrs: string,
  interchangeNaptanId: string,
  tflDestId: string,
  when: string | undefined,
): Promise<PlanOutcome> {
  const engine = createEngine();
  let railItineraries: RawItinerary[];
  try {
    railItineraries = await engine.plan({
      from: fromCrs,
      to: interchangeCrs,
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
    const tflJourneys = await journeyResults(interchangeNaptanId, tflDestId, {
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

/**
 * Attach a "≈Xm from <station>" note to every journey in an outcome — used
 * when a coords/postcode destination falls back to "nearest station" (no TfL
 * stitching available or configured) so the walking gap is stated honestly
 * rather than silently absorbed into the destination label.
 */
function withWalkNote(outcome: PlanOutcome, distanceMeters: number, stationLabel: string): PlanOutcome {
  if (!outcome.ok) return outcome;
  const note =
    distanceMeters < 1000
      ? `≈${Math.round(distanceMeters / 50) * 50}m from ${stationLabel}`
      : `≈${(distanceMeters / 1000).toFixed(1)}km from ${stationLabel}`;
  return { ...outcome, journeys: outcome.journeys.map((j) => ({ ...j, destinationWalkNote: note })) };
}

export interface FlexiblePlanOutcome {
  outcome: PlanOutcome;
  fromLabel?: string;
  toLabel?: string;
}

/**
 * Resolve a JourneyEndpoint down to a routable CRS, trying TfL-aware nearest-
 * station resolution for coords/postcode endpoints. Returns null (with a
 * PlanOutcome failure reason) when resolution isn't possible.
 */
async function resolveToCrs(
  endpoint: JourneyEndpoint,
): Promise<{ crs: string; label: string } | { error: PlanOutcome }> {
  if (endpoint.type === "crs") return { crs: endpoint.crs, label: await stationName(endpoint.crs) };

  if (endpoint.type === "geo") {
    const nearest = await nearestRailStationSmart(endpoint.lat, endpoint.lon);
    if (!nearest) return { error: { ok: false, reason: "no-journeys" } };
    return { crs: nearest.crs, label: nearest.name };
  }

  if (endpoint.type === "postcode") {
    const geo = await geocodePostcode(endpoint.text);
    if (!geo) return { error: { ok: false, reason: "bad-request" } };
    const nearest = await nearestRailStationSmart(geo.lat, geo.lon);
    if (!nearest) return { error: { ok: false, reason: "no-journeys" } };
    return { crs: nearest.crs, label: nearest.name };
  }

  // naptan endpoints resolve via cachedStopPoint, handled separately in planFlexible
  // (they may or may not carry a CRS directly) — not reached from here.
  return { error: { ok: false, reason: "bad-request" } };
}

/**
 * Plan a journey between two JourneyEndpoints — CRS, TfL NaPTAN, GPS coords,
 * or a geocoded postcode, in any combination. CRS-to-CRS stays on the cheap
 * planJourneys fast path untouched. A coords/postcode endpoint on either side
 * resolves to its nearest usable rail station (TfL-aware); when the
 * *destination* is coords/postcode and falls within TfL coverage, a real
 * walk/tube/bus last-mile leg is stitched on rather than just resolving to
 * the nearest station — outside TfL coverage (or if stitching fails) it
 * degrades to "nearest station" with a walking-distance note, never an error.
 */
export async function planFlexible(
  from: JourneyEndpoint,
  to: JourneyEndpoint,
  when?: string,
  arriveBy = false,
): Promise<FlexiblePlanOutcome> {
  // Fast path: identical to the original planJourneys entry point.
  if (from.type === "crs" && to.type === "crs") {
    const [fromLabel, toLabel] = await Promise.all([stationName(from.crs), stationName(to.crs)]);
    return { outcome: await planJourneys(from.crs, to.crs, when, arriveBy), fromLabel, toLabel };
  }

  // Existing NaPTAN-destination stitching path (CRS origin required), generalised
  // to also accept a geo/postcode origin below.
  if (to.type === "naptan") {
    const fromResolved = await resolveToCrs(from);
    if ("error" in fromResolved) return { outcome: fromResolved.error };

    const destPoint = await cachedStopPoint(to.naptanId);
    if (!destPoint) return { outcome: { ok: false, reason: "bad-request" } };

    if (destPoint.crs) {
      return {
        outcome: await planJourneys(fromResolved.crs, destPoint.crs, when, arriveBy),
        fromLabel: fromResolved.label,
        toLabel: await stationName(destPoint.crs),
      };
    }
    if (destPoint.lat === undefined || destPoint.lon === undefined) {
      return { outcome: { ok: false, reason: "no-journeys" } };
    }
    const interchange = await nearestRailInterchange(destPoint.lat, destPoint.lon);
    if (!interchange?.crs) return { outcome: { ok: false, reason: "no-journeys" } };

    return {
      outcome: await stitchRailToTflPoint(fromResolved.crs, interchange.crs, interchange.naptanId, to.naptanId, when),
      fromLabel: fromResolved.label,
      toLabel: destPoint.commonName,
    };
  }

  // Coords/postcode destination: try a real TfL last-mile stitch when in
  // coverage, else fall back to nearest-station with a distance note.
  if (to.type === "geo" || to.type === "postcode") {
    const fromResolved = await resolveToCrs(from);
    if ("error" in fromResolved) return { outcome: fromResolved.error };

    let destLat: number;
    let destLon: number;
    let toLabel: string;
    if (to.type === "geo") {
      destLat = to.lat;
      destLon = to.lon;
      toLabel = "your destination";
    } else {
      const geo = await geocodePostcode(to.text);
      if (!geo) return { outcome: { ok: false, reason: "bad-request" } };
      destLat = geo.lat;
      destLon = geo.lon;
      toLabel = geo.label;
    }

    if (tflConfigured()) {
      const interchange = await nearestRailInterchange(destLat, destLon);
      if (interchange?.crs) {
        const stitched = await stitchRailToTflPoint(
          fromResolved.crs,
          interchange.crs,
          interchange.naptanId,
          `${destLat},${destLon}`,
          when,
        );
        if (stitched.ok) return { outcome: stitched, fromLabel: fromResolved.label, toLabel };
        // Stitching found no usable TfL journeys — fall through to the plain
        // nearest-station fallback below rather than surfacing a hard error.
      }
    }

    const [nearest] = await nearestStations(destLat, destLon, 1);
    if (!nearest) return { outcome: { ok: false, reason: "no-journeys" } };
    const plain = await planJourneys(fromResolved.crs, nearest.crs, when, arriveBy);
    return {
      outcome: withWalkNote(plain, nearest.distanceMeters, nearest.name),
      fromLabel: fromResolved.label,
      toLabel,
    };
  }

  // Coords/postcode origin with a plain CRS destination.
  const fromResolved = await resolveToCrs(from);
  if ("error" in fromResolved) return { outcome: fromResolved.error };
  if (to.type !== "crs") return { outcome: { ok: false, reason: "bad-request" } };

  return {
    outcome: await planJourneys(fromResolved.crs, to.crs, when, arriveBy),
    fromLabel: fromResolved.label,
    toLabel: await stationName(to.crs),
  };
}

/**
 * String-keyed compat wrapper over planFlexible, preserving the original
 * planMultiModal API (CRS/NaPTAN in, PlanOutcome out) for existing callers —
 * apps/web/app/api/journeys/route.ts and anything else that doesn't need the
 * richer coords/postcode endpoints.
 */
export async function planMultiModal(
  from: string,
  to: string,
  when?: string,
  arriveBy = false,
): Promise<PlanOutcome> {
  const fromEndpoint = parseEndpoint(from);
  const toEndpoint = parseEndpoint(to);
  if (!fromEndpoint || !toEndpoint) return { ok: false, reason: "bad-request" };
  const { outcome } = await planFlexible(fromEndpoint, toEndpoint, when, arriveBy);
  return outcome;
}
