"use server";

import { CommuteInput, HolidayInput } from "@mainline/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createCommute,
  deleteCommute,
  updateCommute,
} from "@/lib/commutes";
import { requireUser } from "@/lib/current-user";
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
  const userId = await requireUser();

  if (commuteId) {
    const updated = await updateCommute(userId, commuteId, parsed.data);
    if (!updated) return { ok: false, error: "Commute not found" };
  } else {
    await createCommute(userId, parsed.data);
  }
  revalidatePath("/commute");
  redirect("/commute");
}

export async function deleteCommuteAction(commuteId: string): Promise<void> {
  const userId = await requireUser();
  await deleteCommute(userId, commuteId);
  revalidatePath("/commute");
  redirect("/commute");
}

export async function addHolidayAction(raw: unknown): Promise<ActionResult> {
  const parsed = HolidayInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid dates" };
  }
  const userId = await requireUser();
  await createHoliday(userId, parsed.data);
  revalidatePath("/commute/holidays");
  revalidatePath("/commute");
  return { ok: true };
}

export async function deleteHolidayAction(id: string): Promise<void> {
  const userId = await requireUser();
  await deleteHoliday(userId, id);
  revalidatePath("/commute/holidays");
  revalidatePath("/commute");
}
