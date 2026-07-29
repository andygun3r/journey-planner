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
   * path[i+1] as [lon, lat] pairs, or null where no corridor was precomputed
   * and the leg should be drawn as a straight chord. See rail_corridor.
   */
  pathGeometry?: ([number, number][] | null)[];
}

export interface LiveTrainsResult {
  generatedAt: string;
  count: number;
  trains: LiveTrain[];
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

export function lateLabel(m?: number): { text: string; cls: string } {
  if (m === undefined) return { text: "", cls: "" };
  if (m > 1) return { text: `${m} late`, cls: "late" };
  if (m < -1) return { text: `${-m} early`, cls: "early" };
  return { text: "on time", cls: "ontime" };
}
