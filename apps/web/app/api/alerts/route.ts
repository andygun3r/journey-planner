import { NextRequest, NextResponse } from "next/server";
import { listAlerts, markSeen } from "@/lib/alerts";
import { getUserId } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const unseenOnly = req.nextUrl.searchParams.get("unseen") === "1";
  const alerts = await listAlerts(userId, { unseenOnly });
  return NextResponse.json({ alerts });
}

/** Mark all of the signed-in user's alerts seen. */
export async function PATCH() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await markSeen(userId);
  return NextResponse.json({ ok: true });
}
