import { NextRequest, NextResponse } from "next/server";
import { createEngine, gtfsTripIdFromEngine } from "@signaller/routing-adapter";
import { londonWallTimeToIso, normaliseCrs, operatorFromRouteName } from "@signaller/shared";

export const dynamic = "force-dynamic";

/** One pickable train for a single commute leg (origin → destination, no changes). */
export interface LegOption {
  /** Bare GTFS trip id — joins to trip_mapping, ready for /api/commute/resolve-pin. */
  gtfsTripId: string;
  originCrs: string;
  originName: string;
  destCrs: string;
  destName: string;
  /** ISO instants. */
  departs: string;
  arrives: string;
  /** HH:MM UK local, for display and for storing on the pin. */
  departsHhmm: string;
  arrivesHhmm: string;
  durationMinutes: number;
  operator?: string;
  callCount: number;
}

const hhmmFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const hhmm = (iso: string) => hhmmFmt.format(new Date(iso));

/**
 * Trains that actually run one leg of a commute, origin → destination.
 *
 * Uses the routing engine's plan() rather than a departure board: a board
 * lists everything leaving a station, with no idea whether a given train calls
 * at the leg's destination and no arrival time there — which is exactly what
 * you need to see when picking a leg and judging its connection. plan() answers
 * origin → destination directly, and carries the GTFS trip id each pin needs.
 *
 * Only DIRECT options are returned (a single rail leg): the user has already
 * declared where they change, so each leg is by definition one train. Anything
 * the engine returns with a connection belongs to a different leg structure.
 */
export async function GET(req: NextRequest) {
  const fromParam = req.nextUrl.searchParams.get("from");
  const toParam = req.nextUrl.searchParams.get("to");
  const date = req.nextUrl.searchParams.get("date");
  const around = req.nextUrl.searchParams.get("around");

  if (!fromParam || !toParam || !date || !around) {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  let from: string;
  let to: string;
  try {
    from = normaliseCrs(fromParam);
    to = normaliseCrs(toParam);
  } catch {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }
  if (from === to) {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }

  // Start the search a little before the requested time so the option just
  // before it is offered too — picking a commute train is as often "the one
  // before" as "the one after".
  const anchorMs = Date.parse(londonWallTimeToIso(date, around));
  if (Number.isNaN(anchorMs)) {
    return NextResponse.json({ ok: false, reason: "bad-request" }, { status: 400 });
  }
  const when = new Date(anchorMs - 15 * 60_000).toISOString();

  let itineraries;
  try {
    const engine = createEngine();
    itineraries = await engine.plan({ from, to, when, numItineraries: 10 });
  } catch {
    return NextResponse.json({ ok: false, reason: "engine-offline" }, { status: 503 });
  }

  const seen = new Set<string>();
  const options: LegOption[] = [];
  for (const it of itineraries) {
    const rail = it.legs.filter((l) => l.mode === "rail");
    // Direct trains only — one rail leg, and it must run the full leg.
    if (rail.length !== 1) continue;
    const leg = rail[0]!;
    if (!leg.tripId || leg.cancelled) continue;
    if (leg.origin.stopId !== from || leg.destination.stopId !== to) continue;

    const gtfsTripId = gtfsTripIdFromEngine(leg.tripId);
    if (seen.has(gtfsTripId)) continue;
    seen.add(gtfsTripId);

    const departs = leg.origin.scheduled;
    const arrives = leg.destination.scheduled;
    const durationMinutes = Math.round((Date.parse(arrives) - Date.parse(departs)) / 60_000);

    options.push({
      gtfsTripId,
      originCrs: leg.origin.stopId,
      originName: leg.origin.name,
      destCrs: leg.destination.stopId,
      destName: leg.destination.name,
      departs,
      arrives,
      departsHhmm: hhmm(departs),
      arrivesHhmm: hhmm(arrives),
      durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 0,
      operator: operatorFromRouteName(leg.routeName),
      callCount: leg.intermediateCalls.length,
    });
  }

  options.sort((a, b) => Date.parse(a.departs) - Date.parse(b.departs));
  return NextResponse.json({ ok: true, options });
}
