import {
  getSharedDb,
  darwinStopForecast,
  darwinTrain,
  nrCorpus,
  nrHeadcode,
  nrSignallingState,
  nrSmart,
  nrTrainPosition,
  nrTrainPositionHistory,
} from "@mainline/db";
import { alignCallsToRun, hhmmToIso, londonDateKey } from "@mainline/shared";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  inTravelOrder,
  scoreAtLocation,
  SCORE_ACTUAL_IN_WINDOW,
  SCORE_NONE,
  TD_TOLERANCE_MS,
  type PatternRow,
} from "./correlation.js";
import type { BerthStep, MovementReport, SClassReport } from "./parse.js";

const db = getSharedDb();

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

// Retention lives in darwin-ingest's nightly pruneExpiredData, not here. There
// used to be a sweep-on-write on this path that fired on Math.random() < 0.001
// and issued an un-awaited bulk DELETE from inside the busiest loop in the
// system. Nothing bounded how many could overlap, and its rate followed traffic
// rather than time. maintenance.ts's comment already claimed to have replaced
// it; this removes the code that claim was about.

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
 * Booked calling patterns, cached per rid.
 *
 * These columns never change once written. darwin-ingest's applySchedule seeds
 * sched_arr/sched_dep/seq from the SC message, and applyTS deliberately does
 * NOT overwrite them (see its comment about seq) — only a schedule re-issue
 * does. So a pattern is safe to hold for a long time.
 *
 * This is what makes correlation cheap. Scoring a candidate used to mean a
 * join query, plus a second query pulling its whole pattern when a stop had no
 * booked time. With 43 candidates for one headcode — measured, see
 * findRidForHeadcode — that was 50-90 sequential queries for ONE berth step, on
 * the highest-volume feed in the system. Now it is one batched query for all
 * candidates, and usually none at all.
 */
const PATTERN_TTL_MS = Number(process.env.NR_PATTERN_CACHE_TTL_MS ?? 30 * 60_000);

/**
 * Deactivation is checked separately and kept far shorter, because unlike the
 * booked times it genuinely does flip during the day.
 */
const ACTIVE_TTL_MS = Number(process.env.NR_ACTIVE_CACHE_TTL_MS ?? 60_000);

/** Stops the caches growing without bound on a long-running process. */
const MAX_CACHED_RIDS = Number(process.env.NR_PATTERN_CACHE_MAX ?? 20_000);

interface CachedCandidate {
  pattern: PatternRow[];
  patternAt: number;
  deactivated: boolean;
  activeAt: number;
}

const candidateCache = new Map<string, CachedCandidate>();

/** Drops the oldest half when the cache gets too big. Cheap and good enough. */
function trimCandidateCache(): void {
  if (candidateCache.size <= MAX_CACHED_RIDS) return;
  const entries = [...candidateCache.entries()].sort((a, b) => a[1].patternAt - b[1].patternAt);
  for (const [rid] of entries.slice(0, Math.floor(entries.length / 2))) {
    candidateCache.delete(rid);
  }
}

/**
 * Load the pattern and deactivation state for these rids, in as few queries as
 * possible, and cache what comes back.
 */
async function loadCandidates(rids: string[], now = Date.now()): Promise<void> {
  const needPattern = rids.filter((rid) => {
    const hit = candidateCache.get(rid);
    return !hit || now - hit.patternAt >= PATTERN_TTL_MS;
  });
  const needActive = rids.filter((rid) => {
    const hit = candidateCache.get(rid);
    return !hit || now - hit.activeAt >= ACTIVE_TTL_MS;
  });

  if (needActive.length > 0) {
    const rows = await db
      .select({ rid: darwinTrain.rid, deactivated: darwinTrain.deactivated })
      .from(darwinTrain)
      .where(inArray(darwinTrain.rid, needActive));
    const byRid = new Map(rows.map((r) => [r.rid, r.deactivated]));
    for (const rid of needActive) {
      const existing = candidateCache.get(rid);
      candidateCache.set(rid, {
        pattern: existing?.pattern ?? [],
        patternAt: existing?.patternAt ?? 0,
        // A rid with no darwin_train row explains nothing, same as deactivated.
        deactivated: byRid.get(rid) ?? true,
        activeAt: now,
      });
    }
  }

  if (needPattern.length > 0) {
    const rows = await db
      .select({
        rid: darwinStopForecast.rid,
        seq: darwinStopForecast.seq,
        tiploc: darwinStopForecast.tiploc,
        crs: darwinStopForecast.crs,
        schedArr: darwinStopForecast.schedArr,
        schedDep: darwinStopForecast.schedDep,
        schedPass: darwinStopForecast.schedPass,
      })
      .from(darwinStopForecast)
      .where(inArray(darwinStopForecast.rid, needPattern));

    const byRid = new Map<string, PatternRow[]>();
    for (const r of rows) {
      const list = byRid.get(r.rid) ?? [];
      list.push(r);
      byRid.set(r.rid, list);
    }
    for (const rid of needPattern) {
      const existing = candidateCache.get(rid);
      candidateCache.set(rid, {
        // Stored in travel order once, so every later read is free.
        pattern: inTravelOrder(byRid.get(rid) ?? []),
        patternAt: now,
        deactivated: existing?.deactivated ?? true,
        activeAt: existing?.activeAt ?? now,
      });
    }
  }

  trimCandidateCache();
}

/** The cached pattern for a rid, loading it first if needed. */
async function patternFor(rid: string): Promise<CachedCandidate> {
  await loadCandidates([rid]);
  return candidateCache.get(rid) ?? { pattern: [], patternAt: 0, deactivated: true, activeAt: 0 };
}

/**
 * Does this candidate rid have a plausible reason to be reporting from this
 * location around `at`? Thin wrapper over the pure scorer in correlation.ts,
 * which holds the reasoning and the measurements behind these rules.
 */
async function candidatePlausibleAtLocation(
  rid: string,
  tiploc: string | null,
  crs: string | null,
  at: Date,
  bookedAt?: Date | null,
): Promise<number> {
  const cached = await patternFor(rid);
  return scoreAtLocation(cached.pattern, cached.deactivated, tiploc, crs, at, bookedAt);
}

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
/**
 * How long a resolved (or unresolved) headcode answer stays good for.
 *
 * Short on purpose. The point is to collapse the burst of berth steps a train
 * produces while crossing one signalling area, not to hold an answer across a
 * headcode being reassigned to a different train later in the day.
 */
const RESOLUTION_TTL_MS = Number(process.env.NR_RESOLUTION_CACHE_TTL_MS ?? 60_000);
const MAX_CACHED_RESOLUTIONS = Number(process.env.NR_RESOLUTION_CACHE_MAX ?? 50_000);

const resolutionCache = new Map<string, { rid: string | null; at: number }>();

/**
 * Cached wrapper around the real resolution below.
 *
 * A train sitting in one area produces many berth steps that all resolve to the
 * same station, and each one used to re-run the whole cascade. Misses are
 * cached too, which matters more than hits: an unresolvable headcode was the
 * worst case, paying the full 50-90 query cost on every report, forever.
 *
 * The report time shapes the answer but is deliberately not in the key. That is
 * safe because the plausibility window is +/-90 minutes and an entry lives for
 * one — a minute of drift cannot move a candidate across that boundary.
 */
async function findRidForHeadcode(
  headcode: string,
  at: Date,
  nearTiploc?: string | null,
  nearCrs?: string | null,
  bookedAt?: Date | null,
  trainId?: string | null,
): Promise<string | null> {
  const key = [
    headcode,
    londonDateKey(at),
    nearTiploc ?? "",
    nearCrs ?? "",
    // Booked time is real evidence, so reports booked for different minutes are
    // different questions and must not share an answer.
    bookedAt ? Math.round(bookedAt.getTime() / 60_000) : "",
    trainId ?? "",
  ].join("|");

  const hit = resolutionCache.get(key);
  if (hit && Date.now() - hit.at < RESOLUTION_TTL_MS) return hit.rid;

  const rid = await resolveRidForHeadcode(headcode, at, nearTiploc, nearCrs, bookedAt, trainId);

  if (resolutionCache.size > MAX_CACHED_RESOLUTIONS) resolutionCache.clear();
  resolutionCache.set(key, { rid, at: Date.now() });
  return rid;
}

async function resolveRidForHeadcode(
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
  // Load every candidate's pattern in one go, then score them in memory.
  //
  // This used to be a query per candidate inside the loop, each of which could
  // fire a second query to pull the whole pattern for interpolation. One
  // measured headcode had 43 candidates, so a single berth step cost 50-90
  // sequential round trips — on the busiest feed in the system. Now it is at
  // most one query for the patterns and one for deactivation, and none at all
  // once they are cached.
  await loadCandidates(candidates.map((c) => c.rid));

  const scored = candidates
    .map((c) => {
      const cached = candidateCache.get(c.rid);
      return {
        rid: c.rid,
        score: cached
          ? scoreAtLocation(
              cached.pattern,
              cached.deactivated,
              nearTiploc ?? null,
              nearCrs ?? null,
              at,
              bookedAt,
            )
          : SCORE_NONE,
      };
    })
    .sort((a, b) => b.score - a.score);

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
