import { NextRequest, NextResponse } from "next/server";
import { gtfsTripIdFromEngine } from "@signaller/routing-adapter";
import { londonDate, londonWallTimeToIso } from "@signaller/shared";
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
 *
 * `date` (YYYY-MM-DD) picks which day's timetable to search — a commute leg
 * is day-of-week recurring, so this lets the picker search e.g. "next
 * Wednesday" rather than only ever today. Passing a non-today date always
 * routes getBoard() to its MOTIS/GTFS-timetable path (the live LDBWS/Darwin
 * board only ever knows "now") — that's the intended, proven path (see
 * board.ts: LDBWS is skipped whenever a `when` is supplied).
 *
 * `around` (HH:MM) + `windowMinutes` bound the search loosely — by default
 * -30/+90 minutes either side of the leg's window start (or the previous
 * pinned leg's arrival), so the user can browse nearby options rather than
 * only exact-or-later matches.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ crs: string }> }) {
  const { crs } = await params;
  const date = req.nextUrl.searchParams.get("date") || londonDate();
  const around = req.nextUrl.searchParams.get("around") ?? undefined;
  const beforeMinutes = Number(req.nextUrl.searchParams.get("beforeMinutes") ?? "30");
  const afterMinutes = Number(req.nextUrl.searchParams.get("afterMinutes") ?? "90");

  const today = londonDate();
  // Only pass `when` to getBoard() when it's needed to pick a different day —
  // today's default (no `when`) keeps the live LDBWS/Darwin board as the
  // primary source, matching every other board on the site.
  const when = date === today ? undefined : londonWallTimeToIso(date, "00:00");

  const outcome = await cachedBoard(crs, when, 40);
  if (!outcome.ok) {
    const status = outcome.reason === "bad-request" || outcome.reason === "unknown-station" ? 400 : 503;
    return NextResponse.json(outcome, { status });
  }

  let windowStartMs: number | undefined;
  let windowEndMs: number | undefined;
  if (around) {
    const anchor = Date.parse(londonWallTimeToIso(date, around));
    if (!Number.isNaN(anchor)) {
      windowStartMs = anchor - Math.max(beforeMinutes, 0) * 60_000;
      windowEndMs = anchor + Math.max(afterMinutes, 0) * 60_000;
    }
  }

  const candidates: PinCandidate[] = outcome.board.departures
    .filter((d) => d.status !== "cancelled")
    .filter((d) => {
      if (windowStartMs === undefined || windowEndMs === undefined) return true;
      const ms = Date.parse(d.scheduled);
      return ms >= windowStartMs && ms <= windowEndMs;
    })
    .map((d) => ({
      crs: outcome.board.crs,
      name: outcome.board.stationName,
      scheduled: d.scheduled,
      destinationName: d.destinationName,
      destinationCrs: d.destinationCrs,
      operator: d.operator,
      // On the MOTIS-fallback path (source !== "ldbws"), tripId is the
      // engine's composite id (date_time_dataset_tag_<gtfsTripId>) — strip it
      // to the bare GTFS trip id trip_mapping actually stores, exactly as
      // precompute.ts does before every trip_mapping lookup. On the LDBWS
      // path tripId is an opaque Darwin serviceID and must NOT be touched.
      tripId: d.tripId && outcome.board.source !== "ldbws" ? gtfsTripIdFromEngine(d.tripId) : d.tripId,
      rid: d.rid,
      source: outcome.board.source,
    }))
    .sort((a, b) => Date.parse(a.scheduled) - Date.parse(b.scheduled));

  return NextResponse.json({ ok: true, candidates });
}
