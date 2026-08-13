/**
 * Engine-agnostic routing interface. The web app and workers only ever talk
 * to a RoutingEngine — swapping MOTIS for OTP2 means adding one new file here.
 *
 * Results are "raw" engine itineraries: scheduled/realtime times and GTFS trip
 * ids, WITHOUT Darwin enrichment (platforms, reasons) or fares — those are
 * layered on by the web app's journey pipeline.
 */

/**
 * A journey endpoint the engine can route from/to: either a stop, or a raw
 * coordinate. Coordinates only work when the engine has street routing
 * (an OSM extract imported) — without it, MOTIS can't get from a point on a
 * street to a platform.
 */
export type PlanPlace = string | { lat: number; lon: number };

export interface PlanQuery {
  /** GTFS stop id (CRS-derived for GB rail), or a coordinate for door-to-door. */
  from: PlanPlace;
  to: PlanPlace;
  /** ISO datetime; defaults to now. */
  when?: string;
  arriveBy?: boolean;
  numItineraries?: number;
  /**
   * How the traveller gets to/from transit. Defaults to walking. Only
   * meaningful with street routing enabled; ignored by a transit-only engine.
   */
  accessModes?: Array<"WALK" | "BIKE" | "CAR">;
  /** Max minutes of walking at either end, when the engine supports it. */
  maxAccessMinutes?: number;
}

export interface RawCall {
  stopId: string;
  name: string;
  scheduled: string;
  /** Realtime-adjusted time when the engine has one. */
  live?: string;
  /** WGS84 position of the stop, when the engine reports one. */
  lat?: number;
  lon?: number;
}

export interface RawLeg {
  mode: "rail" | "walk";
  origin: RawCall;
  destination: RawCall;
  tripId?: string;
  routeName?: string;
  headsign?: string;
  intermediateCalls: RawCall[];
  /** Engine marked this as a stay-seated continuation (split/join portion). */
  staySeated: boolean;
  cancelled: boolean;
  /**
   * Shape of the leg as [lon, lat] pairs — the order MapLibre wants, and the
   * same convention as rail_corridor.geometry. Absent when the engine gives no
   * shape for the leg; callers fall back to the precomputed rail corridor
   * rather than drawing a straight chord across country.
   */
  geometry?: [number, number][];
  /** Metres covered on a street (walk/bike) leg, when the engine reports it. */
  distanceMeters?: number;
  /** Leg duration in seconds, when the engine reports it. */
  durationSeconds?: number;
}

export interface RawItinerary {
  legs: RawLeg[];
  departs: string;
  arrives: string;
  durationSeconds: number;
  transfers: number;
}

export interface DepartureBoardQuery {
  stopId: string;
  when?: string;
  limit?: number;
}

export interface RawDeparture {
  tripId?: string;
  routeName?: string;
  headsign?: string;
  /** Origin of this service, used by arrival boards. */
  originName?: string;
  originStopId?: string;
  /** Final destination of this service (from the trip's last call). */
  destinationName?: string;
  destinationStopId?: string;
  /** Platform as known to the timetable/engine; may be superseded by live data. */
  platform?: string;
  scheduled: string;
  live?: string;
  cancelled: boolean;
}

export interface RoutingEngine {
  plan(query: PlanQuery): Promise<RawItinerary[]>;
  departures(query: DepartureBoardQuery): Promise<RawDeparture[]>;
  arrivals(query: DepartureBoardQuery): Promise<RawDeparture[]>;
  /** Liveness/readiness probe — false while the engine is importing data. */
  healthy(): Promise<boolean>;
}
