import { HolidayInput } from "@signaller/shared";
import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/current-user";
import { createHoliday, listHolidays } from "@/lib/holidays";

export const dynamic = "force-dynamic";

/** Date ranges where commute alerts are paused. */

export async function GET() {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const holidays = await listHolidays(userId);
  return NextResponse.json({ ok: true, holidays });
}

export async function POST(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  const parsed = HolidayInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }

  const id = await createHoliday(userId, parsed.data);
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
