import { NextRequest, NextResponse } from "next/server";
import { requireDevice } from "@/lib/device";
import { clearPushSubscription, savePushSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Register (or replace) this device's Web Push subscription. */
export async function POST(req: NextRequest) {
  const deviceId = await requireDevice();
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
  await savePushSubscription(deviceId, sub);
  return NextResponse.json({ ok: true });
}

/** Unsubscribe this device. */
export async function DELETE() {
  const deviceId = await requireDevice();
  await clearPushSubscription(deviceId);
  return NextResponse.json({ ok: true });
}
