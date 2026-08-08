import { commute, commuteDayOverride } from "@signaller/db";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "./db";

/**
 * Single-date changes to a commute — see the commute_day_override table
 * comment. The weekly grid stays the template; these are the exceptions to it.
 */
export interface DayOverride {
  id: string;
  commuteId: string;
  date: string;
  skipped: boolean;
  workCrs: string | null;
  workLabel: string | null;
  amWindowStart: string | null;
  amWindowEnd: string | null;
  pmWindowStart: string | null;
  pmWindowEnd: string | null;
  note: string | null;
}

/** Postgres `time` comes back as HH:MM:SS; the UI speaks HH:MM. */
const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

function toOverride(row: typeof commuteDayOverride.$inferSelect): DayOverride {
  return {
    id: row.id,
    commuteId: row.commuteId,
    date: row.date,
    skipped: row.skipped,
    workCrs: row.workCrs,
    workLabel: row.workLabel,
    amWindowStart: hhmm(row.amWindowStart),
    amWindowEnd: hhmm(row.amWindowEnd),
    pmWindowStart: hhmm(row.pmWindowStart),
    pmWindowEnd: hhmm(row.pmWindowEnd),
    note: row.note,
  };
}

/** Ownership check — every write below goes through this first. */
async function ownsCommute(userId: string, commuteId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: commute.id })
    .from(commute)
    .where(and(eq(commute.id, commuteId), eq(commute.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** Every override for a commute within an inclusive date range — one query per calendar month. */
export async function listOverrides(
  userId: string,
  commuteId: string,
  startDate: string,
  endDate: string,
): Promise<DayOverride[]> {
  if (!(await ownsCommute(userId, commuteId))) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(commuteDayOverride)
    .where(
      and(
        eq(commuteDayOverride.commuteId, commuteId),
        gte(commuteDayOverride.date, startDate),
        lte(commuteDayOverride.date, endDate),
      ),
    );
  return rows.map(toOverride);
}

/** The override for one date, or null when that date follows the usual template. */
export async function getOverride(
  userId: string,
  commuteId: string,
  date: string,
): Promise<DayOverride | null> {
  if (!(await ownsCommute(userId, commuteId))) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(commuteDayOverride)
    .where(and(eq(commuteDayOverride.commuteId, commuteId), eq(commuteDayOverride.date, date)))
    .limit(1);
  return rows[0] ? toOverride(rows[0]) : null;
}

export interface OverrideInput {
  skipped?: boolean;
  workCrs?: string | null;
  workLabel?: string | null;
  amWindowStart?: string | null;
  amWindowEnd?: string | null;
  pmWindowStart?: string | null;
  pmWindowEnd?: string | null;
  note?: string | null;
}

/** Upsert one date's override. */
export async function saveOverride(
  userId: string,
  commuteId: string,
  date: string,
  input: OverrideInput,
): Promise<boolean> {
  if (!(await ownsCommute(userId, commuteId))) return false;
  const db = getDb();
  const values = {
    commuteId,
    date,
    skipped: input.skipped ?? false,
    workCrs: input.workCrs ?? null,
    workLabel: input.workLabel ?? null,
    amWindowStart: input.amWindowStart ?? null,
    amWindowEnd: input.amWindowEnd ?? null,
    pmWindowStart: input.pmWindowStart ?? null,
    pmWindowEnd: input.pmWindowEnd ?? null,
    note: input.note ?? null,
  };
  await db
    .insert(commuteDayOverride)
    .values(values)
    .onConflictDoUpdate({
      target: [commuteDayOverride.commuteId, commuteDayOverride.date],
      set: values,
    });
  return true;
}

/**
 * Applies the same change to every future occurrence of a weekday — the "and
 * all future Tuesdays" branch of the editor's this-day/all-future choice.
 *
 * Deliberately written as dated overrides rather than by editing the
 * day-of-week leg. Editing the leg would silently rewrite history: past dates
 * resolve through the same template, so a Tuesday changed in August would also
 * change what last February's Tuesdays claim to have been. Writing forward-dated
 * overrides keeps the past intact and leaves the template as the user set it.
 *
 * Bounded to a horizon rather than "forever" — an unbounded write has no
 * natural end, and a year ahead is already further than anyone plans a commute.
 */
const FUTURE_HORIZON_WEEKS = 52;

export async function saveOverrideForFutureWeekdays(
  userId: string,
  commuteId: string,
  fromDate: string,
  input: OverrideInput,
): Promise<number> {
  if (!(await ownsCommute(userId, commuteId))) return 0;

  const dates: string[] = [];
  const start = new Date(`${fromDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return 0;
  for (let w = 0; w < FUTURE_HORIZON_WEEKS; w++) {
    const d = new Date(start.getTime() + w * 7 * 86_400_000);
    dates.push(d.toISOString().slice(0, 10));
  }

  const db = getDb();
  const rows = dates.map((date) => ({
    commuteId,
    date,
    skipped: input.skipped ?? false,
    workCrs: input.workCrs ?? null,
    workLabel: input.workLabel ?? null,
    amWindowStart: input.amWindowStart ?? null,
    amWindowEnd: input.amWindowEnd ?? null,
    pmWindowStart: input.pmWindowStart ?? null,
    pmWindowEnd: input.pmWindowEnd ?? null,
    note: input.note ?? null,
  }));

  await db
    .insert(commuteDayOverride)
    .values(rows)
    .onConflictDoUpdate({
      target: [commuteDayOverride.commuteId, commuteDayOverride.date],
      set: {
        skipped: input.skipped ?? false,
        workCrs: input.workCrs ?? null,
        workLabel: input.workLabel ?? null,
        amWindowStart: input.amWindowStart ?? null,
        amWindowEnd: input.amWindowEnd ?? null,
        pmWindowStart: input.pmWindowStart ?? null,
        pmWindowEnd: input.pmWindowEnd ?? null,
        note: input.note ?? null,
      },
    });
  return rows.length;
}

/** Removes an override so the date goes back to following the weekly template. */
export async function clearOverride(
  userId: string,
  commuteId: string,
  date: string,
): Promise<boolean> {
  if (!(await ownsCommute(userId, commuteId))) return false;
  const db = getDb();
  const res = await db
    .delete(commuteDayOverride)
    .where(and(eq(commuteDayOverride.commuteId, commuteId), eq(commuteDayOverride.date, date)))
    .returning({ id: commuteDayOverride.id });
  return res.length > 0;
}

/** Bulk clear — used by "revert all future Tuesdays to usual". */
export async function clearOverrides(
  userId: string,
  commuteId: string,
  dates: string[],
): Promise<number> {
  if (dates.length === 0) return 0;
  if (!(await ownsCommute(userId, commuteId))) return 0;
  const db = getDb();
  const res = await db
    .delete(commuteDayOverride)
    .where(
      and(eq(commuteDayOverride.commuteId, commuteId), inArray(commuteDayOverride.date, dates)),
    )
    .returning({ id: commuteDayOverride.id });
  return res.length;
}
