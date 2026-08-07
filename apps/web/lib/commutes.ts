import { commute, commuteLeg, commuteLegPin } from "@signaller/db";
import {
  type CommuteInput,
  type CommuteLegInput,
  type CommuteLegPinInput,
  type CommuteLegPinRecord,
  type CommuteLegRecord,
  type CommuteRecord,
} from "@signaller/shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";

export interface CommuteWithLegs extends CommuteRecord {
  legs: CommuteLegRecord[];
}

function toPinRecord(row: typeof commuteLegPin.$inferSelect): CommuteLegPinRecord {
  return {
    id: row.id,
    direction: row.direction as "am" | "pm",
    sequence: row.sequence,
    trainUid: row.trainUid,
    gtfsTripId: row.gtfsTripId,
    originCrs: row.originCrs,
    originLabel: row.originLabel,
    schedDep: row.schedDep,
    destCrs: row.destCrs,
    destLabel: row.destLabel,
    schedArr: row.schedArr,
    toc: row.toc,
    pickedServiceDate: row.pickedServiceDate,
  };
}

function toLegRecord(row: typeof commuteLeg.$inferSelect, pins: CommuteLegPinRecord[]): CommuteLegRecord {
  return {
    id: row.id,
    dayOfWeek: row.dayOfWeek,
    workCrs: row.workCrs,
    workLabel: row.workLabel,
    amWindowStart: row.amWindowStart,
    amWindowEnd: row.amWindowEnd,
    pmWindowStart: row.pmWindowStart,
    pmWindowEnd: row.pmWindowEnd,
    backupWorkCrs: row.backupWorkCrs,
    backupHomeCrs: row.backupHomeCrs,
    backupNote: row.backupNote,
    pins: pins.sort((a, b) => a.sequence - b.sequence),
  };
}

/** All of a user's commutes with their per-day legs (and pins), ordered by day. */
export async function listCommutes(userId: string): Promise<CommuteWithLegs[]> {
  const db = getDb();
  const commutes = await db.select().from(commute).where(eq(commute.userId, userId));
  if (commutes.length === 0) return [];

  const ids = commutes.map((c) => c.id);
  const legs = await db.select().from(commuteLeg);
  const relevantLegs = legs.filter((l) => ids.includes(l.commuteId));
  const legIds = relevantLegs.map((l) => l.id);
  const pins = legIds.length > 0 ? await db.select().from(commuteLegPin) : [];
  const pinsByLeg = new Map<string, CommuteLegPinRecord[]>();
  for (const p of pins) {
    if (!legIds.includes(p.commuteLegId)) continue;
    const arr = pinsByLeg.get(p.commuteLegId) ?? [];
    arr.push(toPinRecord(p));
    pinsByLeg.set(p.commuteLegId, arr);
  }

  const legsByCommute = new Map<string, CommuteLegRecord[]>();
  for (const l of relevantLegs) {
    const arr = legsByCommute.get(l.commuteId) ?? [];
    arr.push(toLegRecord(l, pinsByLeg.get(l.id) ?? []));
    legsByCommute.set(l.commuteId, arr);
  }

  return commutes.map((c) => ({
    id: c.id,
    label: c.label,
    homeCrs: c.homeCrs,
    homeLabel: c.homeLabel,
    priority: c.priority,
    createdAt: c.createdAt.toISOString(),
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
  const legIds = legs.map((l) => l.id);
  const pins = legIds.length > 0 ? await db.select().from(commuteLegPin) : [];
  const pinsByLeg = new Map<string, CommuteLegPinRecord[]>();
  for (const p of pins) {
    if (!legIds.includes(p.commuteLegId)) continue;
    const arr = pinsByLeg.get(p.commuteLegId) ?? [];
    arr.push(toPinRecord(p));
    pinsByLeg.set(p.commuteLegId, arr);
  }
  return {
    id: c.id,
    label: c.label,
    homeCrs: c.homeCrs,
    homeLabel: c.homeLabel,
    priority: c.priority,
    createdAt: c.createdAt.toISOString(),
    legs: legs.map((l) => toLegRecord(l, pinsByLeg.get(l.id) ?? [])).sort((a, b) => a.dayOfWeek - b.dayOfWeek),
  };
}

/** Rows to insert into commute_leg for a validated input. */
function legValues(commuteId: string, input: CommuteInput) {
  return input.legs.map((l: CommuteLegInput) => ({
    commuteId,
    dayOfWeek: l.dayOfWeek,
    workCrs: l.workCrs,
    workLabel: l.workLabel,
    amWindowStart: l.am.start ?? null,
    amWindowEnd: l.am.end ?? null,
    pmWindowStart: l.pm.start ?? null,
    pmWindowEnd: l.pm.end ?? null,
    backupWorkCrs: l.backupWorkCrs ?? null,
    backupHomeCrs: l.backupHomeCrs ?? null,
    backupNote: l.backupNote ?? null,
  }));
}

/** Rows to insert into commute_leg_pin, keyed off the just-inserted legs' ids by dayOfWeek. */
function pinValues(input: CommuteInput, legIdByDow: Map<number, string>) {
  return input.legs.flatMap((l: CommuteLegInput) => {
    const commuteLegId = legIdByDow.get(l.dayOfWeek);
    if (!commuteLegId) return [];
    return l.pins.map((p: CommuteLegPinInput) => ({
      commuteLegId,
      direction: p.direction,
      sequence: p.sequence,
      trainUid: p.trainUid,
      gtfsTripId: p.gtfsTripId ?? null,
      originCrs: p.originCrs,
      originLabel: p.originLabel,
      schedDep: p.schedDep,
      destCrs: p.destCrs,
      destLabel: p.destLabel,
      schedArr: p.schedArr,
      toc: p.toc ?? null,
      pickedServiceDate: p.pickedServiceDate,
    }));
  });
}

/**
 * Creates a commute + its legs (+ any pinned services). The legacy flat
 * columns still exist and are NOT NULL in the DB (pre per-day model), so seed
 * them from the first leg to satisfy the constraint; new code never reads them.
 */
export async function createCommute(userId: string, input: CommuteInput): Promise<string> {
  const db = getDb();
  const first = input.legs[0]!;
  const seedWindow = first.am.start ?? first.pm.start ?? "07:00";
  const seedWindowEnd = first.am.end ?? first.pm.end ?? "09:00";
  const daysMask = input.legs.reduce((m: number, l: CommuteLegInput) => m | (1 << l.dayOfWeek), 0);

  const inserted = await db
    .insert(commute)
    .values({
      userId,
      label: input.label,
      homeCrs: input.homeCrs,
      homeLabel: input.homeLabel,
      priority: input.priority,
      // legacy (unused by new code):
      originCrs: input.homeCrs,
      destCrs: first.workCrs,
      daysMask,
      windowStart: seedWindow,
      windowEnd: seedWindowEnd,
    })
    .returning({ id: commute.id });

  const id = inserted[0]!.id;
  const insertedLegs = await db
    .insert(commuteLeg)
    .values(legValues(id, input))
    .returning({ id: commuteLeg.id, dayOfWeek: commuteLeg.dayOfWeek });
  const legIdByDow = new Map(insertedLegs.map((l) => [l.dayOfWeek, l.id]));
  const pins = pinValues(input, legIdByDow);
  if (pins.length > 0) await db.insert(commuteLegPin).values(pins);
  return id;
}

/**
 * Replaces a commute's fields, all its legs, and all pinned services
 * (ownership-checked). Replace-all semantics match the weekly grid editor —
 * old commute_leg rows (and their pins, via cascade) are deleted and
 * reinserted fresh, so pins are always keyed to this save's new leg ids.
 */
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
    .set({ label: input.label, homeCrs: input.homeCrs, homeLabel: input.homeLabel, priority: input.priority })
    .where(eq(commute.id, id));

  // Replace-all semantics for the weekly grid. Deleting commute_leg cascades
  // to commute_leg_pin, so old pins are cleaned up with it.
  await db.delete(commuteLeg).where(eq(commuteLeg.commuteId, id));
  const insertedLegs = await db
    .insert(commuteLeg)
    .values(legValues(id, input))
    .returning({ id: commuteLeg.id, dayOfWeek: commuteLeg.dayOfWeek });
  const legIdByDow = new Map(insertedLegs.map((l) => [l.dayOfWeek, l.id]));
  const pins = pinValues(input, legIdByDow);
  if (pins.length > 0) await db.insert(commuteLegPin).values(pins);
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
