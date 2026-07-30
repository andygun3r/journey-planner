import { getLiveTrains, type LiveTrain } from "./live-trains";
import { subscribeToSource, type Unsubscribe } from "./live-source";

/**
 * The shared live-train computation behind the map's stream.
 *
 * `/api/live-trains` runs three queries — up to 800 position rows, then every
 * calling point of all 800 (10-20k rows), then every station on those routes —
 * and returns an identical answer to every viewer. Each viewer polling it meant
 * that work multiplied by the number of people looking at the map. This runs it
 * once per tick regardless.
 *
 * **The tick is not a fallback.** A departed train slides along its leg from
 * `Date.now()` (see timeFractionAlongLeg in live-trains.ts), so its plotted
 * position changes even when no report arrives. An event-only stream would
 * leave the dots frozen between reports. Events pull the next run forward; the
 * interval is what keeps things moving.
 */

/**
 * Faster than the 15s poll it replaces, because it is now one computation for
 * everyone rather than one per viewer — so a shorter interval costs less than
 * the old longer one did.
 */
const TICK_MS = Number(process.env.LIVE_TRAINS_TICK_MS ?? 5_000);

/**
 * How long to gather position events before recomputing. Long enough that a
 * burst of berth steps is one run, short enough to feel immediate.
 */
const DEBOUNCE_MS = Number(process.env.LIVE_TRAINS_DEBOUNCE_MS ?? 750);

/**
 * What the map actually draws.
 *
 * The full LiveTrain carries `path` — every calling point with coordinates and
 * times — which is roughly 2KB per train and the bulk of a 1.5-3MB response.
 * The map layer reads none of it: `trainsToGeoJSON` uses the position, the
 * headcode, the lateness and the next stop for the arrow. The route line is only
 * ever drawn for the one selected train, which fetches `?rid=` separately.
 */
export interface MapTrain {
  id: string;
  lat: number;
  lon: number;
  headcode?: string;
  operator?: string;
  latenessMinutes?: number;
  reportedAgoSeconds: number;
  rid?: string;
  atName?: string;
  atCrs?: string;
  event?: string;
  towardName?: string;
  destName?: string;
  /** Just the next stop's coordinates, for the direction arrow. */
  nextLat?: number;
  nextLon?: number;
}

export interface MapSnapshot {
  generatedAt: string;
  count: number;
  trains: MapTrain[];
}

/** Added or changed since the previous tick, and gone since the previous tick. */
export interface MapDelta {
  generatedAt: string;
  count: number;
  upserted: MapTrain[];
  removed: string[];
}

function toMapTrain(t: LiveTrain): MapTrain {
  // The arrow points at the first calling point the train has not reached, which
  // is what the client derives from `path` today.
  const next = t.path?.find((p) => p.status !== "departed" && p.lat != null && p.lon != null);
  return {
    id: t.id,
    lat: t.lat,
    lon: t.lon,
    headcode: t.headcode,
    operator: t.operator,
    latenessMinutes: t.latenessMinutes,
    reportedAgoSeconds: t.reportedAgoSeconds,
    rid: t.rid,
    atName: t.atName,
    atCrs: t.atCrs,
    event: t.event,
    towardName: t.towardName,
    destName: t.destName,
    nextLat: next?.lat ?? undefined,
    nextLon: next?.lon ?? undefined,
  };
}

/** Cheap equality on the fields that actually reach the screen. */
function changed(a: MapTrain, b: MapTrain): boolean {
  return (
    a.lat !== b.lat ||
    a.lon !== b.lon ||
    a.latenessMinutes !== b.latenessMinutes ||
    a.atCrs !== b.atCrs ||
    a.event !== b.event ||
    a.rid !== b.rid ||
    a.nextLat !== b.nextLat ||
    a.nextLon !== b.nextLon
  );
}

interface Emission {
  snapshot: MapSnapshot;
  /** Undefined on the very first run, when there is nothing to diff against. */
  delta: MapDelta | undefined;
}

let previous: Map<string, MapTrain> | undefined;

async function compute(): Promise<Emission> {
  const result = await getLiveTrains(800);
  const trains = result.trains.map(toMapTrain);
  const current = new Map(trains.map((t) => [t.id, t]));

  let delta: MapDelta | undefined;
  if (previous) {
    const upserted: MapTrain[] = [];
    for (const [id, train] of current) {
      const before = previous.get(id);
      if (!before || changed(before, train)) upserted.push(train);
    }
    const removed: string[] = [];
    for (const id of previous.keys()) if (!current.has(id)) removed.push(id);
    delta = { generatedAt: result.generatedAt, count: current.size, upserted, removed };
  }
  previous = current;

  return {
    snapshot: { generatedAt: result.generatedAt, count: current.size, trains },
    delta,
  };
}

/**
 * Subscribe to map updates. The callback receives the whole snapshot first, then
 * only what changed.
 *
 * The diff is computed once per tick and shared, rather than per connection.
 */
export function subscribeToMap(
  onSnapshot: (snapshot: MapSnapshot) => void,
  onDelta: (delta: MapDelta) => void,
): Unsubscribe {
  let sentSnapshot = false;
  return subscribeToSource<Emission>(
    {
      key: "live-trains",
      compute,
      intervalMs: TICK_MS,
      // Every train movement, including the mid-section berth steps that never
      // resolve to a station — see publishPosition in nr-ingest.
      patterns: ["nr:pos:*"],
      debounceMs: DEBOUNCE_MS,
    },
    (emission) => {
      if (!sentSnapshot) {
        sentSnapshot = true;
        onSnapshot(emission.snapshot);
        return;
      }
      // A tick that changed nothing still produces a delta; skip the empty ones
      // rather than waking every client to tell it nothing happened.
      if (emission.delta && (emission.delta.upserted.length || emission.delta.removed.length)) {
        onDelta(emission.delta);
      }
    },
  );
}
