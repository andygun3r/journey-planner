import { z } from "zod";
import type {
  DepartureBoardQuery,
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
    /** Terminating stop of this trip — the board's "destination". */
    tripTo: MotisPlace.optional(),
    cancelled: z.boolean().default(false),
  })
  .loose();

const MotisStopTimesResponse = z.object({ stopTimes: z.array(MotisStopTime) }).loose();

/**
 * MOTIS namespaces GTFS stop ids with the dataset tag from config.yml
 * (e.g. "gb-railgtfs_KGX"). We add the prefix on the way in and strip it on
 * the way out so the rest of Mainline speaks bare CRS codes.
 */
const DATASET_TAG = process.env.MOTIS_DATASET_TAG ?? "gb-railgtfs";

function toEngineStopId(crs: string): string {
  return crs.includes("_") ? crs : `${DATASET_TAG}_${crs}`;
}

function fromEngineStopId(stopId: string): string {
  return stopId.startsWith(`${DATASET_TAG}_`) ? stopId.slice(DATASET_TAG.length + 1) : stopId;
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
  };
}

function toRawLeg(leg: z.infer<typeof MotisLeg>): RawLeg {
  const rail = leg.mode !== "WALK" && leg.mode.toLowerCase() !== "walk";
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
    const json = await this.get("/api/v1/plan", {
      fromPlace: toEngineStopId(query.from),
      toPlace: toEngineStopId(query.to),
      time: query.when ?? new Date().toISOString(),
      arriveBy: String(query.arriveBy ?? false),
      numItineraries: String(query.numItineraries ?? 5),
    });
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
