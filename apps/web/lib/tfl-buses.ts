/**
 * Approximate live bus positions for the map.
 *
 * TfL's Unified API doesn't expose a standalone per-vehicle GPS feed (that's
 * SIRI-VM, a separate product not integrated here) — what's available is
 * Arrivals: per-stop predictions with `timeToStation` in seconds. This derives
 * a rough position per predicted bus by interpolating along the straight line
 * from the stop toward... nothing else known, so buses are placed AT their
 * next stop, nudged back along a notional approach vector scaled by
 * timeToStation. It is explicitly an approximation, not a real position — the
 * map must say so, the same way the NR legend already says positions are
 * timing-point-derived, not GPS.
 */
import { arrivals, type TflArrivalPrediction } from "./tfl";
import { getMapStopsInBounds, type MapStop } from "./tfl-stops";

export interface ApproxBus {
  id: string;
  lineId?: string;
  lineName: string;
  destinationName?: string;
  lat: number;
  lon: number;
  /** Seconds until the bus reaches `atStopNaptanId`; drives the approximation. */
  etaSeconds: number;
  atStopNaptanId: string;
  atStopName: string;
  /** "inbound" | "outbound" — needed to fetch this line's route sequence. */
  direction?: string;
  /** Real compass heading from TfL, when available — drives the map's direction arrow. */
  bearing?: number;
}

/** Only poll a bounded, high-value set of stops — not all ~19k bus stops. */
const MAX_STOPS_PER_REQUEST = 60;

// A stationary bus takes roughly this long to cover the distance between two
// average-spaced stops; used only to size the visual nudge, not for real ETAs.
const ASSUMED_SECONDS_PER_STOP_HOP = 90;
const NUDGE_METERS_PER_DEGREE_LAT = 111_320;

function metersToLatDegrees(m: number): number {
  return m / NUDGE_METERS_PER_DEGREE_LAT;
}

/**
 * Buses approaching a bounded set of stops within a lat/lon box. Positions
 * are placed at the stop, offset back along a fixed bearing scaled by how
 * soon the prediction says the bus will arrive — closer ETA sits closer to
 * the stop. There's no real heading data, so the offset direction is
 * arbitrary; only the "closing in on this stop" motion is meaningful.
 */
export async function getApproxBuses(
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  limit = 300,
): Promise<ApproxBus[]> {
  const inBounds = await getMapStopsInBounds(["bus"], bounds);
  if (inBounds.length === 0) return [];

  // Cap how many stops we poll per request — Arrivals is one call per stop,
  // and this only needs to look "alive" near where the user is looking, not
  // be exhaustive.
  const stopsToPoll = inBounds.slice(0, MAX_STOPS_PER_REQUEST);

  const results = await Promise.all(
    stopsToPoll.map(async (stop): Promise<{ stop: MapStop; predictions: TflArrivalPrediction[] }> => ({
      stop,
      predictions: await arrivals(stop.naptanId),
    })),
  );

  const buses: ApproxBus[] = [];
  for (const { stop, predictions } of results) {
    for (const p of predictions.slice(0, 3)) {
      const hopsAway = p.timeToStation / ASSUMED_SECONDS_PER_STOP_HOP;
      const offsetDeg = metersToLatDegrees(Math.min(hopsAway, 3) * 250);
      buses.push({
        id: `${stop.naptanId}-${p.lineName}-${p.timeToStation}`,
        lineId: p.lineId,
        lineName: p.lineName,
        destinationName: p.destinationName,
        lat: stop.lat + offsetDeg,
        lon: stop.lon,
        etaSeconds: p.timeToStation,
        atStopNaptanId: stop.naptanId,
        atStopName: stop.commonName,
        direction: p.direction,
        bearing: p.bearing,
      });
    }
  }

  return buses.slice(0, limit);
}
