import { darwinStopForecast, darwinTrain, nrTrainPosition } from "@mainline/db";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import type { ServiceCall, ServiceProgress } from "./service-details";

/**
 * Enriches an LDBWS service's calling points with LIVE PROGRESS from the Darwin
 * feed we ingest — no GPS (that doesn't exist for GB rail); progress is derived
 * from Darwin's actual/estimated times at each timing point.
 *
 * Resolve step: LDBWS gives a serviceID, not a Darwin rid. We resolve the rid
 * by matching the ORIGIN calling point (crs + scheduled departure minute) to a
 * darwin_stop_forecast row, then load that rid's full stop list. From the
 * actual (act_dep/act_arr) vs estimated times we compute, per stop:
 *   departed  = train has an actual time here (already gone)
 *   current   = the last stop with an actual time (train is just past here)
 *   upcoming  = only estimated (train hasn't reached it)
 */

interface DarwinStop {
  rid: string;
  seq: number;
  crs: string | null;
  schedArr: string | null;
  schedDep: string | null;
  estArr: string | null;
  estDep: string | null;
  actArr: string | null;
  actDep: string | null;
  platform: string | null;
}

const NOT_TRACKING: ServiceProgress = {
  tracking: false,
  arrived: false,
  networkRail: false,
};

/** Look up the Network Rail live position for a resolved Darwin rid. */
async function nrPositionForRid(rid: string): Promise<{
  location?: string;
  event?: string;
  reportedAgoSeconds?: number;
  latenessMinutes?: number;
} | null> {
  try {
    const rows = await getDb()
      .select({
        lastCrs: nrTrainPosition.lastCrs,
        lastEvent: nrTrainPosition.lastEventType,
        lastReportedAt: nrTrainPosition.lastReportedAt,
        lateness: nrTrainPosition.lateness,
      })
      .from(nrTrainPosition)
      .where(eq(nrTrainPosition.rid, rid))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      location: r.lastCrs ?? undefined,
      event: r.lastEvent ?? undefined,
      reportedAgoSeconds: r.lastReportedAt
        ? Math.round((Date.now() - r.lastReportedAt.getTime()) / 1000)
        : undefined,
      latenessMinutes:
        r.lateness !== null && r.lateness !== undefined ? Math.round(r.lateness / 60) : undefined,
    };
  } catch {
    return null;
  }
}

/** "HH:MM[:SS]" UK-local -> ISO instant today (handles the post-midnight case). */
function toIso(hhmm: string | null): string | undefined {
  if (!hhmm) return undefined;
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) return undefined;
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  const nowMin = Number(g("hour")) * 60 + Number(g("minute"));
  const stopMin = Number(m[1]) * 60 + Number(m[2]);
  // If the stop time is far behind "now", it's tomorrow (past midnight).
  let dayShift = 0;
  if (stopMin - nowMin < -720) dayShift = 1;
  const base = new Date(now.getTime() + dayShift * 86_400_000);
  const bp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(base);
  const bg = (t: string) => bp.find((p) => p.type === t)!.value;
  // London offset for that date.
  const asUtc = Date.UTC(Number(bg("year")), Number(bg("month")) - 1, Number(bg("day")), Number(m[1]), Number(m[2]));
  const probe = new Date(asUtc);
  const off = londonOffsetMinutes(probe);
  return new Date(asUtc - off * 60000).toISOString();
}

function londonOffsetMinutes(d: Date): number {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return Math.round((asUtc - d.getTime()) / 60000);
}

function minutesLate(schedHhmm: string | null, liveHhmm: string | null): number | undefined {
  if (!schedHhmm || !liveHhmm) return undefined;
  const s = /^(\d{2}):(\d{2})/.exec(schedHhmm);
  const l = /^(\d{2}):(\d{2})/.exec(liveHhmm);
  if (!s || !l) return undefined;
  let delta = (Number(l[1]) * 60 + Number(l[2])) - (Number(s[1]) * 60 + Number(s[2]));
  if (delta < -720) delta += 1440;
  return delta;
}

/**
 * Resolve the LDBWS service to a Darwin rid by finding the candidate train
 * whose calling pattern best overlaps the LDBWS calls (crs + scheduled minute).
 * The origin gives us candidate rids cheaply; the full-pattern score prevents
 * matching a different train that merely shares the origin station.
 */
async function resolveRid(
  originCrs: string,
  originHhmm: string,
  callKeys: Set<string>,
): Promise<DarwinStop[] | null> {
  const db = getDb();
  // Candidate rids: trains whose origin-station stop matches crs + scheduled time.
  let candidates: Array<{ rid: string }>;
  try {
    candidates = await db
      .select({ rid: darwinStopForecast.rid })
      .from(darwinStopForecast)
      .where(and(eq(darwinStopForecast.crs, originCrs)));
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;

  const rids = [...new Set(candidates.map((c) => c.rid))];
  const rows = await db
    .select({
      rid: darwinStopForecast.rid,
      seq: darwinStopForecast.seq,
      crs: darwinStopForecast.crs,
      schedArr: darwinStopForecast.schedArr,
      schedDep: darwinStopForecast.schedDep,
      estArr: darwinStopForecast.estArr,
      estDep: darwinStopForecast.estDep,
      actArr: darwinStopForecast.actArr,
      actDep: darwinStopForecast.actDep,
      platform: darwinStopForecast.platform,
    })
    .from(darwinStopForecast)
    .where(inArray(darwinStopForecast.rid, rids));

  const byRid = new Map<string, DarwinStop[]>();
  for (const r of rows) {
    const list = byRid.get(r.rid) ?? [];
    list.push(r);
    byRid.set(r.rid, list);
  }

  // Score each candidate: it must have the origin at the right time, and we
  // pick the one whose stops overlap the LDBWS calling pattern the most.
  let best: { stops: DarwinStop[]; score: number } | null = null;
  for (const [, stops] of byRid) {
    const hasOrigin = stops.some(
      (s) =>
        s.crs === originCrs &&
        (s.schedDep?.slice(0, 5) === originHhmm || s.schedArr?.slice(0, 5) === originHhmm),
    );
    if (!hasOrigin) continue;

    let score = 0;
    for (const s of stops) {
      if (!s.crs) continue;
      for (const time of [s.schedDep, s.schedArr]) {
        if (time && callKeys.has(`${s.crs}|${time.slice(0, 5)}`)) {
          score++;
          break;
        }
      }
    }
    if (!best || score > best.score) best = { stops: stops.sort((a, b) => a.seq - b.seq), score };
  }

  // Require a real overlap (origin + at least one more stop) to trust the match.
  if (!best || best.score < 2) return null;
  return best.stops;
}

export async function enrichWithDarwinProgress(
  calls: ServiceCall[],
  originCrs: string | undefined,
  originDep: string | undefined,
): Promise<{ calls: ServiceCall[]; progress: ServiceProgress }> {
  if (!originCrs || !originDep) return { calls, progress: NOT_TRACKING };

  // The LDBWS calling pattern as (crs|HH:MM) keys, to validate the rid match.
  const callKeys = new Set<string>();
  for (const c of calls) {
    if (c.crs && c.scheduled) callKeys.add(`${c.crs}|${c.scheduled.slice(0, 5)}`);
  }

  let stops: DarwinStop[] | null;
  try {
    stops = await resolveRid(originCrs, originDep.slice(0, 5), callKeys);
  } catch {
    return { calls, progress: NOT_TRACKING };
  }
  if (!stops || stops.length === 0) return { calls, progress: NOT_TRACKING };

  // Index Darwin stops by CRS for matching to LDBWS calls.
  const darwinByCrs = new Map<string, DarwinStop>();
  for (const s of stops) if (s.crs) darwinByCrs.set(s.crs, s);

  // The "current position": the last stop with an actual (departed/arrived) time.
  let lastPassedIdx = -1;
  const ordered = stops.filter((s) => s.crs);
  ordered.forEach((s, i) => {
    if (s.actDep || s.actArr) lastPassedIdx = i;
  });
  const finalStop = ordered[ordered.length - 1];
  const arrived = Boolean(finalStop && (finalStop.actArr || finalStop.actDep));

  const lastStopName = undefined; // resolved from calls below
  const enriched = calls.map((c) => {
    if (!c.crs) return c;
    const d = darwinByCrs.get(c.crs);
    if (!d) return c;

    const idxInOrdered = ordered.indexOf(d);
    let progress: ServiceCall["progress"];
    if (d.actDep || d.actArr) progress = "departed";
    else if (idxInOrdered === lastPassedIdx + 1) progress = "current";
    else progress = "upcoming";

    return {
      ...c,
      platform: c.platform ?? d.platform ?? undefined,
      progress,
      actual: (d.actArr ?? d.actDep)?.slice(0, 5),
      estimatedArrivalIso: toIso(d.estArr ?? d.estDep ?? d.schedArr ?? d.schedDep),
    };
  });

  // Overall progress summary.
  const lastPassed = lastPassedIdx >= 0 ? ordered[lastPassedIdx] : undefined;
  const nextStop = ordered[lastPassedIdx + 1];
  const nameOf = (s?: DarwinStop) =>
    s?.crs ? (calls.find((c) => c.crs === s.crs)?.name ?? s.crs) : undefined;

  const delayMinutes = lastPassed
    ? minutesLate(lastPassed.schedDep ?? lastPassed.schedArr, lastPassed.actDep ?? lastPassed.actArr)
    : undefined;

  // Overlay Network Rail's finer live position (correlated by rid via activation).
  const rid = stops[0]?.rid;
  const nr = rid ? await nrPositionForRid(rid) : null;
  const nrLocationName = nr?.location
    ? (calls.find((c) => c.crs === nr.location)?.name ?? nr.location)
    : undefined;

  void lastStopName;
  return {
    calls: enriched,
    progress: {
      tracking: true,
      lastStopName: nameOf(lastPassed),
      nextStopName: nameOf(nextStop),
      delayMinutes: delayMinutes !== undefined && delayMinutes > 1 ? delayMinutes : undefined,
      arrived,
      networkRail: Boolean(nr),
      nrLastLocation: nrLocationName,
      nrLastEvent: nr?.event,
      nrReportedAgoSeconds: nr?.reportedAgoSeconds,
      nrLatenessMinutes: nr?.latenessMinutes,
    },
  };
}
