import { NextRequest, NextResponse } from "next/server";
import { cachedBoard } from "@/lib/board-cache";

export const dynamic = "force-dynamic";

/** One row the commute leg picker can add, shaped to just what it needs. */
export interface PinCandidate {
  crs: string;
  name: string;
  scheduled: string; // ISO instant
  destinationName: string;
  destinationCrs?: string;
  operator?: string;
  tripId?: string;
  rid?: string;
  source: "ldbws" | "darwin" | "timetable";
}

/**
 * Board search for the commute leg picker (apps/web/components/pinned-leg-picker.tsx).
 * Thin wrapper over getBoard()/cachedBoard() — deliberately does NOT resolve a
 * train_uid here (that's expensive: a couple of extra queries per row) since
 * only one row of a ~20-row board will ever actually get picked. Resolution
 * happens once, lazily, only for the row the user clicks — see
 * /api/commute/resolve-pin.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ crs: string }> }) {
  const { crs } = await params;
  const when = req.nextUrl.searchParams.get("when") ?? undefined;
  // The previous leg's arrival (or the direction's window start for the first
  // leg) — rows departing before this aren't offered, since they can't be
  // caught after the leg before them.
  const after = req.nextUrl.searchParams.get("after") ?? undefined;

  const outcome = await cachedBoard(crs, when, 20);
  if (!outcome.ok) {
    const status = outcome.reason === "bad-request" || outcome.reason === "unknown-station" ? 400 : 503;
    return NextResponse.json(outcome, { status });
  }

  const afterMs = after ? Date.parse(after) : undefined;
  const candidates: PinCandidate[] = outcome.board.departures
    .filter((d) => d.status !== "cancelled")
    .filter((d) => (afterMs === undefined ? true : Date.parse(d.scheduled) >= afterMs))
    .map((d) => ({
      crs: outcome.board.crs,
      name: outcome.board.stationName,
      scheduled: d.scheduled,
      destinationName: d.destinationName,
      destinationCrs: d.destinationCrs,
      operator: d.operator,
      tripId: d.tripId,
      rid: d.rid,
      source: outcome.board.source,
    }));

  return NextResponse.json({ ok: true, candidates });
}
