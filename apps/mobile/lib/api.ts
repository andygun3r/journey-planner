import Constants from "expo-constants";

export interface JourneyLeg {
  mode: string;
  originName: string;
  originCrs: string;
  destName: string;
  destCrs: string;
  departs: string;
  arrives: string;
  operator?: string;
  lineName?: string;
  cancelled: boolean;
  callCount: number;
}

export interface Journey {
  id: string;
  departs: string;
  arrives: string;
  liveDeparts?: string;
  liveArrives?: string;
  durationMinutes: number;
  changes: number;
  status: "on-time" | "delayed" | "cancelled" | "scheduled";
  delayMinutes?: number;
  legs: JourneyLeg[];
}

export type JourneyResponse =
  | { ok: true; journeys: Journey[] }
  | { ok: false; reason: "engine-offline" | "no-journeys" | "bad-request" };

export interface BoardDeparture {
  tripId?: string;
  rid?: string;
  destinationName: string;
  destinationCrs?: string;
  originName?: string;
  originCrs?: string;
  operator?: string;
  scheduled: string;
  live?: string;
  platform?: string;
  status: "on-time" | "delayed" | "cancelled" | "scheduled";
  delayMinutes?: number;
  hasLive: boolean;
}

export interface Board {
  crs: string;
  stationName: string;
  generatedAt: string;
  live: boolean;
  source: "ldbws" | "darwin" | "timetable";
  departures: BoardDeparture[];
  arrivals: BoardDeparture[];
  messages: string[];
}

export type BoardResponse =
  | { ok: true; board: Board }
  | { ok: false; reason: "engine-offline" | "bad-request" | "unknown-station" };

export interface HealthResponse {
  ok: boolean;
  postgres: boolean;
  redis: boolean;
  schema: boolean | null;
  service: string;
  timetable?: {
    ok?: boolean;
    stale?: boolean;
    latest?: unknown;
  } | null;
}

export const apiBaseUrl =
  ((Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Accept: "application/json" },
  });
  const json = (await res.json()) as T;
  return json;
}

export function planJourneys(from: string, to: string): Promise<JourneyResponse> {
  const params = new URLSearchParams({ from: from.trim(), to: to.trim() });
  return getJson<JourneyResponse>(`/api/journeys?${params.toString()}`);
}

export function fetchBoard(crs: string): Promise<BoardResponse> {
  const clean = encodeURIComponent(crs.trim().toUpperCase());
  return getJson<BoardResponse>(`/api/boards/${clean}?limit=8`);
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>("/api/health");
}

export function timeLabel(value?: string): string {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 5);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
