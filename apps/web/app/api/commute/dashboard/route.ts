import { NextRequest, NextResponse } from "next/server";
import { getDashboardData } from "@/lib/commute-dashboard";
import { getUserId } from "@/lib/current-user";

export const dynamic = "force-dynamic";

/**
 * The commute dashboard as JSON.
 *
 * The web renders this in a server component, so there was no HTTP contract
 * for it. Returns the same `DashboardState` union the page consumes — the
 * `kind` field tells the client which shape it got.
 */
export async function GET(req: NextRequest) {
  const userId = await getUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const commuteId = params.get("commute") ?? undefined;

  // The dashboard's "leave a bit earlier/later" control.
  const rawShift = Number(params.get("shift") ?? 0);
  const shiftMinutes = Number.isFinite(rawShift) ? Math.trunc(rawShift) : 0;

  const state = await getDashboardData(userId, new Date(), commuteId, shiftMinutes);
  return NextResponse.json(
    { ok: true, state },
    // Live running data — never cache it.
    { headers: { "Cache-Control": "no-store" } },
  );
}
