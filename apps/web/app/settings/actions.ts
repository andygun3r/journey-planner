"use server";

import { AccessibilityPrefsInput } from "@signaller/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/current-user";
import { setAccessibilityPrefs } from "@/lib/accessibility-prefs";
import { deleteAccount } from "@/lib/account";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function updateAccessibilityPrefsAction(raw: unknown): Promise<ActionResult> {
  const parsed = AccessibilityPrefsInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid preferences" };
  }
  const userId = await requireUser();
  await setAccessibilityPrefs(userId, parsed.data);
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Permanently deletes the signed-in user's account, then signs them out. */
export async function deleteAccountAction(): Promise<void> {
  const userId = await requireUser();
  await deleteAccount(userId);
  redirect("/login");
}
