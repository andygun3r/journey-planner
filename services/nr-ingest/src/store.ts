import {
  createDb,
  darwinStopForecast,
  darwinTrain,
  nrCorpus,
  nrHeadcode,
  nrSignallingState,
  nrSmart,
  nrTrainPosition,
  nrTrainPositionHistory,
} from "@mainline/db";
import { alignCallsToRun, hhmmToIso, londonDateKey, resolvePatternTimes } from "@mainline/shared";
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { BerthStep, MovementReport, SClassReport } from "./parse.js";

const db = createDb();

const POSITION_HISTORY_RETENTION_DAYS = Number(
  process.env.NR_POSITION_HISTORY_RETENTION_DAYS ?? 7,
);

/**
 * Per-key async mutex. STOMP delivers each frame's read callback independently
 * (see index.ts's subscribeOn) — nothing serializes two frames for the SAME
 * train that arrive close together, and applyMovement/applyBerthStep each do
 * several sequential awaited queries (read existing rid, resolve/revalidate,
 * write) before their transaction commits. Two overlapping calls can therefore
 * interleave and commit out of order: an EARLIER report's write landing AFTER
 * a LATER report's, silently reintroducing a stale/wrong rid the later report
 * had correctly cleared.
 *
 * Confirmed live: TD:2C35's history table correctly resolved a null rid for
 * its last four reports (a genuine concurrent headcode collision with an
 * unrelated Chester-area service), but the live nr_train_position snapshot
 * still showed an older wrong rid — the only explanation is exactly this kind
 * of write-order race, since both values come from the same code path.
 *
 * Keyed on the same string used as the position row's primary key (trainId,
 * or `TD:${headcode}`), so unrelated trains never wait on each other — only
 * repeated reports for the same physical train serialize.
 */
const keyLocks = new Map<string, Promise<void>>();
async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = keyLocks.get(key) ?? Promise.resolve();
  let release: () => void;
  const ourTurn = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  keyLocks.set(key, ourTurn);
  await previous;
  try {
    return await fn();
  } finally {
    release!();
    // Only clear the map entry if nothing queued behind us (the entry is
    // still the exact promise WE installed) — otherwise this would drop the
    // next caller's link in the chain, letting two later callers both think
    // they're first and run unserialized.
    if (keyLocks.get(key) === ourTurn) keyLocks.delete(key);
  }
}

/** Cheap self-prune: no dedicated cron, just an occasional sweep on write. */
function maybePruneHistory(): void {
  if (Math.random() >= 0.001) return;
  const cutoff = new Date(Date.now() - POSITION_HISTORY_RETENTION_DAYS * 86_400_000);
  void db.delete(nrTrainPositionHistory).where(lt(nrTrainPositionHistory.recordedAt, cutoff));
}

// --- In-memory reference caches (loaded once, refreshed hourly) ---
let stanoxToCrs = new Map<string, { crs: string | null; tiploc: string | null }>();
// `${area}|${from}|${to}` -> stanox + SMART's own event code for this berth
// boundary ("A" arrival / "D" departure / other = a mid-section step, not a
// station event worth surfacing as "Passed <station>").
let berthToStanox = new Map<string, { stanox: string; eventType: string | null }>();
let refLoadedAt = 0;

async function ensureRef(): Promise<void> {
  if (stanoxToCrs.size > 0 && Date.now() - refLoadedAt < 3_600_000) return;
  const corpus = await db
    .select({ stanox: nrCorpus.stanox, crs: nrCorpus.crs, tiploc: nrCorpus.tiploc })
    .from(nrCorpus);
  const s2c = new Map<string, { crs: string | null; tiploc: string | null }>();
  for (const r of corpus) s2c.set(r.stanox, { crs: r.crs, tiploc: r.tiploc });

  const smart = await db
    .select({
      tdArea: nrSmart.tdArea,
      fromBerth: nrSmart.fromBerth,
      toBerth: nrSmart.toBerth,
      stanox: nrSmart.stanox,
      eventType: nrSmart.eventType,
    })
    .from(nrSmart);
  const b2s = new Map<string, { stanox: string; eventType: string | null }>();
  for (const r of smart) {
    if (r.stanox) {
      b2s.set(`${r.tdArea}|${r.fromBerth ?? ""}|${r.toBerth ?? ""}`, {
        stanox: r.stanox,
        eventType: r.eventType,
      });
    }
  }

  stanoxToCrs = s2c;
  berthToStanox = b2s;
  refLoadedAt = Date.now();
}

/**
 * How far from its booked time at a tiploc a report can be and still
 * plausibly belong to that candidate rid. Same tolerance and reasoning as
 * apps/web/lib/service-match.ts's TD_TOLERANCE_MS — wide enough for a badly
 * delayed service, far tighter than "any train standing at a shared station".
 * Duplicated rather than imported: service-match.ts lives in apps/web, which
 * this service (a separate package) doesn't depend on. Keep the two values in
 * sync if either changes.
 */
const TD_TOLERANCE_MS = 90 * 60_000;

/**
 * How close a candidate's booked time must be to TRUST's OWN booked time
 * (`planned_timestamp`) to count as a booked-vs-booked match.
 *
 * Deliberately tight. Both sides are *plan*, not observation, so there is no
 * delay to absorb — the only slack needed covers the two sources rounding to
 * different granularities (Darwin publishes HH:MM and HH:MM:30, TRUST to the
 * minute) and minor timetable-version skew.
 */
const BOOKED_TOLERANCE_MS = 5 * 60_000;

/**
 * Confidence that a candidate rid explains a report at a given location.
 * Ordered, and compared with STRICT inequality when picking a winner, so two
 * candidates with equally good evidence resolve to "ambiguous" rather than an
 * arbitrary pick.
 */
const SCORE_NONE = 0;
/** Interpolated time, only within the loose actual-time window. Weakest. */
const SCORE_INTERPOLATED = 1;
/** Real booked row within the loose actual-time window. */
const SCORE_ACTUAL_IN_WINDOW = 2;
/** Interpolated time, but agreeing with TRUST's booked time. */
const SCORE_INTERPOLATED_BOOKED = 3;
/** Published booked time agreeing with TRUST's booked time. Strongest. */
const SCORE_BOOKED_MATCH = 4;

/**
 * Minimum distinct stations a train must have visited before its trajectory is
 * worth scoring. Two stops are shared by far too many routes to mean anything;
 * three already implies a direction of travel.
 */
const TRAJECTORY_MIN_STOPS = 3;

/**
 * How much better the leading candidate's trajectory must align than the
 * runner-up's before the tie is broken. A margin of 1 stop is within the noise
 * of a missed report, so require a clear 2.
 */
const TRAJECTORY_MIN_MARGIN = 2;

/**
 * Trajectory tie-breaking is OFF unless NR_TRAJECTORY_MATCH=1.
 *
 * Shadow mode (the default) computes the answer and logs what it WOULD have
 * done without writing it, so the decision quality can be judged against live
 * traffic before it is allowed to affect any row. This is the riskiest change
 * in the correlation work — it resolves cases every cheaper test refused — and
 * a wrong rid is worse than no rid.
 */
const TRAJECTORY_ENABLED = process.env.NR_TRAJECTORY_MATCH === "1";

/**
 * Does this candidate rid have a plausible reason to be reporting from this
 * location around `at`? True when the rid's schedule calls there (arr/dep/
 * pass, whichever is set) within TD_TOLERANCE_MS of the report time.
 *
 * Matches on tiploc OR crs, not tiploc alone. CORPUS gives one canonical
 * tiploc per CRS, but Darwin's own feed uses per-platform/CIS-face variants
 * sharing the same station (measured live: Victoria has VICTRIA, VICTRIE,
 * VICTRIC, VICTGCS... across different rows) — an exact tiploc match missed a
 * candidate that WAS the right one, purely because Darwin happened to use a
 * different variant string for the same physical stop. crs is the more stable
 * join key across the two feeds, but only ~66% of darwin_stop_forecast rows
 * have one (many are pure passing points with no public CRS) — hence "or",
 * not "instead of".
 *
 * This is also the check that was originally missing entirely: the old
 * disambiguation only asked "does this candidate call here AT ALL", which
 * most stations satisfy for many services a day. A report at 13:30 satisfied
 * a candidate scheduled through here at 09:15 just as well as one scheduled
 * for 13:32 — confirmed live, a headcode got permanently linked to the wrong
 * day's/wrong route's rid this way (see td-headcode-collision-risk memory).
 *
 * Also requires the rid's own darwin_train row to be deactivated=false.
 * findRidForHeadcode's fresh-candidate query already filters deactivated rids
 * out, but revalidateRid's fallback re-checks whatever rid a position row
 * ALREADY carries — and a deactivated train's darwin_stop_forecast rows are
 * never deleted, so a stale rid from an earlier (now-superseded) run of the
 * same uid could pass the plausibility check on schedule data alone forever.
 * Confirmed live: TD:1B21 and TD:9S15 both stayed linked to a deactivated rid
 * indefinitely — in both cases a second, active (deactivated=false) candidate
 * for the same headcode existed and was never even considered, because the
 * fallback path only ever re-checks the ONE rid the row already has.
 */
async function candidatePlausibleAtLocation(
  rid: string,
  tiploc: string | null,
  crs: string | null,
  at: Date,
  bookedAt?: Date | null,
): Promise<number> {
  if (!tiploc && !crs) return 0;
  const locationMatch = [
    tiploc ? eq(darwinStopForecast.tiploc, tiploc) : undefined,
    crs ? eq(darwinStopForecast.crs, crs) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const rows = await db
    .select({
      seq: darwinStopForecast.seq,
      schedArr: darwinStopForecast.schedArr,
      schedDep: darwinStopForecast.schedDep,
      schedPass: darwinStopForecast.schedPass,
    })
    .from(darwinStopForecast)
    .innerJoin(darwinTrain, eq(darwinTrain.rid, darwinStopForecast.rid))
    .where(
      and(
        eq(darwinStopForecast.rid, rid),
        eq(darwinTrain.deactivated, false),
        or(...locationMatch),
      ),
    );

  let anyBlank = false;
  let best = SCORE_NONE;
  for (const r of rows) {
    let matched = false;
    for (const hhmm of [r.schedArr, r.schedDep, r.schedPass]) {
      const iso = hhmmToIso(hhmm, at);
      if (!iso) continue;
      matched = true;
      const bookedMs = Date.parse(iso);

      // STRONGEST evidence: this candidate's booked time at this location
      // matches TRUST's OWN booked time for the report. Booked-vs-booked needs
      // no delay slack, so it separates candidates that the actual-time window
      // below cannot. Measured over 1,686 live movements, |actual - planned| is
      // p50 1min / p90 11.5min / p99 38min — which is exactly why comparing
      // actuals needs +/-90min and can't discriminate.
      if (bookedAt && Math.abs(bookedMs - bookedAt.getTime()) <= BOOKED_TOLERANCE_MS) {
        return SCORE_BOOKED_MATCH;
      }
      if (Math.abs(bookedMs - at.getTime()) <= TD_TOLERANCE_MS) {
        best = Math.max(best, SCORE_ACTUAL_IN_WINDOW);
      }
    }
    if (!matched) anyBlank = true;
  }
  if (best > SCORE_NONE) return best;
  if (!anyBlank) return SCORE_NONE;

  // At least one matching row has no sched_arr/sched_dep/sched_pass at all —
  // measured live, 47% of darwin_stop_forecast rows are like this (minor
  // timing points, e.g. Castle Cary on a Paddington-Penzance working, that
  // CORPUS gives a CRS to but Darwin's Push Port never carries a WTT time
  // for). Without a fallback, a headcode whose ONLY current-location match is
  // one of these rows can never be found plausible, however obviously right
  // it is — confirmed live: 1,553 unresolved TD trains had exactly one
  // same-day candidate, and it was consistently one of these no-time rows
  // that rejected them. Interpolate an instant from the candidate's own
  // neighbouring TIMED stops instead of giving up: 61,466 of 61,498 rids with
  // any blank-timing row have plenty of others to interpolate between.
  const iso = await interpolatedTimeForRid(rid, tiploc, crs, at);
  if (!iso) return SCORE_NONE;
  const ms = Date.parse(iso);
  if (bookedAt && Math.abs(ms - bookedAt.getTime()) <= BOOKED_TOLERANCE_MS) {
    // Interpolated, but it lines up with TRUST's booked time — better than a
    // loose actual-time hit, yet still weaker than a real booked row, since
    // the time itself was inferred rather than published.
    return SCORE_INTERPOLATED_BOOKED;
  }
  return Math.abs(ms - at.getTime()) <= TD_TOLERANCE_MS ? SCORE_INTERPOLATED : SCORE_NONE;
}

/**
 * Put a calling pattern into TRAVEL order.
 *
 * `seq` looks like travel order and mostly is, but it is not reliable: measured
 * across 400 of today's schedules, **5.7% of consecutive stop pairs go
 * backwards in time**. darwin-ingest assigns seq on a best-effort basis when a
 * TS message patches in a stop it hasn't seen (applyTS's seqForTime), reusing
 * the lower neighbour's seq because the column is a smallint with no room for
 * fractional values — so ties and mis-slotted stops are expected by design.
 *
 * Confirmed live on rid 202607297100735, where the train physically ran
 * TGM -> DWL -> DWW -> EXD -> TVP -> TAU but the stored pattern lists EXD/TVP/
 * TAU at seq 3-5 and TGM/DWL/DWW at seq 26-28.
 *
 * Booked time is the real ordering signal, so sort on it and keep seq only as
 * a tiebreak for stops sharing a time. Untimed stops can't be placed by time,
 * so they hold their seq-relative position.
 *
 * This matters to two callers for different reasons:
 *  - trajectory scoring compares an observed sequence against this one, so a
 *    scrambled pattern makes the comparison meaningless;
 *  - resolvePatternTimes ASSUMES travel order (it rolls the day forward
 *    whenever the clock goes backwards), so feeding it a scrambled pattern
 *    invents midnight rollovers that never happened.
 */
function inTravelOrder<T extends { seq: number; schedArr: string | null; schedDep: string | null; schedPass: string | null }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const ta = a.schedArr ?? a.schedDep ?? a.schedPass;
    const tb = b.schedArr ?? b.schedDep ?? b.schedPass;
    // Both timed: order by clock, seq breaking exact ties.
    if (ta && tb) return ta === tb ? a.seq - b.seq : ta < tb ? -1 : 1;
    // Only one timed: fall back to seq, which is all that relates them.
    return a.seq - b.seq;
  });
}

/**
 * Best-effort instant for a rid's stop at `tiploc`/`crs` when that stop's own
 * row carries no sched_arr/sched_dep/sched_pass. Resolves the WHOLE pattern
 * via resolvePatternTimes (correct midnight-rollover handling, same as used
 * for journey display), then derives the target seq's instant: interpolating
 * between the nearest timed neighbours when the target sits between two, and
 * extrapolating from the two nearest timed stops when it sits in an untimed
 * head or tail (see the comment at the extrapolation branch for why those tails
 * are common). Returns null only when the stop isn't in the pattern, when fewer
 * than two stops carry a time at all, or when the timings are degenerate.
 */
async function interpolatedTimeForRid(
  rid: string,
  tiploc: string | null,
  crs: string | null,
  at: Date,
): Promise<string | null> {
  // Ordered by booked time, not seq — see inTravelOrder. resolvePatternTimes
  // below assumes travel order and rolls the day forward on any backwards
  // clock step, so a seq-ordered pattern would invent midnight rollovers.
  const pattern = inTravelOrder(
    await db
      .select({
        seq: darwinStopForecast.seq,
        tiploc: darwinStopForecast.tiploc,
        crs: darwinStopForecast.crs,
        schedArr: darwinStopForecast.schedArr,
        schedDep: darwinStopForecast.schedDep,
        schedPass: darwinStopForecast.schedPass,
      })
      .from(darwinStopForecast)
      .where(eq(darwinStopForecast.rid, rid)),
  );

  const targetIdx = pattern.findIndex(
    (p) => (tiploc && p.tiploc === tiploc) || (crs && p.crs === crs),
  );
  if (targetIdx === -1) return null;
  if (pattern[targetIdx]!.schedArr || pattern[targetIdx]!.schedDep || pattern[targetIdx]!.schedPass) {
    return null; // has its own time after all; not this function's job
  }

  const resolved = resolvePatternTimes(
    pattern.map((p) => p.schedArr ?? p.schedDep ?? p.schedPass),
    at,
  );

  let beforeIdx = -1;
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (resolved[i]) {
      beforeIdx = i;
      break;
    }
  }
  let afterIdx = -1;
  for (let i = targetIdx + 1; i < resolved.length; i++) {
    if (resolved[i]) {
      afterIdx = i;
      break;
    }
  }
  // Interpolate when the target sits between two timed stops.
  if (beforeIdx !== -1 && afterIdx !== -1) {
    const beforeMs = Date.parse(resolved[beforeIdx]!);
    const afterMs = Date.parse(resolved[afterIdx]!);
    const fraction = (targetIdx - beforeIdx) / (afterIdx - beforeIdx);
    return new Date(beforeMs + (afterMs - beforeMs) * fraction).toISOString();
  }

  // Otherwise EXTRAPOLATE from the two nearest timed stops on whichever side
  // exists. Darwin routinely emits a run of untimed junction rows AFTER the
  // last timed stop (measured: 11,429 rids, 17.7% of those with any untimed
  // row) and, less often, before the first (1,707 rids) — a target in either
  // tail has no enclosing pair, so interpolation alone silently gave up on it.
  //
  // Confirmed live: TRUST 422K88MY29 (headcode 2K88) reporting from CREWSJN,
  // whose only candidate had CREWSJN at seq 1 with the timed stops all at seq
  // <= 0. The candidate was rejected for want of a comparable time even though
  // it was the right train.
  //
  // Extrapolation is deliberately linear over the nearest known pair's rate
  // per PATTERN POSITION (not per seq — seq isn't a total order, see the
  // orderBy above). These tail rows are consecutive junctions passed within a
  // few minutes, so a modest error is fine: the result is only ever compared
  // against a +/-90min plausibility window, never shown to a user.
  const timedIdxs = resolved
    .map((iso, i) => (iso ? i : -1))
    .filter((i) => i !== -1);
  if (timedIdxs.length < 2) return null;

  const [i0, i1] =
    beforeIdx !== -1
      ? [timedIdxs[timedIdxs.length - 2]!, timedIdxs[timedIdxs.length - 1]!] // trailing tail
      : [timedIdxs[0]!, timedIdxs[1]!]; // leading tail

  const t0 = Date.parse(resolved[i0]!);
  const t1 = Date.parse(resolved[i1]!);
  const perStop = (t1 - t0) / (i1 - i0);
  // Reject a degenerate pattern (zero/negative rate, or a pair so close
  // together that extrapolating over a long tail explodes) rather than
  // inventing a time hours from reality. 30 min/stop is already far beyond any
  // real junction-to-junction gap.
  if (!Number.isFinite(perStop) || perStop <= 0 || perStop > 30 * 60_000) return null;
  return new Date(t1 + perStop * (targetIdx - i1)).toISOString();
}

/**
 * Disambiguate candidates by the train's RECENT TRAJECTORY rather than by its
 * position at a single instant.
 *
 * This exists because point-in-time checks provably cannot separate the cases
 * that remain. Measured live: of 103 unresolved multi-candidate TRUST rows, 26
 * were the SAME uid on consecutive days (yesterday's and today's run of one
 * service — near-identical schedules by construction, so no single-location
 * time test can ever tell them apart), and the rest routinely had NO booked
 * time at the reported location on either candidate, leaving them tied.
 *
 * A sequence of locations is far more selective than any one of them: a train
 * cannot physically have visited stations in an order its schedule doesn't
 * contain. That test is also delay-invariant, which matters because reports
 * are actuals — measured |actual - booked| is p90 11.5min.
 *
 * Returns the number of the train's recent stops that align, IN ORDER, to this
 * candidate's calling pattern, or 0 when it can't be told. Deliberately does
 * NOT use time to score: time already had its chance in
 * candidatePlausibleAtLocation, and reusing it here would just re-express the
 * same tie.
 */
async function scoreCandidateByTrajectory(
  rid: string,
  trainId: string,
  at: Date,
): Promise<number> {
  // The train's own recent reports, oldest first. 3h covers a long-distance
  // working without dragging in a previous, unrelated diagram.
  const history = await db
    .select({ crs: nrTrainPositionHistory.lastCrs })
    .from(nrTrainPositionHistory)
    .where(
      and(
        eq(nrTrainPositionHistory.trainId, trainId),
        gte(nrTrainPositionHistory.reportedAt, new Date(at.getTime() - 3 * 3_600_000)),
      ),
    )
    .orderBy(nrTrainPositionHistory.reportedAt);

  // Collapse consecutive duplicates: several berth steps inside one station
  // are one visit, and would otherwise inflate the score.
  const observed: string[] = [];
  for (const h of history) {
    if (h.crs && h.crs !== observed[observed.length - 1]) observed.push(h.crs);
  }
  if (observed.length < TRAJECTORY_MIN_STOPS) return 0;

  // Must be TRAVEL order: alignCallsToRun walks a forward-only cursor, so a
  // seq-ordered pattern scores where the mis-ordering happens to fall rather
  // than how well the route fits. See inTravelOrder.
  const pattern = inTravelOrder(
    await db
      .select({
        seq: darwinStopForecast.seq,
        crs: darwinStopForecast.crs,
        schedArr: darwinStopForecast.schedArr,
        schedDep: darwinStopForecast.schedDep,
        schedPass: darwinStopForecast.schedPass,
      })
      .from(darwinStopForecast)
      .where(eq(darwinStopForecast.rid, rid)),
  );
  if (pattern.length === 0) return 0;

  // Forward-only, each stop consumed at most once — so a route calling twice
  // at one CRS matches two distinct visits rather than both reading the first.
  const aligned = alignCallsToRun(observed, pattern);
  return aligned.filter((i) => i !== undefined).length;
}

/**
 * Correlate a headcode to a Darwin rid, scoped to today's or yesterday's
 * traffic day so an overnight service still resolves near midnight.
 *
 * Candidates come from TWO unioned sources: Darwin's own `trainId` on the SC
 * message (darwin_train.headcode — live, never stale, covers short-notice
 * services CIF never had) and the CIF-derived nr_headcode uid bridge (needed
 * for any rid whose schedule was broadcast before headcode capture existed,
 * since Darwin only re-sends schedules once a day). Union, not substitution:
 * adding candidates can only make this MORE conservative, never wrong, because
 * every candidate still has to clear the same plausibility gate below.
 *
 * A headcode is reused far more heavily than "rare collision" — measured live,
 * one headcode (1P14) had 43 distinct candidate uids, several with an active
 * run on the same day. Requiring a *unique* uid+day match therefore fails
 * almost always for real trains, not just on genuine ambiguity: with several
 * same-day candidates the true one is simply never checked. Disambiguate using
 * the train's current tiploc AND report time — a candidate must be scheduled
 * through that tiploc within TD_TOLERANCE_MS of `at`, not merely call there at
 * some point in its day. Falls back to the old exactly-one-candidate rule when
 * there's no tiploc to check against (e.g. a berth step with no resolved
 * station).
 */
async function findRidForHeadcode(
  headcode: string,
  at: Date,
  nearTiploc?: string | null,
  nearCrs?: string | null,
  /** TRUST's own booked time for this report, when it sent one. */
  bookedAt?: Date | null,
  /**
   * The reporting train's position-row id, for trajectory tie-breaking. Omitted
   * for TD berth steps: those rows are keyed by headcode alone, so their
   * history can interleave two physical trains sharing that headcode — exactly
   * the ambiguity being resolved, so it must not be used as evidence.
   */
  trainId?: string | null,
): Promise<string | null> {
  const days = [londonDateKey(new Date(at.getTime() - 86_400_000)), londonDateKey(at)];

  // Source 1: Darwin's OWN headcode, straight off the SC message's trainId
  // attribute (darwin_train.headcode). Live and self-refreshing — no CIF
  // download, no staleness, and it covers short-notice services that were
  // never in CIF at all. Preferred, but unioned rather than substituted so
  // this can only ever ADD candidates.
  const darwinNative = await db
    .select({ rid: darwinTrain.rid })
    .from(darwinTrain)
    .where(
      and(
        eq(darwinTrain.headcode, headcode),
        inArray(darwinTrain.ssd, days),
        eq(darwinTrain.deactivated, false),
      ),
    );

  // Source 2: the CIF-derived uid -> headcode bridge. Kept because Darwin only
  // (re)broadcasts schedules once a day, so darwin_train.headcode is empty for
  // any rid whose SC predates the column being captured.
  const uidRows = await db
    .select({ uid: nrHeadcode.uid })
    .from(nrHeadcode)
    .where(eq(nrHeadcode.headcode, headcode));
  const uids = uidRows.map((r) => r.uid);

  const viaUid = uids.length
    ? await db
        .select({ rid: darwinTrain.rid })
        .from(darwinTrain)
        .where(
          and(
            inArray(darwinTrain.uid, uids),
            inArray(darwinTrain.ssd, days),
            eq(darwinTrain.deactivated, false),
          ),
        )
    : [];

  const candidates = [...new Map([...darwinNative, ...viaUid].map((c) => [c.rid, c])).values()];
  if (candidates.length === 0) return null;

  // A single same-day candidate used to be trusted outright, with no timing
  // check at all — but "only one uid happens to be running today" doesn't mean
  // THIS report belongs to it. A headcode reused across non-overlapping
  // workings (e.g. an early empty-stock move and an unrelated later service)
  // can have exactly one same-day candidate while the current report is for
  // neither. Confirmed live: TD:2O33 got linked to a rid that doesn't call at
  // Gunnersbury at all, purely because it was the only candidate — this check
  // now catches that instead of trusting single-candidate matches blindly.
  if (!nearTiploc && !nearCrs) return candidates.length === 1 ? candidates[0]!.rid : null;

  // Score every candidate, then take the winner only if it is STRICTLY better
  // than the runner-up.
  //
  // This replaces a plain "exactly one candidate passed" rule. That rule threw
  // away a correct match whenever a second candidate also merely *passed*, even
  // when the first was a far better explanation — and with a +/-90min window,
  // several candidates passing is common. Scoring keeps the conservatism (a
  // genuine tie still resolves to null) while letting decisive evidence win.
  const scored: Array<{ rid: string; score: number }> = [];
  for (const c of candidates) {
    scored.push({
      rid: c.rid,
      score: await candidatePlausibleAtLocation(
        c.rid,
        nearTiploc ?? null,
        nearCrs ?? null,
        at,
        bookedAt,
      ),
    });
  }
  scored.sort((a, b) => b.score - a.score);

  const bestScore = scored[0]?.score ?? SCORE_NONE;
  if (bestScore === SCORE_NONE) return null;
  if (scored.length === 1 || bestScore > scored[1]!.score) return scored[0]!.rid;

  // Tied on time/location evidence. Fall back to trajectory, which is the only
  // signal that separates same-uid-different-day runs. Only the candidates
  // actually tied at the top are considered, and only when we know which train
  // is reporting (trainId) — TD berth steps share a headcode-keyed row, so
  // their "history" can mix two physical trains and must not be scored here.
  const tied = scored.filter((s) => s.score === bestScore);
  if (!trainId) return null;

  const byTrajectory: Array<{ rid: string; stops: number }> = [];
  for (const t of tied) {
    byTrajectory.push({
      rid: t.rid,
      stops: await scoreCandidateByTrajectory(t.rid, trainId, at).catch(() => 0),
    });
  }
  byTrajectory.sort((a, b) => b.stops - a.stops);

  const top = byTrajectory[0]!;
  const next = byTrajectory[1]!;
  const decisive =
    top.stops >= TRAJECTORY_MIN_STOPS && top.stops - next.stops >= TRAJECTORY_MIN_MARGIN;

  if (!decisive) return null;
  if (!TRAJECTORY_ENABLED) {
    console.log(
      `[nr][trajectory-shadow] ${trainId} headcode=${headcode} would pick ${top.rid} ` +
        `(${top.stops} stops aligned vs runner-up ${next.rid} ${next.stops}) ` +
        `from ${tied.length} tied candidates`,
    );
    return null;
  }
  return top.rid;
}

/**
 * Re-check whether an already-resolved rid is still plausible for a NEW
 * report at `tiploc`/`at`, and drop it if not.
 *
 * Correlation used to be trust-once: whatever findRidForHeadcode returned (or
 * a stale/wrong value from an earlier ambiguous match) was carried forward on
 * every later report via `rid ?? existing`, with nothing ever re-examining it.
 * A headcode reassigned to a different physical train mid-day, or a bad
 * initial match slipping through, then stuck forever — confirmed live, see
 * td-headcode-collision-risk memory. This re-validates on every report instead
 * of only at first resolution, so a bad link gets a chance to self-correct
 * rather than persisting until the position row expires.
 *
 * No location to check against -> keep the existing rid rather than churn it
 * on missing information.
 */
async function revalidateRid(
  rid: string | null,
  tiploc: string | null,
  crs: string | null,
  at: Date,
  bookedAt?: Date | null,
): Promise<string | null> {
  if (!rid || (!tiploc && !crs)) return rid;
  // Fail OPEN on a query error (keep the existing rid): a transient DB blip
  // must not silently unlink every train it touches.
  const score = await candidatePlausibleAtLocation(rid, tiploc, crs, at, bookedAt).catch(
    () => SCORE_ACTUAL_IN_WINDOW,
  );
  return score > SCORE_NONE ? rid : null;
}

/**
 * Locked by trainId — see withKeyLock's comment for why: two movement reports
 * for the same train arriving close together must not interleave their
 * read-resolve-write sequence and let the earlier one's write land last.
 */
export function applyMovement(m: MovementReport): Promise<string | undefined> {
  return withKeyLock(m.trainId, () => applyMovementLocked(m));
}

async function applyMovementLocked(m: MovementReport): Promise<string | undefined> {
  await ensureRef();
  const loc = stanoxToCrs.get(m.stanox);
  const crs = loc?.crs ?? null;
  const tiploc = loc?.tiploc ?? null;

  // applyActivation may already have linked this trainId to a rid — carry it
  // forward onto the history row too, not just the live snapshot, or a
  // per-stop TRUST timeline can never be joined back to a specific service
  // (nr_train_position_history.rid would be null for every TRUST row).
  const existing = await db
    .select({ rid: nrTrainPosition.rid })
    .from(nrTrainPosition)
    .where(eq(nrTrainPosition.trainId, m.trainId))
    .limit(1);
  const reportedAt = new Date(m.actualTimestampMs);

  // Re-check the carried-forward rid against THIS report before trusting it —
  // see revalidateRid's comment for why a resolve-once model let a bad or
  // now-stale link persist indefinitely.
  // TRUST's own booked time for this event, when sent (98.5% of movements).
  // Lets the plausibility check compare booked-vs-booked instead of
  // actual-vs-booked — see candidatePlausibleAtLocation.
  const bookedAt = m.plannedTimestampMs ? new Date(m.plannedTimestampMs) : null;

  let rid = await revalidateRid(existing[0]?.rid ?? null, tiploc, crs, reportedAt, bookedAt);

  // Correlation used to be attempted *only* once, in applyActivation. If the
  // matching Darwin schedule hadn't landed yet when the 0001 arrived — routine
  // after a restart, and after any darwin-ingest gap, since schedules are only
  // broadcast once per day (see CLAUDE.md) — the row was stamped null and never
  // reconsidered, so the train kept reporting movements forever with no rid and
  // therefore no timetable, route line or calling list. Measured live: 866 of
  // 3462 active trains stuck this way, 860 of them resolvable.
  //
  // Also runs when revalidateRid just dropped a rid that no longer fits.
  // Retry here instead. The TRUST train_id embeds the headcode at chars 3-6
  // (2-char area + 4-char headcode + day/serial), which feeds the same
  // uid->rid + calling-point disambiguation used for TD headcodes.
  //
  // Extracted regardless of match outcome (not just when used for the retry
  // above) and stored on the row below. Previously this value only existed as
  // a local inside the `!rid` branch and was never written to
  // nr_train_position.headcode, so every TRUST row looked headcode-less even
  // though the string was sitting right there in train_id — a real, already-
  // reliable identifier discarded for no reason. Measured live: 719 unresolved
  // TRUST rows had headcode NULL purely from this, not from any missing data.
  const trustHeadcode =
    !m.trainId.startsWith("TD:") && /^\d[A-Z]\d{2}$/.test(m.trainId.slice(2, 6))
      ? m.trainId.slice(2, 6)
      : null;
  if (!rid && trustHeadcode) {
    rid = await findRidForHeadcode(
      trustHeadcode,
      reportedAt,
      tiploc,
      crs,
      bookedAt,
      m.trainId,
    ).catch(() => null);
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(nrTrainPosition)
      .values({
        trainId: m.trainId,
        headcode: trustHeadcode,
        rid,
        lastStanox: m.stanox,
        lastTiploc: tiploc,
        lastCrs: crs,
        lastEventType: m.eventType,
        lastReportedAt: reportedAt,
        lateness: m.latenessSeconds ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: nrTrainPosition.trainId,
        set: {
          headcode: trustHeadcode,
          // `rid` here already reflects revalidateRid + the retry above — it
          // must be written as-is, including null, rather than coalesced back
          // to whatever the row already had: that would resurrect a rid this
          // report just failed its plausibility check against.
          rid,
          lastStanox: m.stanox,
          lastTiploc: tiploc,
          lastCrs: crs,
          lastEventType: m.eventType,
          lastReportedAt: reportedAt,
          lateness: m.latenessSeconds ?? null,
          updatedAt: new Date(),
        },
        // Only apply if this report is at least as new as what's stored. See
        // the note above applyBerthStepLocked's identical guard for the full
        // reasoning; in short, nothing upstream guarantees frames arrive in
        // reportedAt order, so without this an older report can overwrite a
        // newer one's rid. Mirrors darwin-ingest/src/store.ts's lastMsgTs
        // guard, which exists for the same reason.
        where: or(
          sql`${nrTrainPosition.lastReportedAt} is null`,
          sql`${reportedAt.toISOString()}::timestamptz >= ${nrTrainPosition.lastReportedAt}`,
        ),
      });
    await tx.insert(nrTrainPositionHistory).values({
      trainId: m.trainId,
      rid,
      lastStanox: m.stanox,
      lastTiploc: tiploc,
      lastCrs: crs,
      lastEventType: m.eventType,
      reportedAt,
      lateness: m.latenessSeconds ?? null,
    });
  });
  maybePruneHistory();
  return crs ?? undefined;
}

/**
 * Locked by trainId — same reasoning as applyMovement. Activation and a
 * movement report for the same train can arrive close together (activation
 * fires right as a service starts moving), and both write nr_train_position;
 * without the lock they could interleave the same way.
 */
export function applyActivation(
  trainId: string,
  trainUid?: string,
  scheduleStartDate?: string,
  originStanox?: string,
): Promise<void> {
  return withKeyLock(trainId, () =>
    applyActivationLocked(trainId, trainUid, scheduleStartDate, originStanox),
  );
}

async function applyActivationLocked(
  trainId: string,
  trainUid?: string,
  scheduleStartDate?: string,
  originStanox?: string,
): Promise<void> {
  if (!trainUid) return;
  await ensureRef();

  // Prefer an exact (uid, schedule_start_date) match — TRUST's activation
  // message gives us the real day the schedule runs, which is a precise key,
  // not a guess. Previously this matched on uid alone and picked whichever
  // row had the most recent `updatedAt`, which for a reused uid could easily
  // be a different day's (possibly already-deactivated) run rather than the
  // one actually running now — the same reused-uid problem findRidForHeadcode
  // has, just without even the ambiguity check.
  let candidates: { rid: string }[];
  if (scheduleStartDate) {
    candidates = await db
      .select({ rid: darwinTrain.rid })
      .from(darwinTrain)
      .where(and(eq(darwinTrain.uid, trainUid), eq(darwinTrain.ssd, scheduleStartDate)));
  } else {
    // No schedule date on this activation message (shouldn't happen for a
    // real 0001, but the field is optional on the wire) — fall back to the
    // two-day window + origin-station disambiguation used elsewhere.
    const days = [londonDateKey(new Date(Date.now() - 86_400_000)), londonDateKey(new Date())];
    candidates = await db
      .select({ rid: darwinTrain.rid })
      .from(darwinTrain)
      .where(and(eq(darwinTrain.uid, trainUid), inArray(darwinTrain.ssd, days)));
  }

  let rid: string | null = null;
  if (candidates.length === 1) {
    rid = candidates[0]!.rid;
  } else if (candidates.length > 1 && originStanox) {
    const loc = stanoxToCrs.get(originStanox);
    if (loc?.tiploc || loc?.crs) {
      const candidateRids = candidates.map((c) => c.rid);
      // tiploc OR crs, not tiploc alone — see candidatePlausibleAtLocation's
      // comment for why an exact tiploc match misses candidates that use a
      // different platform/CIS-face variant of the same physical station.
      const originMatch = [
        loc.tiploc ? eq(darwinStopForecast.tiploc, loc.tiploc) : undefined,
        loc.crs ? eq(darwinStopForecast.crs, loc.crs) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      const calling = await db
        .select({ rid: darwinStopForecast.rid })
        .from(darwinStopForecast)
        .where(and(inArray(darwinStopForecast.rid, candidateRids), or(...originMatch)))
        .limit(2);
      rid = calling.length === 1 ? calling[0]!.rid : null;
    }
  }

  // An activation carries no report time of its own, so it can't take part in
  // the reportedAt-ordering guard the movement/berth writes use. Instead it
  // only ever SEEDS a rid: if the row already has a lastReportedAt, some
  // positional report has since spoken about this train, and that report's rid
  // (including a deliberate null from a failed plausibility check) is strictly
  // better evidence than a start-of-journey activation. Without this, a
  // late-delivered or duplicate 0001 could resurrect a rid a later report had
  // correctly rejected — the same class of bug as the out-of-order snapshot
  // overwrite, just arriving by a different path.
  await db
    .insert(nrTrainPosition)
    .values({ trainId, rid, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: nrTrainPosition.trainId,
      set: { rid, updatedAt: new Date() },
      where: sql`${nrTrainPosition.lastReportedAt} is null`,
    });
}

/**
 * Map SMART's own berth-boundary event code to a station-arrival/departure
 * label, or null for a mid-section step that isn't a station event at all.
 * Real SMART data uses "A" (arrival) / "D" (departure) / "B" / "C" for other
 * berth-step semantics (timing berths, etc.) — treating every berth step as
 * "PASS" regardless of this code previously reported a train as having
 * "Passed <station>" for berths that actually represent it *approaching* that
 * station's platform, before it had arrived.
 */
function smartEventToLastEventType(eventType: string | null): "ARRIVAL" | "DEPARTURE" | "PASS" | null {
  if (eventType === "A") return "ARRIVAL";
  if (eventType === "D") return "DEPARTURE";
  if (eventType === "B" || eventType === "C") return "PASS";
  return null;
}

/**
 * Position-row key for a TD-only train.
 *
 * NOTE: a `TD:<tdArea>:<headcode>` variant was tried and reverted. The evidence
 * for it — 414 of 1,432 TD trains apparently reporting from 2+ signalling areas
 * at once — turned out to be an artifact of a SECOND writer (a `train-service`
 * from a different checkout) hitting this same database with the older
 * `TD:<headcode>` key. Two processes fighting over the same rows produced
 * exactly the symptoms that "headcode collision" would. Re-establish whether
 * genuine collisions exist with a single writer running before changing this
 * key again.
 */
function tdTrainId(b: Pick<BerthStep, "tdArea" | "headcode">): string {
  return `TD:${b.headcode}`;
}

/**
 * Locked by the same key applyBerthStep writes to — see withKeyLock's comment.
 * TD is the highest-volume feed (CLAUDE.md), and its berth steps for one train
 * arrive close together by nature (consecutive track sections).
 */
export function applyBerthStep(b: BerthStep): Promise<string | undefined> {
  return withKeyLock(tdTrainId(b), () => applyBerthStepLocked(b));
}

async function applyBerthStepLocked(b: BerthStep): Promise<string | undefined> {
  await ensureRef();
  const smart = berthToStanox.get(`${b.tdArea}|${b.fromBerth ?? ""}|${b.toBerth ?? ""}`);
  const loc = smart ? stanoxToCrs.get(smart.stanox) : undefined;
  const crs = loc?.crs ?? null;
  const lastEventType = smartEventToLastEventType(smart?.eventType ?? null);
  // No recognised station event for this berth boundary: don't report a
  // location at all rather than guessing "PASS" for a mid-section step.
  if (!crs || !lastEventType) return crs ?? undefined;

  // TD is keyed by headcode, not train_id. Update any position row we can match
  // by headcode; otherwise record the berth against the headcode as the key so
  // the service layer can still surface "train X near <area>".
  //
  // Also resolve and stamp the Darwin rid here (best-effort, null when
  // ambiguous/unknown) so this row is directly comparable with the
  // TRUST-keyed row applyActivation writes — without it, a reader scoped to
  // `rid` can only ever see the coarser TRUST movement position and never
  // this feed's finer-grained berth steps, even when this row is fresher.
  const reportedAt = new Date(b.timestampMs);
  const berth = b.toBerth ?? b.fromBerth ?? null;

  // A fresh resolution wins when it finds one. Only when it misses do we fall
  // back to the existing row's rid — and even then only after re-checking it
  // against THIS report (see revalidateRid's comment): without that check, a
  // rid that slipped through under a looser match (or a headcode reassigned to
  // a different physical train since) stuck forever, because every later miss
  // from findRidForHeadcode fell back to "keep the existing value" with
  // nothing ever asking whether that value still made sense. Confirmed live:
  // TD:1A41 stayed linked to a Manchester Piccadilly -> Euston rid while
  // reporting from Clapham Junction, nowhere on that route. The extra query
  // for the existing row only runs on this fallback path, not on every step —
  // TD is the highest-volume feed (CLAUDE.md), so avoid it when a fresh
  // resolution already answers the question.
  let rid = await findRidForHeadcode(b.headcode, reportedAt, loc?.tiploc, crs).catch(() => null);
  if (!rid) {
    const existingRow = await db
      .select({ rid: nrTrainPosition.rid })
      .from(nrTrainPosition)
      .where(eq(nrTrainPosition.trainId, tdTrainId(b)))
      .limit(1);
    rid = await revalidateRid(existingRow[0]?.rid ?? null, loc?.tiploc ?? null, crs, reportedAt);
  }

  // The snapshot write below is guarded on reportedAt (see the `where` on the
  // upsert), so an older report can never overwrite a newer one's rid. This is
  // the same idiom darwin-ingest/src/store.ts uses for out-of-order Kafka
  // replay, and it is correct on its own merits: withKeyLock serialises by
  // ARRIVAL order, not by reportedAt, so nothing else enforces this.
  //
  // It was originally added to explain a "live-vs-history divergence" where
  // nr_train_position kept a stale rid while the history row correctly held
  // null. That divergence turned out to be caused by a SECOND process (a
  // `train-service` from a different checkout) writing these same rows
  // concurrently, not by out-of-order delivery within this service. The guard
  // is kept because it is cheap and genuinely prevents stale overwrites, but
  // it was not the fix for that symptom — see the note on tdTrainId.
  await db.transaction(async (tx) => {
    await tx
      .insert(nrTrainPosition)
      .values({
        trainId: tdTrainId(b),
        headcode: b.headcode,
        rid,
        tdArea: b.tdArea,
        berth,
        lastStanox: smart?.stanox ?? null,
        lastCrs: crs,
        lastEventType,
        lastReportedAt: reportedAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: nrTrainPosition.trainId,
        set: {
          headcode: b.headcode,
          // Write rid as computed above, including null — see the comment
          // above for why this must not silently keep a stale value.
          rid,
          tdArea: b.tdArea,
          berth,
          lastStanox: smart?.stanox ?? null,
          lastCrs: crs,
          lastEventType,
          lastReportedAt: reportedAt,
          updatedAt: new Date(),
        },
        // Only apply if this report is at least as new as what's stored —
        // see the comment above. `>=` not `>`: two reports can share a
        // whole-second timestamp, and the later-arriving one is still the
        // better value for a berth step (it's the further-along berth).
        where: or(
          sql`${nrTrainPosition.lastReportedAt} is null`,
          sql`${reportedAt.toISOString()}::timestamptz >= ${nrTrainPosition.lastReportedAt}`,
        ),
      });
    await tx.insert(nrTrainPositionHistory).values({
      trainId: tdTrainId(b),
      headcode: b.headcode,
      rid,
      tdArea: b.tdArea,
      berth,
      lastStanox: smart?.stanox ?? null,
      lastCrs: crs,
      lastEventType,
      reportedAt,
    });
  });
  maybePruneHistory();
  return crs ?? undefined;
}

/**
 * Store a batch of S-class signalling reports. Last-writer-wins per (area,
 * address): each row is the current byte at that address. Decoding to specific
 * signals/aspects is a read-time join against sop_mapping.
 */
export async function applySClass(reports: SClassReport[]): Promise<void> {
  if (reports.length === 0) return;
  // Collapse to the latest byte per address within this batch before writing.
  const latest = new Map<string, SClassReport>();
  for (const r of reports) {
    const key = `${r.tdArea}|${r.address}`;
    const prev = latest.get(key);
    if (!prev || r.timestampMs >= prev.timestampMs) latest.set(key, r);
  }
  const rows = [...latest.values()].map((r) => ({
    tdArea: r.tdArea,
    address: r.address,
    data: r.data,
    updatedAt: new Date(r.timestampMs),
  }));
  await db
    .insert(nrSignallingState)
    .values(rows)
    .onConflictDoUpdate({
      target: [nrSignallingState.tdArea, nrSignallingState.address],
      set: { data: sql`excluded.data`, updatedAt: sql`excluded.updated_at` },
    });
}
