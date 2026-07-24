/**
 * Engine-agnostic routing interface. The web app and workers only ever talk
 * to a RoutingEngine — swapping MOTIS for OTP2 means adding one new file here.
 *
 * Results are "raw" engine itineraries: scheduled/realtime times and GTFS trip
 * ids, WITHOUT Darwin enrichment (platforms, reasons) or fares — those are
 * layered on by the web app's journey pipeline.
 */

export interface PlanQuery {
  /** GTFS stop id of the origin (CRS-derived for GB rail). */
  from: string;
  to: string;
  /** ISO datetime; defaults to now. */
  when?: string;
  arriveBy?: boolean;
  numItineraries?: number;
}

export interface RawCall {
  stopId: string;
  name: string;
  scheduled: string;
  /** Realtime-adjusted time when the engine has one. */
  live?: string;
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
  /** Liveness/readiness probe — false while the engine is importing data. */
  healthy(): Promise<boolean>;
}
