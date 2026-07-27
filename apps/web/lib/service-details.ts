import { darwinFormation, darwinStopForecast } from "@mainline/db";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { enrichWithDarwinProgress, enrichWithNrProgress } from "./service-progress";

/**
 * Client for the RDG "Service Details" REST API (LDBWS GetServiceDetails).
 * Given a serviceID (from a board row's tripId when the board came from
 * LDBWS), returns the full calling pattern with live per-stop times.
 * Separate RDM product => separate API key.
 */

interface RawCallingPoint {
  locationName?: string;
  crs?: string;
  st?: string; // scheduled time "HH:MM"
  et?: string; // estimated: "On time" | "HH:MM" | "Delayed" | "Cancelled"
  at?: string; // actual time "HH:MM"
  isCancelled?: boolean;
}

interface RawCoach {
  coachClass?: string;
  loading?: number;
  loadingSpecified?: boolean;
  number?: string;
  toilet?: { status?: string; value?: string } | string;
}

interface RawServiceDetails {
  locationName?: string;
  crs?: string;
  operator?: string;
  operatorCode?: string;
  platform?: string;
  std?: string;
  etd?: string;
  atd?: string;
  sta?: string;
  eta?: string;
  length?: number;
  isCancelled?: boolean;
  cancelReason?: string;
  delayReason?: string;
  generatedAt?: string;
  formation?: { coaches?: RawCoach[] };
  previousCallingPoints?: Array<{ callingPoint?: RawCallingPoint[] }>;
  subsequentCallingPoints?: Array<{ callingPoint?: RawCallingPoint[] }>;
}

export interface ServiceCoach {
  number: string;
  first: boolean;
  /** Raw class string from the feed, e.g. "First" / "Standard". */
  coachClass?: string;
  loading?: number;
  toilet?: string;
}

/** Where a stop sits relative to the train's live progress. */
export type CallProgress = "departed" | "current" | "upcoming";

export interface ServiceCall {
  crs?: string;
  name: string;
  /** Scheduled time as "HH:MM". */
  scheduled?: string;
  /** Best-known live time ("On time", "HH:MM", "Delayed", "Cancelled"). */
  expected?: string;
  /** Platform, when Darwin has assigned one for this stop. */
  platform?: string;
  cancelled: boolean;
  /** True for the "you are here" origin stop. */
  isThisStop?: boolean;
  // --- Live progress (from Darwin), when the service is resolvable ---
  /** departed = train has left this stop; current = last confirmed stop; upcoming = ahead. */
  progress?: CallProgress;
  /** Actual reported time here (HH:MM), when the train has passed. */
  actual?: string;
  /** ISO instant of the best live arrival estimate — drives the countdown. */
  estimatedArrivalIso?: string;
}

export interface ServiceProgress {
  /** True when we resolved this service to a live Darwin train run. */
  tracking: boolean;
  /** Name of the last stop the train has confirmed passing/leaving. */
  lastStopName?: string;
  /** Name of the next stop the train is heading to. */
  nextStopName?: string;
  /** Minutes late overall (from the most recent live estimate), if any. */
  delayMinutes?: number;
  /** True once the train has reached its final destination. */
  arrived: boolean;
  // --- Network Rail live positioning (finer than Darwin's station-level) ---
  /** True when correlated to a Network Rail train-position record. */
  networkRail: boolean;
  /** Where the NR feed last reported the train (station or passing point). */
  nrLastLocation?: string;
  /** Whether that report was an arrival, departure, or berth pass. */
  nrLastEvent?: string;
  /** How long ago the NR report was, in seconds (for "reported N min ago"). */
  nrReportedAgoSeconds?: number;
  /** NR-derived lateness in minutes, when available. */
  nrLatenessMinutes?: number;
}

export interface ServiceDetails {
  stationName: string;
  crs: string;
  operator?: string;
  operatorCode?: string;
  platform?: string;
  scheduledDeparture?: string;
  expectedDeparture?: string;
  cancelled: boolean;
  cancelReason?: string;
  delayReason?: string;
  coaches: ServiceCoach[];
  length?: number;
  calls: ServiceCall[];
  progress: ServiceProgress;
  /** Darwin run id, once resolved — powers the live position map and advanced view. */
  rid?: string;
}

export function serviceDetailsConfigured(): boolean {
  return Boolean(process.env.LDBWS_SERVICE_API_KEY && process.env.LDBWS_SERVICE_BASE_URL);
}

function flatten(groups?: Array<{ callingPoint?: RawCallingPoint[] }>): RawCallingPoint[] {
  return (groups ?? []).flatMap((g) => g.callingPoint ?? []);
}

function toCall(cp: RawCallingPoint): ServiceCall {
  return {
    crs: cp.crs,
    name: cp.locationName ?? cp.crs ?? "",
    scheduled: cp.st,
    expected: cp.at ?? cp.et,
    cancelled: cp.isCancelled === true,
  };
}

/**
 * Fill in platform per calling point from Darwin (darwin_stop_forecast), which
 * carries platforms LDBWS's calling points omit. Matches by (crs, scheduled
 * HH:MM). One bulk query; a no-op when the ingester hasn't populated data.
 */
async function enrichCallsWithDarwinPlatforms(calls: ServiceCall[]): Promise<ServiceCall[]> {
  const needy = calls.filter((c) => c.crs && c.scheduled && !c.platform);
  if (needy.length === 0) return calls;

  const crsList = [...new Set(needy.map((c) => c.crs!))];
  let rows: Array<{ crs: string | null; schedArr: string | null; schedDep: string | null; platform: string | null }>;
  try {
    rows = await getDb()
      .select({
        crs: darwinStopForecast.crs,
        schedArr: darwinStopForecast.schedArr,
        schedDep: darwinStopForecast.schedDep,
        platform: darwinStopForecast.platform,
      })
      .from(darwinStopForecast)
      .where(inArray(darwinStopForecast.crs, crsList));
  } catch {
    return calls; // DB/table not ready
  }

  // Key platform by (crs, HH:MM) for both the arrival and departure minute.
  const platByKey = new Map<string, string>();
  for (const r of rows) {
    if (!r.crs || !r.platform) continue;
    for (const time of [r.schedArr, r.schedDep]) {
      if (time) platByKey.set(`${r.crs}|${time.slice(0, 5)}`, r.platform);
    }
  }

  return calls.map((c) => {
    if (c.platform || !c.crs || !c.scheduled) return c;
    const platform = platByKey.get(`${c.crs}|${c.scheduled.slice(0, 5)}`);
    return platform ? { ...c, platform } : c;
  });
}

interface StoredCoach {
  number: string;
  coachClass?: string;
  first: boolean;
  loading?: number;
}

/**
 * Fills coach formation from Darwin (darwin_formation) when LDBWS's own
 * GetServiceDetails returned none — mirrors the board's fallback
 * (enrichBoardWithFormation), which some TOCs/services need since LDBWS
 * doesn't always carry formation data. Toilet status stays unset here: it's
 * not present anywhere in the Darwin Push Port formation/loading messages.
 */
async function fallbackFormation(rid: string): Promise<ServiceCoach[] | null> {
  try {
    const rows = await getDb()
      .select({ coaches: darwinFormation.coaches })
      .from(darwinFormation)
      .where(eq(darwinFormation.rid, rid))
      .limit(1);
    const stored = rows[0]?.coaches as StoredCoach[] | undefined;
    if (!stored || stored.length === 0) return null;
    return stored.map((c) => ({
      number: c.number,
      first: c.first,
      coachClass: c.coachClass,
      loading: c.loading,
    }));
  } catch {
    return null;
  }
}

export async function fetchServiceDetails(serviceId: string): Promise<ServiceDetails | null> {
  const key = process.env.LDBWS_SERVICE_API_KEY;
  const base = process.env.LDBWS_SERVICE_BASE_URL;
  if (!key || !base) return null;

  let res: Response;
  try {
    res = await fetch(`${base}/GetServiceDetails/${encodeURIComponent(serviceId)}`, {
      headers: { "x-apikey": key },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const d = (await res.json()) as RawServiceDetails;

  const thisStop: ServiceCall = {
    crs: d.crs,
    name: d.locationName ?? d.crs ?? "",
    scheduled: d.std ?? d.sta,
    expected: d.atd ?? d.etd ?? d.eta,
    // LDBWS gives the boarding station's platform directly.
    platform: d.platform,
    cancelled: d.isCancelled === true,
    isThisStop: true,
  };

  let calls: ServiceCall[] = [
    ...flatten(d.previousCallingPoints).map(toCall),
    thisStop,
    ...flatten(d.subsequentCallingPoints).map(toCall),
  ];
  // Resolve the service against Darwin (realtime timetable: scheduled/estimated/
  // actual times, delay) and Network Rail TD (actual movement: live berth-step
  // position) independently and side by side — Darwin's one-time schedule/
  // activation message can be missed (e.g. after a feed outage, see CLAUDE.md),
  // while TD keeps flowing regardless, and TD's berth steps are finer-grained
  // than Darwin's timing points even when Darwin does resolve. TD only overrides
  // when NR is confident about a single unambiguous match (never guess).
  const { calls: darwinCalls, progress: darwinProgress, rid } = await enrichWithDarwinProgress(calls);
  calls = darwinCalls;
  let finalProgress = darwinProgress;

  const nr = await enrichWithNrProgress(calls).catch(() => null);
  if (nr) {
    // Darwin still owns scheduled/estimated/actual times and delay figures;
    // TD only supersedes the per-stop progress marker and the live position,
    // since that's the only thing TD is actually more current on. nr.calls is
    // enrichWithNrProgress's own positional re-marking of the exact same
    // calls array passed in — match by index, not CRS: the TD-reported
    // "current" location (match.crs) can be a passing point/junction that
    // isn't itself one of the public LDBWS calling points, so a CRS-keyed
    // lookup would silently fail to find the row it needs to mark.
    calls = calls.map((c, i) => ({ ...c, progress: nr.calls[i]?.progress ?? c.progress }));
    finalProgress = {
      ...finalProgress,
      tracking: true,
      arrived: darwinProgress.tracking ? finalProgress.arrived : nr.progress.arrived,
      lastStopName: nr.progress.lastStopName,
      nextStopName: nr.progress.nextStopName,
      networkRail: true,
      nrLastLocation: nr.progress.nrLastLocation,
      nrLastEvent: nr.progress.nrLastEvent,
    };
  }
  // Backstop: fill any still-missing platforms by (crs, time), in case the
  // service didn't resolve to a single rid.
  if (!finalProgress.tracking) calls = await enrichCallsWithDarwinPlatforms(calls);

  let coaches: ServiceCoach[] = (d.formation?.coaches ?? []).map((c) => ({
    number: c.number ?? "",
    first: /first/i.test(c.coachClass ?? ""),
    coachClass: c.coachClass,
    loading: c.loadingSpecified ? c.loading : undefined,
    toilet:
      typeof c.toilet === "string" ? c.toilet : (c.toilet?.value ?? c.toilet?.status),
  }));
  if (coaches.length === 0 && rid) {
    coaches = (await fallbackFormation(rid)) ?? coaches;
  }

  return {
    stationName: d.locationName ?? d.crs ?? "",
    crs: (d.crs ?? "").toUpperCase(),
    operator: d.operator,
    operatorCode: d.operatorCode,
    platform: d.platform,
    scheduledDeparture: d.std,
    expectedDeparture: d.atd ?? d.etd,
    cancelled: d.isCancelled === true,
    cancelReason: d.cancelReason,
    delayReason: d.delayReason,
    coaches,
    length: d.length && d.length > 0 ? d.length : undefined,
    calls,
    progress: finalProgress,
    rid,
  };
}
