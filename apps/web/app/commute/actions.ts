"use server";

import { CommuteInput, HolidayInput } from "@mainline/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createCommute,
  deleteCommute,
  updateCommute,
} from "@/lib/commutes";
import { requireDevice } from "@/lib/device";
import { createHoliday, deleteHoliday } from "@/lib/holidays";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Create or update a commute from the editor. Redirects to the dashboard on success. */
export async function saveCommuteAction(
  commuteId: string | null,
  raw: unknown,
): Promise<ActionResult> {
  const parsed = CommuteInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid commute" };
  }
  const deviceId = await requireDevice();

  if (commuteId) {
    const updated = await updateCommute(deviceId, commuteId, parsed.data);
    if (!updated) return { ok: false, error: "Commute not found" };
  } else {
    await createCommute(deviceId, parsed.data);
  }
  revalidatePath("/commute");
  redirect("/commute");
}

export async function deleteCommuteAction(commuteId: string): Promise<void> {
  const deviceId = await requireDevice();
  await deleteCommute(deviceId, commuteId);
  revalidatePath("/commute");
  redirect("/commute");
}

export async function addHolidayAction(raw: unknown): Promise<ActionResult> {
  const parsed = HolidayInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid dates" };
  }
  const deviceId = await requireDevice();
  await createHoliday(deviceId, parsed.data);
  revalidatePath("/commute/holidays");
  revalidatePath("/commute");
  return { ok: true };
}

export async function deleteHolidayAction(id: string): Promise<void> {
  const deviceId = await requireDevice();
  await deleteHoliday(deviceId, id);
  revalidatePath("/commute/holidays");
  revalidatePath("/commute");
}
