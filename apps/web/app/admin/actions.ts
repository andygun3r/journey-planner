"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/require-admin";
import { setUserRole } from "@/lib/admin-users";
import { getPushSubscription, sendPushFromWeb } from "@/lib/push";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Send a test push to the signed-in admin's own device, to check the VAPID
 * keys and subscription actually work end to end. Deliberately only ever
 * targets the caller — an admin control that could push to other people's
 * devices is a spam vector, and this is a diagnostic, not a broadcast tool.
 */
export async function sendTestAlertAction(): Promise<ActionResult> {
  const admin = await requireAdmin();

  const subscription = await getPushSubscription(admin.id);
  if (!subscription) {
    return {
      ok: false,
      error: "No push subscription on your account — turn on push alerts in Settings first.",
    };
  }

  const failStatus = await sendPushFromWeb(subscription, {
    title: "Signaller test alert",
    body: "If you can see this, push notifications are working.",
    url: "/settings",
    tag: "signaller-test-alert",
  });

  if (failStatus === 404 || failStatus === 410) {
    return {
      ok: false,
      error: "Your saved subscription has expired. Turn push alerts off and on again in Settings.",
    };
  }
  if (failStatus !== null) {
    return { ok: false, error: `Push service rejected the send (HTTP ${failStatus}).` };
  }
  return { ok: true };
}

export async function setUserRoleAction(userId: string, role: "user" | "admin"): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (userId === admin.id) {
    return { ok: false, error: "You can't change your own role" };
  }
  try {
    await setUserRole(userId, role);
  } catch {
    return { ok: false, error: "Could not update role" };
  }
  revalidatePath("/admin/users");
  return { ok: true };
}
