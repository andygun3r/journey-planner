import {
  darwinStopForecast,
  darwinTrain,
  nrHeadcode,
  nrTrainPosition,
  nrTrainPositionHistory,
} from "@mainline/db";
import { and, eq, gt, inArray, like, sql } from "drizzle-orm";
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
import { hhmmToIso, londonDateKey, minutesLate, ukHhmm } from "./uk-time";

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
 * Both the TRUST-keyed row (rid set by applyActivation matching train_uid)
 * and the TD-keyed row (rid set by applyBerthStep matching headcode -> uid ->
 * rid, best-effort) can carry this rid — TD reports far more often and at
 * finer granularity, so among rows sharing a rid we want whichever is
 * currently freshest, not whichever the DB happens to return first.
 *
 * Falls back to a direct TD lookup via nr_headcode's uid -> headcode map only
 * when neither row resolved this rid (e.g. an ambiguous headcode, or the
 * reference cache mid-reload). That fallback is NOT unambiguous by
 * construction: headcodes are reused by many unrelated physical trains across
 * the day (and even concurrently, on other routes), and nr_train_position's
 * `TD:<headcode>` row is just whichever train most recently reported that
 * headcode anywhere on the network — it can belong to a different service
 * entirely. Guard against that by only trusting it when the reported CRS is
 * one of this train's own route stops, and when the report is recent.
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
      .orderBy(sql`${nrTrainPosition.lastReportedAt} desc`)
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

interface TrustStop {
  /** Index into `ordered` (the Darwin-sourced, seq-ordered stop list). */
  runIdx: number;
  reportedAt: Date;
  /** TRUST-only: TD history rows carry no lateness. Seconds, +late/-early. */
  latenessSeconds: number | null;
}

/**
 * The train's actual passage through this rid's stops, per TRUST movements +
 * TD berth steps — not Darwin's actArr/actDep.
 *
 * TRUST/TD are retrospective event logs with no native notion of a schedule's
 * stop order (see nr_train_position_history's schema comment), so each row is
 * matched back onto `ordered` by CRS, picking whichever of that route's
 * visits to the CRS (a route can call twice) is nearest in scheduled time —
 * same disambiguation `alignCallsToRun` uses for Darwin's own data. History
 * rows are then walked in report order to build a monotonic front: a later
 * report can only advance the position, never retreat it, so a mis-ordered or
 * out-of-sequence row can't drag the train backwards on screen.
 */
async function trustProgressForRid(
  rid: string,
  ordered: Array<{ crs: string | null }>,
): Promise<TrustStop[]> {
  const db = getDb();
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS);

  let rows: Array<{
    lastCrs: string | null;
    reportedAt: Date;
    lateness: number | null;
    trainId: string;
  }>;
  try {
    rows = await db
      .select({
        lastCrs: nrTrainPositionHistory.lastCrs,
        reportedAt: nrTrainPositionHistory.reportedAt,
        lateness: nrTrainPositionHistory.lateness,
        trainId: nrTrainPositionHistory.trainId,
      })
      .from(nrTrainPositionHistory)
      .where(and(eq(nrTrainPositionHistory.rid, rid), gt(nrTrainPositionHistory.reportedAt, staleCutoff)))
      .orderBy(sql`${nrTrainPositionHistory.reportedAt} asc`);
  } catch {
    return [];
  }

  const byCrs = new Map<string, number[]>();
  ordered.forEach((s, i) => {
    if (!s.crs) return;
    const list = byCrs.get(s.crs) ?? [];
    list.push(i);
    byCrs.set(s.crs, list);
  });

  const out: TrustStop[] = [];
  let front = -1;
  for (const r of rows) {
    if (!r.lastCrs) continue;
    const candidates = byCrs.get(r.lastCrs);
    if (!candidates || candidates.length === 0) continue;

    // Of this route's visits to that CRS, take the one nearest the current
    // front (index distance, not clock time — rows arrive in report order
    // already, so "nearest to where we are" is the natural disambiguator for
    // a route that calls at the same CRS twice, e.g. a circular or reversal).
    let best = candidates[0]!;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const idx of candidates) {
      const gap = Math.abs(idx - Math.max(front, 0));
      if (gap < bestGap) {
        bestGap = gap;
        best = idx;
      }
    }
    if (best < front) continue; // retrospective-but-stale report; ignore

    front = best;
    // TD rows are keyed "TD:<headcode>"; TRUST rows by TRUST's own trainId —
    // only TRUST carries a real per-event lateness figure.
    const latenessSeconds = r.trainId.startsWith("TD:") ? null : r.lateness;
    out.push({
      runIdx: best,
      reportedAt: r.reportedAt,
      latenessSeconds,
    });
  }
  return out;
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
  const DBG = process.env.NR_DEBUG === "1";
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
  if (DBG) {
    console.log(
      "[match-dbg] candidate runs:",
      runs.map((r) => `${r.rid} (ssd ${r.ssd}, ${r.stops.length} stops)`).join(" | ") || "(none)",
    );
  }

  const pick = pickBestRun(runs, keys, now.getTime());
  if (!pick) {
    if (DBG) console.log("[match-dbg] ✗ no run cleared the bar — awaiting-report");
    // We couldn't identify the run. The train may well be running fine — we
    // just can't say where it is, and saying so is the honest answer.
    return { calls, progress: { ...NOT_TRACKING, positionState: "awaiting-report" } };
  }

  const rid = pick.run.rid;
  if (DBG) {
    console.log(
      `[match-dbg] ✅ picked rid ${rid} — matched ${pick.score.matched} stops, coverage ${(pick.score.coverage * 100).toFixed(0)}%`,
    );
  }
  // Passing points are kept: a train passing a station without calling there is
  // real progress, even though LDBWS never lists it as a calling point.
  const ordered = pick.stops.filter((s) => s.crs);

  // Walk both sequences in order so a route calling twice at one station gets
  // two distinct rows rather than both reading the last one.
  const alignment = alignCallsToRun(
    calls.map((c) => c.crs),
    ordered,
  );

  // TRUST movements + TD berth steps are the primary source of "where has the
  // train actually been" — see CLAUDE.md and the fix history on this file:
  // Darwin's own actArr/actDep have shown up stale/out-of-order after a Kafka
  // replay, which is exactly the class of bug NR's own event log doesn't have
  // (each row is a distinct, ordered report, not a mutable per-stop cell an
  // old message can clobber). Darwin's actArr/actDep still seed the front
  // ONLY when this rid has no TRUST/TD history at all (e.g. very early in the
  // run, before the first movement report lands).
  const trustStops = await trustProgressForRid(rid, ordered).catch(() => []);
  const trustFront = trustStops.at(-1);
  if (DBG) {
    console.log(
      `[match-dbg] TRUST/TD history: ${trustStops.length} report(s) for rid ${rid}` +
        (trustFront
          ? `, front at stop ${trustFront.runIdx} (${ordered[trustFront.runIdx]?.crs ?? "?"}), lateness ${trustFront.latenessSeconds ?? "n/a"}s`
          : " — none, falling back to Darwin actArr/actDep"),
    );
  }

  let lastPassedIdx = -1;
  if (trustFront) {
    lastPassedIdx = trustFront.runIdx;
  } else {
    ordered.forEach((s, i) => {
      if (s.actDep || s.actArr) lastPassedIdx = i;
    });
  }

  const finalStop = ordered[ordered.length - 1];
  // Darwin's own schedule for this rid can end short of the LDBWS-advertised
  // destination (e.g. a reversal/unit change at an intermediate station that
  // Darwin doesn't carry forward under the same rid) — only call the journey
  // "arrived" when the last-known stop IS the actual last LDBWS call, not
  // just the last stop Darwin happens to know about.
  const lastLdbwsCrs = [...calls].reverse().find((c) => c.crs)?.crs;
  const reachedFinalStop = trustFront
    ? trustFront.runIdx === ordered.length - 1
    : Boolean(finalStop && (finalStop.actArr || finalStop.actDep));
  const arrived = Boolean(finalStop && reachedFinalStop && finalStop.crs === lastLdbwsCrs);

  // Overlay Network Rail's live-position snapshot for the banner's location
  // name/event/"N min ago" wording — nrPositionForRid already prefers
  // whichever of the TRUST- or TD-keyed row is freshest.
  const routeCrs = new Set(calls.map((c) => c.crs).filter((c): c is string => Boolean(c)));
  const nr = await nrPositionForRid(rid, routeCrs).catch(() => null);
  const nrLocationName = nr?.location
    ? (calls.find((c) => c.crs === nr.location)?.name ?? nr.location)
    : undefined;

  // Effective "last passed" index: the TRUST/TD-history front computed above,
  // further refined forward by the live snapshot when it's even fresher than
  // the last history row we saw (history is pruned/rate-limited; the snapshot
  // can be a beat ahead) — refinement is forward-only, since a fresher report
  // can't un-happen an earlier one.
  let effectiveLastPassedIdx = lastPassedIdx;
  if (nr?.location) {
    const nrIdx = ordered.findIndex((s) => s.crs === nr.location);
    if (nrIdx > effectiveLastPassedIdx) effectiveLastPassedIdx = nrIdx;
  }

  // True once the train has reached the last stop we have data for but the
  // LDBWS journey continues beyond it (see `arrived` above) — run off the end
  // of what we know without reaching the real destination.
  const ranOffDarwinData =
    !arrived && ordered.length > 0 && effectiveLastPassedIdx === ordered.length - 1;
  let markedCurrentForOverrun = false;

  // TRUST/TD reports for each stop, by run index, for the per-stop actual time
  // and lateness below — TRUST history beats Darwin's actArr/actDep wherever
  // it exists; Darwin only fills gaps TRUST/TD never reported.
  const trustByRunIdx = new Map<number, TrustStop>();
  for (const t of trustStops) trustByRunIdx.set(t.runIdx, t);

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

    // TRUST/TD's own report for this stop, when it has one, is the actual —
    // a real event log entry, not a per-stop cell an out-of-order message can
    // overwrite. Darwin's actArr/actDep only fill in stops TRUST/TD never
    // reported (sparser coverage: TD needs a recognised SMART station event,
    // TRUST needs a TOC to send a movement message for that location).
    const trust = trustByRunIdx.get(runIdx);
    const actual = trust ? ukHhmm(trust.reportedAt) : (d.actArr ?? d.actDep)?.slice(0, 5);
    const actualIso = trust ? trust.reportedAt.toISOString() : undefined;
    // Future stops have no TRUST/TD equivalent at all — neither feed predicts
    // ahead of where the train has actually been — so Darwin's own forecast
    // remains the only source for what's still ahead.
    const estimate = d.estArr ?? d.estDep ?? d.schedArr ?? d.schedDep ?? d.schedPass;
    const anchor = c.scheduledIso ? new Date(c.scheduledIso) : now;

    return {
      ...c,
      platform: c.platform ?? d.platform ?? undefined,
      progress,
      actual: actual ?? c.actual,
      actualIso: actualIso ?? (actual ? hhmmToIso(actual, anchor) : c.actualIso),
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

  // TRUST's own per-event lateness is the delay figure of record — it's what
  // TOCs and Darwin itself ultimately derive from, and it doesn't depend on
  // Darwin's actArr/actDep being right. TD-only fronts carry no lateness (TD
  // has no timing concept at all), so walk back to the most recent TRUST
  // (not TD) report seen anywhere in this rid's history. Only when TRUST has
  // never reported for this rid at all does the schedule-vs-Darwin-actual
  // delta at the front stop stand in.
  const latestTrustLateness = [...trustStops].reverse().find((t) => t.latenessSeconds !== null);
  const delayMinutes =
    latestTrustLateness?.latenessSeconds != null
      ? Math.round(latestTrustLateness.latenessSeconds / 60)
      : lastPassed
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
