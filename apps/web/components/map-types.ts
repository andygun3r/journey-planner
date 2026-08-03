/** Client-side shapes mirroring apps/web/lib/live-trains.ts (types only). */

export interface PathStop {
  crs: string;
  name: string;
  lat: number;
  lon: number;
  scheduled?: string;
  expected?: string;
  actual?: boolean;
  status: "departed" | "current" | "upcoming";
}

export interface LiveTrain {
  id: string;
  headcode?: string;
  operator?: string;
  lat: number;
  lon: number;
  atName?: string;
  atCrs?: string;
  event?: string;
  towardName?: string;
  destName?: string;
  latenessMinutes?: number;
  reportedAgoSeconds: number;
  rid?: string;
  path?: PathStop[];
  /**
   * Track-following geometry per leg of `path`: entry i covers path[i] ->
   * path[i+1] as [lon, lat] pairs, or null where no corridor was precomputed.
   * The map omits null legs so the selected route never draws off-rail chords.
   */
  pathGeometry?: ([number, number][] | null)[];
}

export interface LiveTrainsResult {
  generatedAt: string;
  count: number;
  trains: LiveTrain[];
}

/**
 * What the map stream actually sends, and all the map layer actually draws.
 *
 * A full LiveTrain carries `path` — every calling point with coordinates and
 * times — which is around 2KB per train and the bulk of a 1.5-3MB response. The
 * map reads none of it: it needs the position, the headcode, the lateness, and
 * the next stop's coordinates for the direction arrow. The route line is only
 * ever drawn for the one selected train, which fetches `?rid=` separately.
 *
 * This lives here, next to the other wire shapes, because both sides need it:
 * the server builds it and the client's polling fallback has to produce the
 * same thing from a full LiveTrain.
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

/** What changed since the last tick: added or moved, and gone. */
export interface MapDelta {
  generatedAt: string;
  count: number;
  upserted: MapTrain[];
  removed: string[];
}

/**
 * Apply a delta to the trains the map is holding.
 *
 * Always returns a new Map, because React only re-renders on a changed
 * reference. Mutating in place looks correct and draws nothing.
 */
export function applyMapDelta(
  previous: Map<string, MapTrain>,
  delta: Pick<MapDelta, "upserted" | "removed">,
): Map<string, MapTrain> {
  const next = new Map(previous);
  for (const train of delta.upserted) next.set(train.id, train);
  for (const id of delta.removed) next.delete(id);
  return next;
}

/**
 * Initial compass bearing (0-359°) from one point toward another. There's no
 * GPS heading for GB rail (see live-trains.ts), so the map derives a train's
 * direction arrow from its plotted position toward the next calling point
 * instead — good enough at the "which way is this train pointing" scale the
 * map draws at.
 */
export function bearingDegrees(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** A train's next not-yet-departed calling point, if it has a known path. */
export function nextPathStop(train: LiveTrain): PathStop | undefined {
  const path = train.path;
  if (!path || path.length === 0) return undefined;
  const currentIndex = path.findIndex((s) => s.status === "current");
  return path[currentIndex + 1] ?? path.find((s) => s.status === "upcoming");
}

/** Strip a full train down to what the map draws. */
export function toMapTrain(t: LiveTrain): MapTrain {
  const next = nextPathStop(t);
  const hasCoords = next != null && next.lat != null && next.lon != null;
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
    nextLat: hasCoords ? next.lat : undefined,
    nextLon: hasCoords ? next.lon : undefined,
  };
}

export function lateLabel(m?: number): { text: string; cls: string } {
  if (m === undefined) return { text: "", cls: "" };
  if (m > 1) return { text: `${m} late`, cls: "late" };
  if (m < -1) return { text: `${-m} early`, cls: "early" };
  return { text: "on time", cls: "ontime" };
}
