import { NextResponse } from "next/server";
import { markSeen } from "@/lib/alerts";
import { getUserId } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await markSeen(userId, id);
  return NextResponse.json({ ok: true });
}
