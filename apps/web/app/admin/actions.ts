"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/require-admin";
import { setUserRole } from "@/lib/admin-users";

export type ActionResult = { ok: true } | { ok: false; error: string };

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
