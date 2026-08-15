import { NextRequest, NextResponse } from "next/server";
import { indicativeFare } from "@/lib/fares";

export const dynamic = "force-dynamic";

/**
 * Indicative cheapest fare between two stations.
 *
 * Public, like the other timetable-derived routes — fares are reference data,
 * not user data. Rendered server-side on /journeys, so this exists purely to
 * give the native app the same figures.
 *
 * Indicative is the operative word: cheapest standard single/return from the
 * DTD RJFAF feed, honouring station clusters. No railcards, no routeing guide.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const from = params.get("from")?.trim().toUpperCase();
  const to = params.get("to")?.trim().toUpperCase();

  if (!from || !to || from.length !== 3 || to.length !== 3) {
    return NextResponse.json(
      { ok: false, reason: "bad-request", error: "from and to must be CRS codes" },
      { status: 400 },
    );
  }

  try {
    const fare = await indicativeFare(from, to);
    // No fare found is a legitimate answer, not an error: plenty of flows
    // simply aren't in the fares feed.
    return NextResponse.json(
      { ok: true, fare },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch {
    return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 503 });
  }
}
