"use server";

import { CommuteInput, HolidayInput } from "@signaller/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createCommute,
  deleteCommute,
  getCommute,
  updateCommute,
} from "@/lib/commutes";
import {
  clearOverride,
  type OverrideInput,
  saveOverride,
  saveOverrideForFutureWeekdays,
} from "@/lib/commute-overrides";
import { endActiveRun, startRun } from "@/lib/commute-runs";
import { requireUser } from "@/lib/current-user";
import { createHoliday, deleteHoliday } from "@/lib/holidays";
import type { JourneyView } from "@/lib/journeys";

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

/**
 * "Start commute" — locks the dashboard to this direction and this train until
 * it arrives. See the commute_run table comment for why the dashboard can't
 * just keep re-resolving the schedule.
 */
export async function startCommuteAction(input: {
  commuteId: string;
  commuteLegId?: string | null;
  direction: "am" | "pm";
  originCrs: string;
  originLabel: string;
  destCrs: string;
  destLabel: string;
  journey?: JourneyView | null;
}): Promise<ActionResult> {
  const userId = await requireUser();

  // commuteId arrives from the client, so prove it belongs to this user before
  // writing a run against it.
  const owned = await getCommute(userId, input.commuteId);
  if (!owned) return { ok: false, error: "Commute not found" };

  // Likewise the leg: an id from another commute would mis-attribute the run.
  const legId =
    input.commuteLegId && owned.legs.some((l) => l.id === input.commuteLegId)
      ? input.commuteLegId
      : null;

  await startRun(userId, { ...input, commuteLegId: legId });
  revalidatePath("/commute");
  return { ok: true };
}

/** Ends the current run early — "I'm not travelling after all" / "I'm there". */
export async function endCommuteAction(commuteId: string): Promise<ActionResult> {
  const userId = await requireUser();
  await endActiveRun(userId, commuteId, "manual");
  revalidatePath("/commute");
  return { ok: true };
}

/**
 * Saves one date's override, or the same change to every future occurrence of
 * that weekday — the calendar's this-day/all-future choice.
 */
export async function saveDayOverrideAction(args: {
  commuteId: string;
  date: string;
  scope: "date" | "future";
  input: OverrideInput;
}): Promise<ActionResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    return { ok: false, error: "Invalid date" };
  }
  const userId = await requireUser();

  // Both writers ownership-check internally and return false/0 on a mismatch.
  const ok =
    args.scope === "future"
      ? (await saveOverrideForFutureWeekdays(userId, args.commuteId, args.date, args.input)) > 0
      : await saveOverride(userId, args.commuteId, args.date, args.input);

  if (!ok) return { ok: false, error: "Commute not found" };
  revalidatePath("/commute");
  revalidatePath("/commute/calendar");
  return { ok: true };
}

/** Drops an override so the date follows the weekly template again. */
export async function clearDayOverrideAction(
  commuteId: string,
  date: string,
): Promise<ActionResult> {
  const userId = await requireUser();
  await clearOverride(userId, commuteId, date);
  revalidatePath("/commute");
  revalidatePath("/commute/calendar");
  return { ok: true };
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
