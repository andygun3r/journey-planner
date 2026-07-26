import { darwinStopForecast, darwinTrain, nrHeadcode, nrTrainPosition } from "@mainline/db";
import { and, eq, gt, inArray, like, sql } from "drizzle-orm";
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

interface NrPosition {
  location?: string;
  event?: string;
  reportedAgoSeconds?: number;
  latenessMinutes?: number;
}

function toNrPosition(r: {
  lastCrs: string | null;
  lastEvent: string | null;
  lastReportedAt: Date | null;
  lateness: number | null;
}): NrPosition {
  return {
    location: r.lastCrs ?? undefined,
    event: r.lastEvent ?? undefined,
    reportedAgoSeconds: r.lastReportedAt
      ? Math.round((Date.now() - r.lastReportedAt.getTime()) / 1000)
      : undefined,
    latenessMinutes:
      r.lateness !== null && r.lateness !== undefined ? Math.round(r.lateness / 60) : undefined,
  };
}

/**
 * Look up the Network Rail live position for a resolved Darwin rid.
 *
 * Tries two paths: the TRUST-keyed row (rid set by applyActivation matching
 * train_uid — reliable but only populated for TRUST movements, not TD berth
 * steps), then falls back to a direct TD lookup via nr_headcode's uid ->
 * headcode map. The TD fallback is unambiguous by construction — it looks up
 * one specific headcode for this train's own uid, not "whichever headcode
 * happens to be nearby" — so it needs no confidence guard, unlike
 * enrichWithNrProgress's headcode-proximity heuristic below.
 */
async function nrPositionForRid(rid: string): Promise<NrPosition | null> {
  const db = getDb();
  try {
    const rows = await db
      .select({
        lastCrs: nrTrainPosition.lastCrs,
        lastEvent: nrTrainPosition.lastEventType,
        lastReportedAt: nrTrainPosition.lastReportedAt,
        lateness: nrTrainPosition.lateness,
      })
      .from(nrTrainPosition)
      .where(eq(nrTrainPosition.rid, rid))
      .limit(1);
    if (rows[0]) return toNrPosition(rows[0]);
  } catch {
    return null;
  }

  try {
    const train = await db
      .select({ uid: darwinTrain.uid })
      .from(darwinTrain)
      .where(eq(darwinTrain.rid, rid))
      .limit(1);
    const uid = train[0]?.uid;
    if (!uid) return null;

    const hc = await db
      .select({ headcode: nrHeadcode.headcode })
      .from(nrHeadcode)
      .where(eq(nrHeadcode.uid, uid))
      .limit(1);
    const headcode = hc[0]?.headcode;
    if (!headcode) return null;

    const td = await db
      .select({
        lastCrs: nrTrainPosition.lastCrs,
        lastEvent: nrTrainPosition.lastEventType,
        lastReportedAt: nrTrainPosition.lastReportedAt,
        lateness: nrTrainPosition.lateness,
      })
      .from(nrTrainPosition)
      .where(eq(nrTrainPosition.trainId, `TD:${headcode}`))
      .limit(1);
    return td[0] ? toNrPosition(td[0]) : null;
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
): Promise<{ calls: ServiceCall[]; progress: ServiceProgress; rid?: string }> {
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
    rid,
  };
}

/**
 * DARWIN-INDEPENDENT live progress from the Network Rail Train Describer feed.
 *
 * The Darwin resolve (above) needs a one-time schedule/activation message that is
 * missed for trains already running after a feed outage. The NR TD (berth-step)
 * stream keeps flowing regardless and carries a headcode + a live CRS. This
 * resolver correlates that live position to THIS service by its calling pattern —
 * no rid, no activation — so the moving-train position survives Darwin gaps.
 *
 * Correlation is deliberately conservative: we accept a position only when
 * EXACTLY ONE fresh TD headcode sits at EXACTLY ONE of this service's remaining
 * stops within a timing tolerance. Any ambiguity → not tracking (never guess).
 */
export async function enrichWithNrProgress(
  calls: ServiceCall[],
): Promise<{ calls: ServiceCall[]; progress: ServiceProgress } | null> {
  const DBG = process.env.NR_DEBUG === "1";

  // Only INTERMEDIATE stops disambiguate. The origin has every departing train
  // sitting in it and the terminus every arriving one, so a headcode there tells
  // us nothing about which service it is. A headcode at an intermediate CRS of
  // this route is a strong, specific signal that it's this train mid-journey.
  const lastIdx = calls.length - 1;
  const routeStops = calls
    .map((c, i) => ({ i, crs: c.crs }))
    .filter((s): s is { i: number; crs: string } => Boolean(s.crs) && s.i > 0 && s.i < lastIdx);
  if (routeStops.length === 0) return null;

  const routeCrs = [...new Set(routeStops.map((s) => s.crs))];
  if (DBG) console.log("[nr-dbg] intermediate routeCrs", routeCrs.join(","));

  // Fresh TD berth positions (train_id 'TD:<headcode>') sitting at a route CRS,
  // reported within the last 10 minutes. TD rows carry the live headcode + CRS.
  const cutoff = new Date(Date.now() - 10 * 60_000);
  let rows: Array<{
    headcode: string | null;
    lastCrs: string | null;
    lastEvent: string | null;
    lastReportedAt: Date | null;
  }>;
  try {
    rows = await getDb()
      .select({
        headcode: nrTrainPosition.headcode,
        lastCrs: nrTrainPosition.lastCrs,
        lastEvent: nrTrainPosition.lastEventType,
        lastReportedAt: nrTrainPosition.lastReportedAt,
      })
      .from(nrTrainPosition)
      .where(
        and(
          like(nrTrainPosition.trainId, "TD:%"),
          inArray(nrTrainPosition.lastCrs, routeCrs),
          gt(nrTrainPosition.lastReportedAt, cutoff),
        ),
      );
  } catch {
    return null; // NR tables not ready
  }
  if (DBG) console.log("[nr-dbg] fresh TD rows at intermediate CRS:", rows.length, rows.map((r) => `${r.headcode}@${r.lastCrs}`).join(" "));
  if (rows.length === 0) return null;

  // Group the matching positions by headcode. Each distinct headcode at an
  // intermediate stop is a candidate train; more than one means we can't tell
  // which is "this" service, so we refuse (never guess).
  const byHeadcode = new Map<string, { stopIndex: number; crs: string; event: string | null }[]>();
  for (const r of rows) {
    if (!r.headcode || !r.lastCrs) continue;
    const stopsHere = routeStops.filter((s) => s.crs === r.lastCrs);
    if (stopsHere.length === 0) continue;
    // If the route visits this CRS more than once, take the furthest-along one
    // (the train's current front, not a stop it left earlier).
    const stopIndex = Math.max(...stopsHere.map((s) => s.i));
    const list = byHeadcode.get(r.headcode) ?? [];
    list.push({ stopIndex, crs: r.lastCrs, event: r.lastEvent });
    byHeadcode.set(r.headcode, list);
  }

  if (DBG) console.log("[nr-dbg] distinct headcodes at intermediate stops:", byHeadcode.size, JSON.stringify([...byHeadcode]));
  // Exactly one physical train at an intermediate stop of this route → confident.
  if (byHeadcode.size !== 1) return null;

  const positions = [...byHeadcode.values()][0]!;
  // The train's current front is its furthest-along reported intermediate stop.
  const match = positions.reduce((a, b) => (b.stopIndex > a.stopIndex ? b : a));
  const hereName = calls[match.stopIndex]?.name ?? match.crs;

  // Mark progress: everything up to & including the live CRS has been passed;
  // the live CRS is "current"; the rest are upcoming. This is what the page's
  // moving-train icon keys off (first `upcoming` after the current front).
  const enriched = calls.map((c, i) => {
    if (i < match.stopIndex) return { ...c, progress: "departed" as const };
    if (i === match.stopIndex) return { ...c, progress: "current" as const };
    return { ...c, progress: "upcoming" as const };
  });

  const nextName = calls[match.stopIndex + 1]?.name;
  const arrived = match.stopIndex === calls.length - 1;

  if (DBG) console.log("[nr-dbg] ✅ NR MATCH at", hereName, "→ next", nextName);
  return {
    calls: enriched,
    progress: {
      tracking: true,
      lastStopName: hereName,
      nextStopName: nextName,
      arrived,
      networkRail: true,
      nrLastLocation: hereName,
      nrLastEvent: match.event ?? "PASS",
    },
  };
}
