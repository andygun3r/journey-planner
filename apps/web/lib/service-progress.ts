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
 * headcode map. The TD fallback is NOT unambiguous by construction: headcodes
 * are reused by many unrelated physical trains across the day (and even
 * concurrently, on other routes), and nr_train_position's `TD:<headcode>` row
 * is just whichever train most recently reported that headcode anywhere on
 * the network — it can belong to a different service entirely. Guard against
 * that the same way enrichWithNrProgress does: only trust it when the
 * reported CRS is actually one of this train's own route stops.
 */
async function nrPositionForRid(rid: string, routeCrs: Set<string>): Promise<NrPosition | null> {
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
 *
 * Candidates come from ANY of the LDBWS calls, not just the journey origin:
 * Darwin's own timing points for a service can start partway through the
 * real-world journey (e.g. a service LDBWS shows as starting at Waterloo may
 * only be timed by Darwin from Clapham Junction onward, if that's where its
 * schedule/activation begins) — anchoring on the origin alone silently fails
 * to resolve those. The full-pattern score is what actually prevents matching
 * a different train that merely shares one stop.
 */
async function resolveRid(callKeys: Set<string>): Promise<DarwinStop[] | null> {
  const db = getDb();
  const crsList = [...new Set([...callKeys].map((k) => k.split("|")[0]!))];
  if (crsList.length === 0) return null;

  // Candidate rids: any train calling at any of these stations at all.
  let candidates: Array<{ rid: string }>;
  try {
    candidates = await db
      .select({ rid: darwinStopForecast.rid })
      .from(darwinStopForecast)
      .where(inArray(darwinStopForecast.crs, crsList));
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

  // Score each candidate purely by calling-pattern overlap with the LDBWS
  // service — no single stop is required, so a Darwin schedule that starts
  // mid-route still matches on everything downstream of where it picks up.
  let best: { stops: DarwinStop[]; score: number } | null = null;
  for (const [, stops] of byRid) {
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
    if (!best || score > best.score) {
      // seq can tie (see darwin-ingest/store.ts applyTS): a stop inserted
      // without a seeding SC message reuses its nearest lower neighbour's
      // seq rather than an interpolated value, since seq is a smallint.
      // Break ties by scheduled time so the route still orders correctly.
      const sorted = stops.sort((a, b) => {
        if (a.seq !== b.seq) return a.seq - b.seq;
        const at = a.schedArr ?? a.schedDep ?? "";
        const bt = b.schedArr ?? b.schedDep ?? "";
        return at.localeCompare(bt);
      });
      best = { stops: sorted, score };
    }
  }

  // Require enough overlap to trust the match — same bar as before (origin +
  // at least one more stop), now expressed purely as "at least 2 shared stops."
  if (!best || best.score < 2) return null;
  return best.stops;
}

export async function enrichWithDarwinProgress(
  calls: ServiceCall[],
): Promise<{ calls: ServiceCall[]; progress: ServiceProgress; rid?: string }> {
  // The LDBWS calling pattern as (crs|HH:MM) keys, to resolve and validate the rid match.
  const callKeys = new Set<string>();
  for (const c of calls) {
    if (c.crs && c.scheduled) callKeys.add(`${c.crs}|${c.scheduled.slice(0, 5)}`);
  }
  if (callKeys.size === 0) return { calls, progress: NOT_TRACKING };

  let stops: DarwinStop[] | null;
  try {
    stops = await resolveRid(callKeys);
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
  // so NR's position is frequently ahead of lastPassedIdx. The per-stop
  // progress markers (and the "current" icon) MUST be driven by the same
  // position as the summary banner text below — previously they weren't:
  // Darwin's lastPassedIdx alone decided "current" while the banner preferred
  // NR's (fresher) location, so the two could point at different stops.
  const rid = stops[0]?.rid;
  const routeCrs = new Set(calls.map((c) => c.crs).filter((c): c is string => Boolean(c)));
  const nr = rid ? await nrPositionForRid(rid, routeCrs) : null;
  const nrLocationName = nr?.location
    ? (calls.find((c) => c.crs === nr.location)?.name ?? nr.location)
    : undefined;

  // Effective "last passed" index: NR's location if it's at or beyond
  // Darwin's own last-known stop (NR only ever refines forward, since a
  // fresher berth report can't un-happen), otherwise Darwin's.
  let effectiveLastPassedIdx = lastPassedIdx;
  if (nr?.location) {
    const nrIdx = ordered.findIndex((s) => s.crs === nr.location);
    if (nrIdx > effectiveLastPassedIdx) effectiveLastPassedIdx = nrIdx;
  }

  const lastStopName = undefined; // resolved from calls below
  // True once every Darwin-known stop has an actual time and the LDBWS
  // journey still has calls beyond Darwin's own data (see `arrived` above) —
  // the train has run off the end of what Darwin knows, but it hasn't
  // reached the real destination. The first such call becomes "current": a
  // reasonable inference (last confirmed position was the stop before it),
  // not a guess about where exactly it is.
  const ranOffDarwinData = !arrived && effectiveLastPassedIdx === ordered.length - 1 && ordered.length > 0;
  let markedCurrentForOverrun = false;
  const enriched = calls.map((c) => {
    if (!c.crs) return c;
    const d = darwinByCrs.get(c.crs);
    if (!d) {
      if (ranOffDarwinData && !markedCurrentForOverrun) {
        markedCurrentForOverrun = true;
        return { ...c, progress: "current" as const };
      }
      return c;
    }

    // The live front (idxInOrdered === effectiveLastPassedIdx) is always
    // "current" — even if it only has actArr (arrived, still at the
    // platform, not yet actDep) or NR has moved the front past a stop Darwin
    // hasn't itself marked actDep for yet. Anything strictly before the
    // front has necessarily been left behind, whatever its own actual-time
    // state happens to be (a gap there is a data gap, not a still-current
    // stop — the train is confirmed further on).
    const idxInOrdered = ordered.indexOf(d);
    let progress: ServiceCall["progress"];
    if (idxInOrdered === effectiveLastPassedIdx) progress = "current";
    else if (idxInOrdered < effectiveLastPassedIdx) progress = "departed";
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
