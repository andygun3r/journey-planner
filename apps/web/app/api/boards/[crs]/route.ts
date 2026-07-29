import { NextRequest, NextResponse } from "next/server";
import { getBoard } from "@/lib/board";
import { startTimer } from "@/lib/timing";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ crs: string }> },
) {
  const { crs } = await params;
  const when = req.nextUrl.searchParams.get("when") ?? undefined;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "20");
  const callingAt = req.nextUrl.searchParams.get("callingAt") ?? undefined;

  // This is the app's busiest route. Server-Timing shows up in browser dev
  // tools, so "the board is slow" becomes a number instead of a feeling.
  const timer = startTimer();
  const outcome = await getBoard(
    crs,
    when,
    Number.isFinite(limit) ? limit : 20,
    callingAt,
    timer,
  );

  const timing = timer.header();
  if (!outcome.ok) {
    const status =
      outcome.reason === "bad-request" || outcome.reason === "unknown-station"
        ? 400
        : 503;
    return NextResponse.json(outcome, {
      status,
      headers: timing ? { "Server-Timing": timing } : undefined,
    });
  }
  // Live board data goes stale fast; allow a short shared cache only.
  return NextResponse.json(outcome, {
    headers: {
      "Cache-Control": "public, max-age=15",
      ...(timing ? { "Server-Timing": timing } : {}),
    },
  });
}
