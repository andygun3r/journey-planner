import { commuteHoliday } from "@mainline/db";
import { type HolidayInput, type HolidayRange } from "@mainline/shared";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./db";

export interface HolidayRecord extends HolidayRange {
  id: string;
  label: string | null;
}

export async function listHolidays(deviceId: string): Promise<HolidayRecord[]> {
  const rows = await getDb()
    .select()
    .from(commuteHoliday)
    .where(eq(commuteHoliday.deviceId, deviceId))
    .orderBy(asc(commuteHoliday.startDate));
  return rows.map((r) => ({
    id: r.id,
    startDate: r.startDate,
    endDate: r.endDate,
    label: r.label,
  }));
}

/** Just the ranges — used by the resolver and the ingest alert matcher. */
export async function holidayRangesFor(deviceId: string): Promise<HolidayRange[]> {
  const rows = await getDb()
    .select({ startDate: commuteHoliday.startDate, endDate: commuteHoliday.endDate })
    .from(commuteHoliday)
    .where(eq(commuteHoliday.deviceId, deviceId));
  return rows;
}

export async function createHoliday(deviceId: string, input: HolidayInput): Promise<string> {
  const res = await getDb()
    .insert(commuteHoliday)
    .values({
      deviceId,
      startDate: input.startDate,
      endDate: input.endDate,
      label: input.label ?? null,
    })
    .returning({ id: commuteHoliday.id });
  return res[0]!.id;
}

export async function deleteHoliday(deviceId: string, id: string): Promise<boolean> {
  const res = await getDb()
    .delete(commuteHoliday)
    .where(and(eq(commuteHoliday.id, id), eq(commuteHoliday.deviceId, deviceId)))
    .returning({ id: commuteHoliday.id });
  return res.length > 0;
}
