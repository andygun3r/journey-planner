import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/current-user";
import { clearPushSubscription, savePushSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Register (or replace) the signed-in user's Web Push subscription. */
export async function POST(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const sub = (body as { subscription?: unknown })?.subscription;
  if (!sub || typeof sub !== "object") {
    return NextResponse.json({ ok: false, error: "Missing subscription" }, { status: 400 });
  }
  await savePushSubscription(userId, sub);
  return NextResponse.json({ ok: true });
}

/** Unsubscribe the signed-in user. */
export async function DELETE() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await clearPushSubscription(userId);
  return NextResponse.json({ ok: true });
}
