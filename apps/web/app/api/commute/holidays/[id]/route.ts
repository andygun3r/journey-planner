import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/current-user";
import { deleteHoliday } from "@/lib/holidays";
import { isUuid } from "@/lib/route-params";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const deleted = await deleteHoliday(userId, id);
  if (!deleted) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
