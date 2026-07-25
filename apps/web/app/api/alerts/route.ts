import { NextRequest, NextResponse } from "next/server";
import { listAlerts, markSeen } from "@/lib/alerts";
import { requireDevice } from "@/lib/device";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const deviceId = await requireDevice();
  const unseenOnly = req.nextUrl.searchParams.get("unseen") === "1";
  const alerts = await listAlerts(deviceId, { unseenOnly });
  return NextResponse.json({ alerts });
}

/** Mark all of the device's alerts seen. */
export async function PATCH() {
  const deviceId = await requireDevice();
  await markSeen(deviceId);
  return NextResponse.json({ ok: true });
}
