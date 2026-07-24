import { NextRequest, NextResponse } from "next/server";
import { getBoard } from "@/lib/board";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ crs: string }> },
) {
  const { crs } = await params;
  const when = req.nextUrl.searchParams.get("when") ?? undefined;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "20");
  const callingAt = req.nextUrl.searchParams.get("callingAt") ?? undefined;

  const outcome = await getBoard(crs, when, Number.isFinite(limit) ? limit : 20, callingAt);
  if (!outcome.ok) {
    const status =
      outcome.reason === "bad-request" || outcome.reason === "unknown-station"
        ? 400
        : 503;
    return NextResponse.json(outcome, { status });
  }
  // Live board data goes stale fast; allow a short shared cache only.
  return NextResponse.json(outcome, {
    headers: { "Cache-Control": "public, max-age=15" },
  });
}
