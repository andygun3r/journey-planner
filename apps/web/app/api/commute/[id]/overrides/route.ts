import { NextRequest, NextResponse } from "next/server";
import {
  listOverrides,
  type OverrideInput,
  saveOverride,
  saveOverrideForFutureWeekdays,
} from "@/lib/commute-overrides";
import { getUserId } from "@/lib/current-user";
import { isIsoDate, isUuid } from "@/lib/route-params";

export const dynamic = "force-dynamic";

/** Per-date changes to a commute: a day off, a different workplace, new times. */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: "from and to must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  // Returns [] for a commute this user doesn't own — the ownership check is
  // inside listOverrides.
  const overrides = await listOverrides(userId, id, from, to);
  return NextResponse.json({ ok: true, overrides });
}

/**
 * Save an override for one date, or for every future occurrence of that
 * weekday — the calendar's this-day/all-future choice.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { date?: string; scope?: string; input?: OverrideInput };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  if (!isIsoDate(body.date)) {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: "date must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  const scope = body.scope ?? "date";
  if (scope !== "date" && scope !== "future") {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: "scope must be date or future" },
      { status: 400 },
    );
  }

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });

  const input = body.input ?? {};

  // Both writers ownership-check internally and report failure by returning
  // false / 0 rather than throwing.
  const ok =
    scope === "future"
      ? (await saveOverrideForFutureWeekdays(userId, id, body.date, input)) > 0
      : await saveOverride(userId, id, body.date, input);

  if (!ok) return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
