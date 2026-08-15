import { NextResponse } from "next/server";
import { deleteAccount } from "@/lib/account";
import { getUserId } from "@/lib/current-user";

export const dynamic = "force-dynamic";

/**
 * Permanently deletes the signed-in user's account.
 *
 * Irreversible, and there's no confirmation step here — the client is expected
 * to have asked. The web equivalent (`deleteAccountAction`) redirects to
 * /login; this returns JSON and leaves the app to clear its stored token.
 */
export async function DELETE() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  await deleteAccount(userId);
  return NextResponse.json({ ok: true });
}
