import { darwinStopForecast, darwinTrain, nrHeadcode, nrTrainPosition } from "@mainline/db";
import { and, eq, gt, inArray, like } from "drizzle-orm";
import { getDb } from "./db";
import type { PositionState, ServiceCall, ServiceProgress } from "./service-details";
import {
  alignCallsToRun,
  callKeys,
  pickBestRun,
  plausibleTdMatch,
  type CandidateRun,
  type TdReport,
} from "./service-match";
import { hhmmToIso, londonDateKey, minutesLate } from "./uk-time";

/**
 * Enriches an LDBWS service's calling points with LIVE PROGRESS from the Darwin
 * feed we ingest — no GPS (that doesn't exist for GB rail); progress is derived
 * from Darwin's actual/estimated times at each timing point.
 *
 * Resolve step: LDBWS gives a serviceID, not a Darwin rid. Candidate runs are
 * drawn from the current and previous service day (`darwin_train.ssd`), scored
 * on calling-pattern overlap, and disambiguated by which run is actually due
 * around now — see service-match.ts for why each of those matters and what
 * broke without them. If two candidates remain indistinguishable we return
 * nothing rather than guess.
 *
 * From the actual (act_dep/act_arr) vs estimated times we compute, per stop:
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
  schedPass: string | null;
  estArr: string | null;
  estDep: string | null;
  actArr: string | null;
  actDep: string | null;
  platform: string | null;
}

const NOT_TRACKING: ServiceProgress = {
  tracking: false,
  positionState: "not-tracked",
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

/** Reports older than this are stale — say nothing rather than show a ghost. */
const STALE_AFTER_MS = 10 * 60_000;

/** rid -> the TD headcode that belongs to it, via the NROD schedule feed. */
async function headcodeForRid(rid: string): Promise<string | null> {
  const db = getDb();
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
  return hc[0]?.headcode ?? null;
}

/**
 * Look up the Network Rail live position for a resolved Darwin rid.
 *
 * Tries two paths: the TRUST-keyed row (rid set by applyActivation matching
 * train_uid — reliable but only populated for TRUST movements, not TD berth
 * steps), then falls back to a direct TD lookup via nr_headcode's uid ->
 * headcode map. The TD fallback is NOT unambiguous by construction: headcodes
 * are reused by many unrelated physical trains across the day (and even
 * concurrently, on other routes), and nr_train_position's `TD:<headcode>` row
 * is just whichever train most recently reported that headcode anywhere on
 * the network — it can belong to a different service entirely. Guard against
 * that by only trusting it when the reported CRS is one of this train's own
 * route stops, and when the report is recent.
 */
async function nrPositionForRid(rid: string, routeCrs: Set<string>): Promise<NrPosition | null> {
  const db = getDb();
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS);
  try {
    const rows = await db
      .select({
        lastCrs: nrTrainPosition.lastCrs,
        lastEvent: nrTrainPosition.lastEventType,
        lastReportedAt: nrTrainPosition.lastReportedAt,
        lateness: nrTrainPosition.lateness,
      })
      .from(nrTrainPosition)
      .where(and(eq(nrTrainPosition.rid, rid), gt(nrTrainPosition.lastReportedAt, staleCutoff)))
      .limit(1);
    if (rows[0]) return toNrPosition(rows[0]);
  } catch {
    return null;
  }

  try {
    const headcode = await headcodeForRid(rid);
    if (!headcode) return null;

    const td = await db
      .select({
        lastCrs: nrTrainPosition.lastCrs,
        lastEvent: nrTrainPosition.lastEventType,
        lastReportedAt: nrTrainPosition.lastReportedAt,
        lateness: nrTrainPosition.lateness,
      })
      .from(nrTrainPosition)
      .where(
        and(
          eq(nrTrainPosition.trainId, `TD:${headcode}`),
          gt(nrTrainPosition.lastReportedAt, staleCutoff),
        ),
      )
      .limit(1);
    const row = td[0];
    // This headcode may currently belong to a different physical train
    // elsewhere on the network — only trust it if the location it's
    // reporting is actually on this train's own route.
    if (!row || !row.lastCrs || !routeCrs.has(row.lastCrs)) return null;
    return toNrPosition(row);
  } catch {
    return null;
  }
}

/** The service days a currently-running train could belong to, London-local. */
function candidateServiceDays(now: Date): string[] {
  return [londonDateKey(new Date(now.getTime() - 86_400_000)), londonDateKey(now)];
}

/**
 * Load every plausible Darwin run for this calling pattern.
 *
 * Bounded two ways the previous version wasn't: to the current/previous service
 * day, and to runs that are not deactivated. Without the date bound this pulled
 * every rid ever recorded at every station on the route.
 */
async function loadCandidateRuns(crsList: string[], now: Date): Promise<Array<CandidateRun<DarwinStop>>> {
  const db = getDb();
  const days = candidateServiceDays(now);

  const heads = await db
    .selectDistinct({ rid: darwinStopForecast.rid, ssd: darwinTrain.ssd })
    .from(darwinStopForecast)
    .innerJoin(darwinTrain, eq(darwinTrain.rid, darwinStopForecast.rid))
    .where(
      and(
        inArray(darwinStopForecast.crs, crsList),
        inArray(darwinTrain.ssd, days),
        eq(darwinTrain.deactivated, false),
      ),
    );
  if (heads.length === 0) return [];

  const ssdByRid = new Map(heads.map((h) => [h.rid, String(h.ssd)]));
  const rids = [...ssdByRid.keys()];

  const rows = await db
    .select({
      rid: darwinStopForecast.rid,
      seq: darwinStopForecast.seq,
      crs: darwinStopForecast.crs,
      schedArr: darwinStopForecast.schedArr,
      schedDep: darwinStopForecast.schedDep,
      schedPass: darwinStopForecast.schedPass,
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

  return [...byRid.entries()].map(([rid, stops]) => ({
    rid,
    ssd: ssdByRid.get(rid) ?? londonDateKey(now),
    stops,
  }));
}

export async function enrichWithDarwinProgress(
  calls: ServiceCall[],
): Promise<{ calls: ServiceCall[]; progress: ServiceProgress; rid?: string }> {
  const keys = callKeys(calls);
  if (keys.size === 0) return { calls, progress: NOT_TRACKING };

  const now = new Date();
  const crsList = [...new Set([...keys].map((k) => k.split("|")[0]!))];

  let runs: Array<CandidateRun<DarwinStop>>;
  try {
    runs = await loadCandidateRuns(crsList, now);
  } catch {
    return { calls, progress: NOT_TRACKING };
  }

  const pick = pickBestRun(runs, keys, now.getTime());
  if (!pick) {
    // We couldn't identify the run. The train may well be running fine — we
    // just can't say where it is, and saying so is the honest answer.
    return { calls, progress: { ...NOT_TRACKING, positionState: "awaiting-report" } };
  }

  const rid = pick.run.rid;
  // Passing points are kept: a train passing a station without calling there is
  // real progress, even though LDBWS never lists it as a calling point.
  const ordered = pick.stops.filter((s) => s.crs);

  // Walk both sequences in order so a route calling twice at one station gets
  // two distinct rows rather than both reading the last one.
  const alignment = alignCallsToRun(
    calls.map((c) => c.crs),
    ordered,
  );

  // The live front: the last stop with an actual (arrived/departed) time.
  let lastPassedIdx = -1;
  ordered.forEach((s, i) => {
    if (s.actDep || s.actArr) lastPassedIdx = i;
  });

  const finalStop = ordered[ordered.length - 1];
  // Darwin's own schedule for this rid can end short of the LDBWS-advertised
  // destination (e.g. a reversal/unit change at an intermediate station that
  // Darwin doesn't carry forward under the same rid) — only call the journey
  // "arrived" when Darwin's last-known stop IS the actual last LDBWS call,
  // not just the last stop Darwin happens to know about.
  const lastLdbwsCrs = [...calls].reverse().find((c) => c.crs)?.crs;
  const arrived = Boolean(
    finalStop && (finalStop.actArr || finalStop.actDep) && finalStop.crs === lastLdbwsCrs,
  );

  // Overlay Network Rail's finer live position (correlated by rid via activation).
  // TD berth steps report far more often than Darwin's timing-point actuals,
  // so NR's position is frequently ahead of lastPassedIdx.
  const routeCrs = new Set(calls.map((c) => c.crs).filter((c): c is string => Boolean(c)));
  const nr = await nrPositionForRid(rid, routeCrs).catch(() => null);
  const nrLocationName = nr?.location
    ? (calls.find((c) => c.crs === nr.location)?.name ?? nr.location)
    : undefined;

  // Effective "last passed" index: NR's location if it's at or beyond Darwin's
  // own last-known stop (NR only ever refines forward, since a fresher berth
  // report can't un-happen), otherwise Darwin's.
  let effectiveLastPassedIdx = lastPassedIdx;
  if (nr?.location) {
    const nrIdx = ordered.findIndex((s) => s.crs === nr.location);
    if (nrIdx > effectiveLastPassedIdx) effectiveLastPassedIdx = nrIdx;
  }

  // True once every Darwin-known stop has an actual time but the LDBWS journey
  // continues beyond Darwin's own data (see `arrived` above) — the train has run
  // off the end of what Darwin knows without reaching the real destination.
  const ranOffDarwinData =
    !arrived && ordered.length > 0 && effectiveLastPassedIdx === ordered.length - 1;
  let markedCurrentForOverrun = false;

  // Carried forward so a call Darwin doesn't know about still lands on the
  // right side of the live front instead of defaulting to "upcoming".
  let lastKnownIdx = -1;
  const enriched = calls.map((c, i) => {
    const runIdx = alignment[i];
    if (runIdx === undefined) {
      // The first LDBWS call BEYOND the end of Darwin's data becomes "current":
      // the last confirmed position was the stop before it. The
      // `lastKnownIdx === ordered.length - 1` guard is what makes it "beyond" —
      // without it, an unmatched call at the HEAD of the route (Darwin schedules
      // can begin partway through the journey) would be picked up first and the
      // train marked as sitting at its origin when it is in fact near the end.
      if (
        ranOffDarwinData &&
        !markedCurrentForOverrun &&
        c.crs &&
        lastKnownIdx === ordered.length - 1
      ) {
        markedCurrentForOverrun = true;
        return { ...c, progress: "current" as const };
      }
      if (lastKnownIdx >= 0 && lastKnownIdx < effectiveLastPassedIdx) {
        return { ...c, progress: "departed" as const };
      }
      return c;
    }
    lastKnownIdx = runIdx;
    const d = ordered[runIdx]!;

    // The live front is always "current" — even if it only has actArr (arrived,
    // still at the platform, not yet actDep) or NR has moved the front past a
    // stop Darwin hasn't itself marked actDep for yet. Anything strictly before
    // the front has necessarily been left behind, whatever its own actual-time
    // state (a gap there is a data gap, not a still-current stop).
    let progress: ServiceCall["progress"];
    if (runIdx === effectiveLastPassedIdx) progress = "current";
    else if (runIdx < effectiveLastPassedIdx) progress = "departed";
    else progress = "upcoming";

    const actual = (d.actArr ?? d.actDep)?.slice(0, 5);
    const estimate = d.estArr ?? d.estDep ?? d.schedArr ?? d.schedDep ?? d.schedPass;
    const anchor = c.scheduledIso ? new Date(c.scheduledIso) : now;

    return {
      ...c,
      platform: c.platform ?? d.platform ?? undefined,
      progress,
      actual: actual ?? c.actual,
      actualIso: actual ? hhmmToIso(actual, anchor) : c.actualIso,
      estimatedArrivalIso: hhmmToIso(estimate, anchor),
    };
  });

  // The summary banner and the per-stop markers MUST name the same stop. They
  // didn't: the markers used the NR-refined front while the banner used
  // Darwin's own last timing point, so whenever a berth report was ahead of
  // Darwin (which is most of the time) the two disagreed on screen.
  const frontIdx = effectiveLastPassedIdx;
  const lastPassed = frontIdx >= 0 ? ordered[frontIdx] : undefined;
  const nextStop = frontIdx >= 0 ? ordered[frontIdx + 1] : ordered[0];
  const nameOf = (s?: DarwinStop) =>
    s?.crs ? (calls.find((c) => c.crs === s.crs)?.name ?? s.crs) : undefined;

  const delayMinutes = lastPassed
    ? minutesLate(
        hhmmToIso(lastPassed.schedDep ?? lastPassed.schedArr ?? lastPassed.schedPass, now),
        hhmmToIso(lastPassed.actDep ?? lastPassed.actArr, now),
      )
    : undefined;

  return {
    calls: enriched,
    progress: {
      tracking: true,
      positionState: frontIdx >= 0 || nr ? "tracked" : "awaiting-report",
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
 * resolver correlates that live position to THIS service — so the moving-train
 * position survives Darwin gaps.
 *
 * Two paths, in order of confidence:
 *
 *  1. If Darwin DID resolve a rid, we know this train's headcode from the NROD
 *     schedule feed, so we can ask for that headcode specifically. Unambiguous.
 *  2. Otherwise, correlate anonymously by calling pattern — but require the
 *     report to be time-plausible against the schedule, not merely to be at a
 *     station this route happens to serve. Any ambiguity → not tracking.
 *
 * The old version had only a weakened form of (2): "exactly one headcode is at
 * an intermediate stop of this route", with no timing check at all despite its
 * docstring promising one. Any unrelated train standing at a shared station
 * satisfied that, and its position was then adopted wholesale.
 */
export async function enrichWithNrProgress(
  calls: ServiceCall[],
  rid?: string,
): Promise<{ calls: ServiceCall[]; progress: ServiceProgress } | null> {
  const DBG = process.env.NR_DEBUG === "1";

  // Only INTERMEDIATE stops disambiguate. The origin has every departing train
  // sitting in it and the terminus every arriving one, so a headcode there tells
  // us nothing about which service it is.
  const lastIdx = calls.length - 1;
  const routeStops = calls
    .map((c, i) => ({
      index: i,
      crs: c.crs,
      scheduledMs: c.scheduledIso ? Date.parse(c.scheduledIso) : undefined,
    }))
    .filter((s): s is { index: number; crs: string; scheduledMs: number | undefined } =>
      Boolean(s.crs) && s.index > 0 && s.index < lastIdx,
    );
  if (routeStops.length === 0) return null;

  const routeCrs = [...new Set(routeStops.map((s) => s.crs))];
  if (DBG) console.log("[nr-dbg] intermediate routeCrs", routeCrs.join(","));

  const cutoff = new Date(Date.now() - STALE_AFTER_MS);

  // Path 1: we know which headcode is ours, so ask for it by name.
  let ownHeadcode: string | null = null;
  if (rid) {
    ownHeadcode = await headcodeForRid(rid).catch(() => null);
  }

  let rows: TdReport[];
  try {
    const base = await getDb()
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
          ...(ownHeadcode ? [eq(nrTrainPosition.headcode, ownHeadcode)] : []),
        ),
      );
    rows = base.map((r) => ({
      headcode: r.headcode,
      crs: r.lastCrs,
      reportedAtMs: r.lastReportedAt ? r.lastReportedAt.getTime() : Number.NaN,
      event: r.lastEvent,
    }));
  } catch {
    return null; // NR tables not ready
  }
  rows = rows.filter((r) => Number.isFinite(r.reportedAtMs));
  if (DBG) {
    console.log(
      "[nr-dbg] fresh TD rows at intermediate CRS:",
      rows.length,
      rows.map((r) => `${r.headcode}@${r.crs}`).join(" "),
      ownHeadcode ? `(restricted to own headcode ${ownHeadcode})` : "(anonymous correlation)",
    );
  }
  if (rows.length === 0) return null;

  const match = plausibleTdMatch(rows, routeStops);
  if (!match) {
    if (DBG) console.log("[nr-dbg] ✗ no unambiguous, time-plausible TD match");
    return null;
  }

  const hereName = calls[match.stopIndex]?.name ?? match.crs;

  // Mark progress: everything up to & including the live CRS has been passed;
  // the live CRS is "current"; the rest are upcoming. This is what the page's
  // moving-train icon keys off.
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
      positionState: "tracked",
      lastStopName: hereName,
      nextStopName: nextName,
      arrived,
      networkRail: true,
      nrLastLocation: hereName,
      nrLastEvent: match.event ?? "PASS",
    },
  };
}

/** Index of the live front, or -1. Used to keep NR from dragging progress backwards. */
export function frontIndex(calls: ServiceCall[]): number {
  return calls.findIndex((c) => c.progress === "current");
}
