import { darwinFormation } from "@mainline/db";
import { eq } from "drizzle-orm";
import type { CallProgress } from "./call-status";
import { getDb } from "./db";
import { enrichWithDarwinProgress, enrichWithNrProgress, frontIndex } from "./service-progress";
import { hhmmToIso, resolvePatternTimes } from "./uk-time";

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

/**
 * One `callingPointList` from LDBWS.
 *
 * A service that divides (or is formed by joining) returns SEVERAL of these:
 * the through portion first, then one per associated portion. The list-level
 * attributes below say what each one is, and dropping them is how a divided
 * service ends up rendered as a single impossible route.
 */
interface RawCallingPointList {
  callingPoint?: RawCallingPoint | RawCallingPoint[];
  serviceType?: string;
  serviceChangeRequired?: boolean;
  assocIsCancelled?: boolean;
}

interface RawCoach {
  coachClass?: string;
  loading?: number;
  loadingSpecified?: boolean;
  number?: string;
  toilet?: { status?: string; value?: string } | string;
}

/**
 * Coerce a feed collection that may arrive as a bare object.
 *
 * LDBWS is XML underneath; gateways that convert it to JSON routinely collapse
 * a single-element list into the element itself. Every list in this file used
 * to assume an array, so one such collapse threw `.flatMap is not a function`
 * out of an unguarded parse — a 500 from the API route and a crashed render.
 */
function normaliseList<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
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
  formation?: { coaches?: RawCoach | RawCoach[] };
  previousCallingPoints?: RawCallingPointList | RawCallingPointList[];
  subsequentCallingPoints?: RawCallingPointList | RawCallingPointList[];
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
export type { CallProgress };

export interface ServiceCall {
  crs?: string;
  name: string;
  /** Scheduled time as "HH:MM". */
  scheduled?: string;
  /** The scheduled time as a real instant, resolved across the whole pattern. */
  scheduledIso?: string;
  /** Best-known live time ("On time", "HH:MM", "Delayed", "Cancelled"). */
  expected?: string;
  /** The estimate as a real instant, when `expected` is an actual time. */
  expectedIso?: string;
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
  /** The actual time as a real instant. */
  actualIso?: string;
  /** ISO instant of the best live arrival estimate — drives the countdown. */
  estimatedArrivalIso?: string;
}

/**
 * An associated portion of a service that divides or joins.
 *
 * These used to be concatenated onto the main calling pattern, which produced a
 * route the train never runs — the reported "train passed a station that's not
 * on the route". They are kept separate now so the page can say plainly that
 * the service splits, and which stops belong to which half.
 */
export interface ServicePortion {
  /** `divides`: an onward portion. `joins`: a portion that merges into this one. */
  kind: "divides" | "joins";
  /** Where this portion ends up (for `divides`) or comes from (for `joins`). */
  terminusName?: string;
  cancelled: boolean;
  /** LDBWS says passengers must change carriages to stay with this portion. */
  changeRequired: boolean;
  calls: ServiceCall[];
}

/**
 * Why the page is (or isn't) showing a live position.
 *
 * `awaiting-report` is the important one: it distinguishes "this train is
 * running but nothing has reported yet" from "we couldn't identify this train
 * at all". Correlation is strict now (see service-progress.ts), so absence is
 * routine and has to read as honest rather than broken.
 */
export type PositionState = "tracked" | "awaiting-report" | "not-tracked";

export interface ServiceProgress {
  /** True when we resolved this service to a live Darwin train run. */
  tracking: boolean;
  /** Why we do or don't have a position — drives the UI's honesty about it. */
  positionState: PositionState;
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
  /** The linear route of the portion you are travelling on. */
  calls: ServiceCall[];
  /** Associated portions, when this service divides or joins. Usually empty. */
  portions: ServicePortion[];
  progress: ServiceProgress;
  /** Darwin run id, once resolved — powers the live position map and advanced view. */
  rid?: string;
}

export function serviceDetailsConfigured(): boolean {
  return Boolean(process.env.LDBWS_SERVICE_API_KEY && process.env.LDBWS_SERVICE_BASE_URL);
}

/** The `callingPointList` groups, normalised and with their points normalised too. */
function callingPointLists(
  groups: RawCallingPointList | RawCallingPointList[] | undefined,
): Array<{ list: RawCallingPointList; points: RawCallingPoint[] }> {
  return normaliseList(groups).map((list) => ({
    list,
    points: normaliseList(list?.callingPoint),
  }));
}

function toCall(cp: RawCallingPoint): ServiceCall {
  return {
    crs: cp.crs,
    name: cp.locationName ?? cp.crs ?? "",
    scheduled: cp.st,
    // `at` is a report of fact and outranks the `et` estimate, but keep them in
    // their own fields — collapsing both into `expected` lost the distinction
    // between "estimated 07:44" and "actually left at 07:44".
    actual: cp.at,
    expected: cp.et,
    cancelled: cp.isCancelled === true,
  };
}

/**
 * Resolve every "HH:MM" in a calling pattern to a real instant, in order.
 *
 * Times must be dated as a sequence, not one by one: an overnight service runs
 * 23:47 → 00:14 → 01:32, and anchoring each stop independently against "now"
 * scatters them across different days and breaks the ordering. See
 * `resolvePatternTimes`.
 */
function datePattern(calls: ServiceCall[], anchor: Date): ServiceCall[] {
  const scheduledIso = resolvePatternTimes(
    calls.map((c) => c.scheduled),
    anchor,
  );
  // Live times ride on the scheduled skeleton: each stop's own scheduled
  // instant is the right anchor for its estimate, which keeps a delay that
  // crosses midnight on the correct side of it.
  return calls.map((c, i) => {
    const base = scheduledIso[i] ? new Date(scheduledIso[i]!) : anchor;
    return {
      ...c,
      scheduledIso: scheduledIso[i],
      expectedIso: hhmmNear(c.expected, base),
      actualIso: hhmmNear(c.actual, base),
    };
  });
}

/** An "HH:MM" resolved against a nearby instant; undefined for status strings. */
function hhmmNear(value: string | undefined, near: Date): string | undefined {
  return hhmmToIso(value, near);
}

export interface ParsedPattern {
  /** The route of the portion the caller is travelling on. */
  calls: ServiceCall[];
  /** Associated portions of a dividing/joining service. */
  portions: ServicePortion[];
}

/**
 * Split an LDBWS service payload into the portion you're on plus any
 * associated portions, with every time resolved to a real instant.
 *
 * Exported for tests: this is where the "stops that aren't on the route" bug
 * lived, and where a single-element list collapse used to throw.
 */
export function parseCallingPattern(d: RawServiceDetails): ParsedPattern {
  const raw = d.generatedAt ? new Date(d.generatedAt) : new Date();
  const anchor = Number.isNaN(raw.getTime()) ? new Date() : raw;

  const thisStop: ServiceCall = {
    crs: d.crs,
    name: d.locationName ?? d.crs ?? "",
    scheduled: d.std ?? d.sta,
    actual: d.atd,
    expected: d.etd ?? d.eta,
    // LDBWS gives the boarding station's platform directly.
    platform: d.platform,
    cancelled: d.isCancelled === true,
    isThisStop: true,
  };

  // The FIRST list in each direction is the portion this board row is for; any
  // further lists are associated portions of a service that divides or joins.
  // Concatenating them all — which is what this did — invents a route the train
  // never runs, and everything downstream (progress markers, the icon, the
  // index-matched NR re-marking) then trusts that route as gospel.
  const previousLists = callingPointLists(d.previousCallingPoints);
  const subsequentLists = callingPointLists(d.subsequentCallingPoints);

  const calls = datePattern(
    [
      ...(previousLists[0]?.points ?? []).map(toCall),
      thisStop,
      ...(subsequentLists[0]?.points ?? []).map(toCall),
    ],
    anchor,
  );

  const portions = [
    ...previousLists.slice(1).map((g) => toPortion(g, "joins", anchor)),
    ...subsequentLists.slice(1).map((g) => toPortion(g, "divides", anchor)),
  ].filter((p) => p.calls.length > 0);

  return { calls, portions };
}

/** An associated calling-point list -> a labelled portion. */
function toPortion(
  group: { list: RawCallingPointList; points: RawCallingPoint[] },
  kind: ServicePortion["kind"],
  anchor: Date,
): ServicePortion {
  const calls = datePattern(group.points.map(toCall), anchor);
  // For an onward portion the terminus is its last stop; for one joining us
  // it's where that portion started.
  const terminus = kind === "divides" ? calls[calls.length - 1] : calls[0];
  return {
    kind,
    terminusName: terminus?.name || undefined,
    cancelled: group.list.assocIsCancelled === true,
    changeRequired: group.list.serviceChangeRequired === true,
    calls,
  };
}

/*
 * There used to be an `enrichCallsWithDarwinPlatforms` backstop here that ran
 * when the service didn't resolve to a rid. It built a global
 * `(crs|HH:MM) -> platform` map across every train and every service day in
 * darwin_stop_forecast, so an unresolved service could be shown another train's
 * platform with no way to tell. A wrong platform is worse than no platform on a
 * concourse, so it's gone: platforms now come only from the resolved run (see
 * enrichWithDarwinProgress) or from LDBWS itself, and the UI states plainly
 * when a platform isn't known yet.
 */

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

  let d: RawServiceDetails;
  try {
    d = (await res.json()) as RawServiceDetails;
  } catch {
    return null;
  }

  let parsed: ParsedPattern;
  try {
    parsed = parseCallingPattern(d);
  } catch {
    // A shape we didn't anticipate should degrade to "unavailable", not 500.
    return null;
  }
  let calls = parsed.calls;
  const { portions } = parsed;

  // Resolve the run against Darwin first — it's still the only source for the
  // schedule, platforms, cancellation reasons, and (necessarily) any estimate
  // for a stop the train hasn't reached yet, since neither TRUST nor TD can
  // predict ahead of where the train has actually been. But WITHIN that
  // resolve, position/progress/actual-time/delay are already TRUST+TD
  // primary — see trustProgressForRid in service-progress.ts — because
  // Darwin's own actArr/actDep have shown up stale/out-of-order after a Kafka
  // replay (see CLAUDE.md), a class of bug TRUST/TD's append-only event log
  // doesn't have.
  const { calls: darwinCalls, progress: darwinProgress, rid } = await enrichWithDarwinProgress(calls);
  calls = darwinCalls;
  let finalProgress = darwinProgress;

  // A second, independent TD correlation as a forward-only safety net: when
  // the live nr_train_position snapshot is even fresher than the history rows
  // enrichWithDarwinProgress already saw, or when Darwin never resolved a rid
  // at all (missed activation after an outage), this can still find the train
  // by anonymous headcode/timing correlation.
  const nr = await enrichWithNrProgress(calls, rid).catch(() => null);
  if (nr) {
    // Crucially this only ever refines FORWARD. TD berth reports here are
    // anonymous (no rid), so letting them drag the front backwards would let
    // a mis-correlated report un-happen a stop the train demonstrably passed.
    // A fresher report can move the train on; it can never move it back.
    const darwinFront = frontIndex(calls);
    const nrFront = frontIndex(nr.calls);
    if (nrFront > darwinFront) {
      calls = calls.map((c, i) => ({ ...c, progress: nr.calls[i]?.progress ?? c.progress }));
      finalProgress = {
        ...finalProgress,
        tracking: true,
        positionState: "tracked",
        arrived: darwinProgress.tracking ? finalProgress.arrived : nr.progress.arrived,
        lastStopName: nr.progress.lastStopName,
        nextStopName: nr.progress.nextStopName,
        networkRail: true,
        nrLastLocation: nr.progress.nrLastLocation,
        nrLastEvent: nr.progress.nrLastEvent,
      };
    } else if (!darwinProgress.tracking) {
      // Darwin never resolved at all, so there is no front to move forward
      // from — TD is all we have, and it cleared the strict correlation.
      calls = nr.calls;
      finalProgress = { ...nr.progress, delayMinutes: finalProgress.delayMinutes };
    }
  }
  let coaches: ServiceCoach[] = normaliseList(d.formation?.coaches).map((c) => ({
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
    portions,
    progress: finalProgress,
    rid,
  };
}
