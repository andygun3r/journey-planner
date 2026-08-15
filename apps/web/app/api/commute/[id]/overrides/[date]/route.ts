import { NextRequest, NextResponse } from "next/server";
import { clearOverride } from "@/lib/commute-overrides";
import { getUserId } from "@/lib/current-user";
import { isIsoDate, isUuid } from "@/lib/route-params";

export const dynamic = "force-dynamic";

/** Drops an override so the date follows the weekly template again. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; date: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id, date } = await params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  if (!isIsoDate(date)) {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: "date must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  await clearOverride(userId, id, date);
  return NextResponse.json({ ok: true });
}
