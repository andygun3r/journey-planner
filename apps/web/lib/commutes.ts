import { commute, commuteLeg } from "@mainline/db";
import { type CommuteInput, type CommuteLegRecord, type CommuteRecord } from "@mainline/shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";

export interface CommuteWithLegs extends CommuteRecord {
  legs: CommuteLegRecord[];
}

function toLegRecord(row: typeof commuteLeg.$inferSelect): CommuteLegRecord {
  return {
    id: row.id,
    dayOfWeek: row.dayOfWeek,
    workCrs: row.workCrs,
    workLabel: row.workLabel,
    amWindowStart: row.amWindowStart,
    amWindowEnd: row.amWindowEnd,
    pmWindowStart: row.pmWindowStart,
    pmWindowEnd: row.pmWindowEnd,
  };
}

/** All of a device's commutes with their per-day legs, ordered by day. */
export async function listCommutes(userId: string): Promise<CommuteWithLegs[]> {
  const db = getDb();
  const commutes = await db.select().from(commute).where(eq(commute.userId, userId));
  if (commutes.length === 0) return [];

  const ids = commutes.map((c) => c.id);
  const legs = await db.select().from(commuteLeg);
  const legsByCommute = new Map<string, CommuteLegRecord[]>();
  for (const l of legs) {
    if (!ids.includes(l.commuteId)) continue;
    const arr = legsByCommute.get(l.commuteId) ?? [];
    arr.push(toLegRecord(l));
    legsByCommute.set(l.commuteId, arr);
  }

  return commutes.map((c) => ({
    id: c.id,
    label: c.label,
    homeCrs: c.homeCrs,
    homeLabel: c.homeLabel,
    legs: (legsByCommute.get(c.id) ?? []).sort((a, b) => a.dayOfWeek - b.dayOfWeek),
  }));
}

/** A single commute, ownership-checked, or null. */
export async function getCommute(
  userId: string,
  id: string,
): Promise<CommuteWithLegs | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(commute)
    .where(and(eq(commute.id, id), eq(commute.userId, userId)))
    .limit(1);
  const c = rows[0];
  if (!c) return null;
  const legs = await db.select().from(commuteLeg).where(eq(commuteLeg.commuteId, id));
  return {
    id: c.id,
    label: c.label,
    homeCrs: c.homeCrs,
    homeLabel: c.homeLabel,
    legs: legs.map(toLegRecord).sort((a, b) => a.dayOfWeek - b.dayOfWeek),
  };
}

/** Rows to insert into commute_leg for a validated input. */
function legValues(commuteId: string, input: CommuteInput) {
  return input.legs.map((l) => ({
    commuteId,
    dayOfWeek: l.dayOfWeek,
    workCrs: l.workCrs,
    workLabel: l.workLabel,
    amWindowStart: l.am.start ?? null,
    amWindowEnd: l.am.end ?? null,
    pmWindowStart: l.pm.start ?? null,
    pmWindowEnd: l.pm.end ?? null,
  }));
}

/**
 * Creates a commute + its legs. The legacy flat columns still exist and are
 * NOT NULL in the DB (pre per-day model), so seed them from the first leg to
 * satisfy the constraint; new code never reads them.
 */
export async function createCommute(userId: string, input: CommuteInput): Promise<string> {
  const db = getDb();
  const first = input.legs[0]!;
  const seedWindow = first.am.start ?? first.pm.start ?? "07:00";
  const seedWindowEnd = first.am.end ?? first.pm.end ?? "09:00";
  const daysMask = input.legs.reduce((m, l) => m | (1 << l.dayOfWeek), 0);

  const inserted = await db
    .insert(commute)
    .values({
      userId,
      label: input.label,
      homeCrs: input.homeCrs,
      homeLabel: input.homeLabel,
      // legacy (unused by new code):
      originCrs: input.homeCrs,
      destCrs: first.workCrs,
      daysMask,
      windowStart: seedWindow,
      windowEnd: seedWindowEnd,
    })
    .returning({ id: commute.id });

  const id = inserted[0]!.id;
  await db.insert(commuteLeg).values(legValues(id, input));
  return id;
}

/** Replaces a commute's fields and all its legs (ownership-checked). */
export async function updateCommute(
  userId: string,
  id: string,
  input: CommuteInput,
): Promise<boolean> {
  const db = getDb();
  const owned = await db
    .select({ id: commute.id })
    .from(commute)
    .where(and(eq(commute.id, id), eq(commute.userId, userId)))
    .limit(1);
  if (owned.length === 0) return false;

  await db
    .update(commute)
    .set({ label: input.label, homeCrs: input.homeCrs, homeLabel: input.homeLabel })
    .where(eq(commute.id, id));

  // Replace-all semantics for the weekly grid.
  await db.delete(commuteLeg).where(eq(commuteLeg.commuteId, id));
  await db.insert(commuteLeg).values(legValues(id, input));
  return true;
}

export async function deleteCommute(userId: string, id: string): Promise<boolean> {
  const db = getDb();
  const res = await db
    .delete(commute)
    .where(and(eq(commute.id, id), eq(commute.userId, userId)))
    .returning({ id: commute.id });
  return res.length > 0;
}
