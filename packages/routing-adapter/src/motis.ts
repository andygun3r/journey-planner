import { z } from "zod";
import type {
  DepartureBoardQuery,
  PlanPlace,
  PlanQuery,
  RawDeparture,
  RawItinerary,
  RawLeg,
  RoutingEngine,
} from "./types.js";

/**
 * MOTIS v2 REST client (nigiri). The response schemas below follow the MOTIS
 * v2 OpenAPI plan/stoptimes shape but are deliberately tolerant (passthrough,
 * optional fields) — exact field names are VERIFIED IN P1 against the pinned
 * MOTIS release, and this file is where any drift gets fixed.
 */

const MotisPlace = z
  .object({
    stopId: z.string().optional(),
    name: z.string().default(""),
    departure: z.string().optional(),
    arrival: z.string().optional(),
    scheduledDeparture: z.string().optional(),
    scheduledArrival: z.string().optional(),
    /** Platform / track code; MOTIS surfaces the GTFS platform_code here. */
    description: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
  })
  .loose();

/**
 * MOTIS returns leg shapes as an encoded polyline (the Google format), with a
 * `precision` telling us the decimal places used — 5 in the classic format, but
 * MOTIS commonly emits 6, so never assume.
 */
const MotisLegGeometry = z
  .object({
    points: z.string(),
    precision: z.number().default(5),
  })
  .loose();

const MotisLeg = z
  .object({
    mode: z.string(),
    from: MotisPlace,
    to: MotisPlace,
    tripId: z.string().optional(),
    routeShortName: z.string().optional(),
    headsign: z.string().optional(),
    intermediateStops: z.array(MotisPlace).default([]),
    legGeometry: MotisLegGeometry.optional(),
    /** Metres walked/cycled — MOTIS sets this on street legs. */
    distance: z.number().optional(),
    /** Leg duration in seconds. */
    duration: z.number().optional(),
    interlineWithPreviousLeg: z.boolean().default(false),
    cancelled: z.boolean().default(false),
    realTime: z.boolean().default(false),
  })
  .loose();

const MotisItinerary = z
  .object({
    legs: z.array(MotisLeg),
    startTime: z.string(),
    endTime: z.string(),
    duration: z.number(),
    transfers: z.number().default(0),
  })
  .loose();

const MotisPlanResponse = z.object({ itineraries: z.array(MotisItinerary) }).loose();

const MotisStopTime = z
  .object({
    tripId: z.string().optional(),
    routeShortName: z.string().optional(),
    headsign: z.string().optional(),
    place: MotisPlace,
    /** Originating stop of this trip — the arrival board's "origin". */
    tripFrom: MotisPlace.optional(),
    /** Terminating stop of this trip — the board's "destination". */
    tripTo: MotisPlace.optional(),
    cancelled: z.boolean().default(false),
  })
  .loose();

const MotisStopTimesResponse = z.object({ stopTimes: z.array(MotisStopTime) }).loose();

/**
 * MOTIS namespaces GTFS stop ids with the dataset tag from config.yml
 * (e.g. "gb-railgtfs_KGX"). We add the prefix on the way in and strip it on
 * the way out so the rest of Signaller speaks bare CRS codes.
 */
const DATASET_TAG = process.env.MOTIS_DATASET_TAG ?? "gb-railgtfs";

function toEngineStopId(crs: string): string {
  return crs.includes("_") ? crs : `${DATASET_TAG}_${crs}`;
}

/**
 * MOTIS accepts either a stop id or a bare "lat,lon" for fromPlace/toPlace.
 * A coordinate must NOT get the dataset-tag prefix — it isn't a stop id.
 */
function toEnginePlace(place: PlanPlace): string {
  return typeof place === "string" ? toEngineStopId(place) : `${place.lat},${place.lon}`;
}

function fromEngineStopId(stopId: string): string {
  return stopId.startsWith(`${DATASET_TAG}_`) ? stopId.slice(DATASET_TAG.length + 1) : stopId;
}

/**
 * MOTIS v2 returns a composite trip id, e.g. `20260725_06:44_gb-railgtfs_50711`
 * (`<date>_<time>_<datasetTag>_<gtfsTripId>`). The bare GTFS trip id at the end
 * is what joins to our `trip_mapping.gtfs_trip_id`. This extracts it; if the id
 * isn't composite it's returned unchanged.
 */
export function gtfsTripIdFromEngine(tripId: string): string {
  const marker = `_${DATASET_TAG}_`;
  const at = tripId.lastIndexOf(marker);
  return at >= 0 ? tripId.slice(at + marker.length) : tripId;
}

/**
 * Decode an encoded polyline into [lon, lat] pairs. The format stores signed
 * offsets from the previous point as zigzag-encoded, 5-bit chunked base64-ish
 * characters. Latitude comes first in the wire format; we emit [lon, lat] so
 * the result drops straight into MapLibre.
 */
export function decodePolyline(points: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < points.length) {
    // Each coordinate is two varints in a row: latitude delta, then longitude.
    const deltas: number[] = [];
    for (let d = 0; d < 2; d += 1) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        if (index >= points.length) return out; // truncated input — keep what decoded cleanly
        byte = points.charCodeAt(index) - 63;
        index += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      // Low bit is the sign flag (zigzag), so odd values are negative.
      deltas.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    lat += deltas[0]!;
    lon += deltas[1]!;
    out.push([lon / factor, lat / factor]);
  }

  return out;
}

function toCall(place: z.infer<typeof MotisPlace>, kind: "departure" | "arrival") {
  const scheduled =
    kind === "departure"
      ? (place.scheduledDeparture ?? place.departure)
      : (place.scheduledArrival ?? place.arrival);
  const live = kind === "departure" ? place.departure : place.arrival;
  return {
    stopId: fromEngineStopId(place.stopId ?? ""),
    name: place.name,
    scheduled: scheduled ?? "",
    live: live && live !== scheduled ? live : undefined,
    lat: place.lat,
    lon: place.lon,
  };
}

function toRawLeg(leg: z.infer<typeof MotisLeg>): RawLeg {
  const rail = leg.mode !== "WALK" && leg.mode.toLowerCase() !== "walk";
  const shape = leg.legGeometry
    ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision)
    : [];
  return {
    mode: rail ? "rail" : "walk",
    origin: toCall(leg.from, "departure"),
    destination: toCall(leg.to, "arrival"),
    tripId: leg.tripId,
    routeName: leg.routeShortName,
    headsign: leg.headsign,
    intermediateCalls: leg.intermediateStops.map((s) => toCall(s, "departure")),
    staySeated: leg.interlineWithPreviousLeg,
    cancelled: leg.cancelled,
    geometry: shape.length >= 2 ? shape : undefined,
    distanceMeters: leg.distance,
    durationSeconds: leg.duration,
  };
}

export class MotisEngine implements RoutingEngine {
  constructor(private readonly baseUrl: string) {}

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`MOTIS ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async plan(query: PlanQuery): Promise<RawItinerary[]> {
    const params: Record<string, string> = {
      fromPlace: toEnginePlace(query.from),
      toPlace: toEnginePlace(query.to),
      time: query.when ?? new Date().toISOString(),
      arriveBy: String(query.arriveBy ?? false),
      numItineraries: String(query.numItineraries ?? 5),
    };
    // Only sent when asked for: a transit-only engine (no OSM imported)
    // rejects or ignores these, and the default behaviour is what we had.
    if (query.accessModes?.length) {
      params.preTransitModes = query.accessModes.join(",");
      params.postTransitModes = query.accessModes.join(",");
    }
    if (query.maxAccessMinutes !== undefined) {
      params.maxPreTransitTime = String(query.maxAccessMinutes * 60);
      params.maxPostTransitTime = String(query.maxAccessMinutes * 60);
    }
    const json = await this.get("/api/v1/plan", params);
    const parsed = MotisPlanResponse.parse(json);
    return parsed.itineraries.map((it) => ({
      legs: it.legs.map(toRawLeg),
      departs: it.startTime,
      arrives: it.endTime,
      durationSeconds: it.duration,
      transfers: it.transfers,
    }));
  }

  async departures(query: DepartureBoardQuery): Promise<RawDeparture[]> {
    const json = await this.get("/api/v1/stoptimes", {
      stopId: toEngineStopId(query.stopId),
      time: query.when ?? new Date().toISOString(),
      n: String(query.limit ?? 12),
    });
    const parsed = MotisStopTimesResponse.parse(json);
    return parsed.stopTimes.map((st) => {
      const call = toCall(st.place, "departure");
      return {
        tripId: st.tripId,
        routeName: st.routeShortName,
        headsign: st.headsign,
        destinationName: st.tripTo?.name,
        destinationStopId: st.tripTo?.stopId ? fromEngineStopId(st.tripTo.stopId) : undefined,
        platform: st.place.description,
        scheduled: call.scheduled,
        live: call.live,
        cancelled: st.cancelled,
      };
    });
  }

  async arrivals(query: DepartureBoardQuery): Promise<RawDeparture[]> {
    const json = await this.get("/api/v1/stoptimes", {
      stopId: toEngineStopId(query.stopId),
      time: query.when ?? new Date().toISOString(),
      n: String(query.limit ?? 12),
    });
    const parsed = MotisStopTimesResponse.parse(json);
    const arrivals: RawDeparture[] = [];
    for (const st of parsed.stopTimes) {
      const call = toCall(st.place, "arrival");
      if (!call.scheduled) continue;
      arrivals.push({
        tripId: st.tripId,
        routeName: st.routeShortName,
        headsign: st.headsign,
        originName: st.tripFrom?.name,
        originStopId: st.tripFrom?.stopId ? fromEngineStopId(st.tripFrom.stopId) : undefined,
        destinationName: st.tripTo?.name,
        destinationStopId: st.tripTo?.stopId ? fromEngineStopId(st.tripTo.stopId) : undefined,
        platform: st.place.description,
        scheduled: call.scheduled,
        live: call.live,
        cancelled: st.cancelled,
      });
    }
    return arrivals;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(new URL("/api/v1/plan", this.baseUrl), {
        method: "HEAD",
        signal: AbortSignal.timeout(2_000),
      });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}

export function createEngine(motisUrl = process.env.MOTIS_URL): RoutingEngine {
  if (!motisUrl) throw new Error("MOTIS_URL is not set");
  return new MotisEngine(motisUrl);
}
