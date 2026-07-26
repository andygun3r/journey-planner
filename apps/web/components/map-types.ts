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
}

export interface LiveTrainsResult {
  generatedAt: string;
  count: number;
  trains: LiveTrain[];
}

export function lateLabel(m?: number): { text: string; cls: string } {
  if (m === undefined) return { text: "", cls: "" };
  if (m > 1) return { text: `${m} late`, cls: "late" };
  if (m < -1) return { text: `${-m} early`, cls: "early" };
  return { text: "on time", cls: "ontime" };
}
