import { NextResponse } from "next/server";
import { markSeen } from "@/lib/alerts";
import { requireDevice } from "@/lib/device";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deviceId = await requireDevice();
  await markSeen(deviceId, id);
  return NextResponse.json({ ok: true });
}
