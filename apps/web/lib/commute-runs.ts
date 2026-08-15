import { commuteRun } from "@signaller/db";
import { londonDate } from "@signaller/shared";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { getCommute } from "./commutes";
import { getDb } from "./db";
import type { JourneyView } from "./journeys";

/**
 * A started commute — see the commute_run table comment for why this exists.
 * Short version: without it the dashboard re-resolves which leg is "active" on
 * every refresh, so the page flips from your morning train to your evening one
 * the moment the AM window ends, mid-journey.
 */
export interface CommuteRun {
  id: string;
  commuteId: string;
  commuteLegId: string | null;
  serviceDate: string;
  direction: "am" | "pm";
  originCrs: string;
  originLabel: string;
  destCrs: string;
  destLabel: string;
  journey: JourneyView | null;
  scheduledArrival: string | null;
  startedAt: string;
}

/**
 * How long past its scheduled arrival a run may live before we stop believing
 * it. Auto-end normally fires on arrival; this is the safety net for the case
 * where we never see one — the journey had no arrival time, the feeds went
 * quiet, or the user simply closed the app mid-trip. Without it a stuck run
 * would pin the dashboard to a finished journey indefinitely.
 */
const RUN_GRACE_MS = 3 * 60 * 60_000;

function toRun(row: typeof commuteRun.$inferSelect): CommuteRun {
  return {
    id: row.id,
    commuteId: row.commuteId,
    commuteLegId: row.commuteLegId,
    serviceDate: row.serviceDate,
    direction: row.direction === "pm" ? "pm" : "am",
    originCrs: row.originCrs,
    originLabel: row.originLabel,
    destCrs: row.destCrs,
    destLabel: row.destLabel,
    journey: (row.journey as JourneyView | null) ?? null,
    scheduledArrival: row.scheduledArrival?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
  };
}

export interface StartRunInput {
  commuteId: string;
  commuteLegId?: string | null;
  direction: "am" | "pm";
  originCrs: string;
  originLabel: string;
  destCrs: string;
  destLabel: string;
  journey?: JourneyView | null;
}

/**
 * Locks in a commute. Any run already open on this commute is ended first
 * ("superseded" is recorded as manual): starting a new one is an explicit
 * instruction to replace whatever was in play, and the partial unique index
 * would reject the insert otherwise.
 */
export async function startRun(
  userId: string,
  input: StartRunInput,
  now = new Date(),
): Promise<CommuteRun> {
  const db = getDb();
  await endActiveRun(userId, input.commuteId, "manual", now);

  // Prefer the live arrival estimate — a run started on a delayed train should
  // expire late too, not on the booked time it was never going to meet.
  const arrivalIso = input.journey?.liveArrives ?? input.journey?.arrives ?? null;
  const arrival = arrivalIso ? new Date(arrivalIso) : null;

  const inserted = await db
    .insert(commuteRun)
    .values({
      userId,
      commuteId: input.commuteId,
      commuteLegId: input.commuteLegId ?? null,
      serviceDate: londonDate(now),
      direction: input.direction,
      originCrs: input.originCrs,
      originLabel: input.originLabel,
      destCrs: input.destCrs,
      destLabel: input.destLabel,
      journey: input.journey ?? null,
      scheduledArrival: arrival && !Number.isNaN(arrival.getTime()) ? arrival : null,
      startedAt: now,
    })
    .returning();

  return toRun(inserted[0]!);
}

/**
 * `startRun`, with the ownership checks every caller needs.
 *
 * Both `commuteId` and `commuteLegId` arrive from the client, so both have to
 * be proven to belong to this user before a run is written against them: an id
 * from someone else's commute would mis-attribute the run, and an id from a
 * *different* commute of the same user would mis-attribute the leg.
 *
 * This lives here rather than in the server action because there are now two
 * callers — the web action and the native app's POST route — and the checks
 * are the kind of thing that quietly drifts apart when duplicated.
 */
export async function startRunChecked(
  userId: string,
  input: StartRunInput,
  now = new Date(),
): Promise<{ ok: true; run: CommuteRun } | { ok: false; error: string }> {
  const owned = await getCommute(userId, input.commuteId);
  if (!owned) return { ok: false, error: "Commute not found" };

  // An id that isn't one of this commute's legs is dropped rather than
  // rejected: the run itself is still valid, just not leg-attributed.
  const commuteLegId =
    input.commuteLegId && owned.legs.some((leg) => leg.id === input.commuteLegId)
      ? input.commuteLegId
      : null;

  const run = await startRun(userId, { ...input, commuteLegId }, now);
  return { ok: true, run };
}

/**
 * The run currently in play for a commute, or null.
 *
 * Auto-ends on arrival, which is the behaviour the user asked for: once the
 * journey's arrival time has passed the trip is over and the dashboard should
 * go back to resolving normally (typically showing the return leg). Runs with
 * no known arrival, or whose arrival estimate never materialised, fall back to
 * the grace window above so nothing can wedge.
 *
 * Ending is done here, on read, rather than by a background job — the
 * dashboard polls every 30 seconds anyway, so the check happens naturally
 * whenever it could possibly matter, with no scheduler to own.
 */
export async function getActiveRun(
  userId: string,
  commuteId: string,
  now = new Date(),
): Promise<CommuteRun | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(commuteRun)
    .where(
      and(
        eq(commuteRun.userId, userId),
        eq(commuteRun.commuteId, commuteId),
        isNull(commuteRun.endedAt),
      ),
    )
    .orderBy(desc(commuteRun.startedAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const run = toRun(row);

  const arrivedAt = run.scheduledArrival ? Date.parse(run.scheduledArrival) : NaN;
  if (Number.isFinite(arrivedAt) && now.getTime() >= arrivedAt) {
    await endRunById(run.id, "arrived", now);
    return null;
  }

  if (now.getTime() - Date.parse(run.startedAt) > RUN_GRACE_MS) {
    await endRunById(run.id, "expired", now);
    return null;
  }

  return run;
}

async function endRunById(id: string, reason: string, now: Date): Promise<void> {
  const db = getDb();
  await db
    .update(commuteRun)
    .set({ endedAt: now, endedReason: reason })
    .where(and(eq(commuteRun.id, id), isNull(commuteRun.endedAt)));
}

/** Ends whatever run is open on this commute. Returns true if one was ended. */
export async function endActiveRun(
  userId: string,
  commuteId: string,
  reason: "manual" | "arrived" | "expired" = "manual",
  now = new Date(),
): Promise<boolean> {
  const db = getDb();
  const res = await db
    .update(commuteRun)
    .set({ endedAt: now, endedReason: reason })
    .where(
      and(
        eq(commuteRun.userId, userId),
        eq(commuteRun.commuteId, commuteId),
        isNull(commuteRun.endedAt),
      ),
    )
    .returning({ id: commuteRun.id });
  return res.length > 0;
}

/**
 * Safety sweep for runs left open by users who never came back — the read-path
 * auto-end in getActiveRun only fires for commutes someone is actually looking
 * at. Cheap to call from an existing maintenance pass.
 */
export async function expireStaleRuns(now = new Date()): Promise<number> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - RUN_GRACE_MS);
  const res = await db
    .update(commuteRun)
    .set({ endedAt: now, endedReason: "expired" })
    .where(and(isNull(commuteRun.endedAt), lt(commuteRun.startedAt, cutoff)))
    .returning({ id: commuteRun.id });
  return res.length;
}

/** Today's finished runs for a commute, newest first — for the calendar/history view. */
export async function listRunsForDate(
  userId: string,
  serviceDate: string,
): Promise<CommuteRun[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(commuteRun)
    .where(and(eq(commuteRun.userId, userId), eq(commuteRun.serviceDate, serviceDate)))
    .orderBy(desc(commuteRun.startedAt));
  return rows.map(toRun);
}

/** True when a run's own arrival time has passed — exported for tests. */
export function runHasArrived(run: CommuteRun, now = new Date()): boolean {
  if (!run.scheduledArrival) return false;
  const at = Date.parse(run.scheduledArrival);
  return Number.isFinite(at) && now.getTime() >= at;
}
