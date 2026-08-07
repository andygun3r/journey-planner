import { NextRequest, NextResponse } from "next/server";
import { enrichJourneyLive } from "@/lib/journey-live";
import { planMultiModal } from "@/lib/journeys";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const when = params.get("when") ?? undefined;

  const outcome = await planMultiModal(from, to, when);
  if (!outcome.ok) {
    const status = outcome.reason === "bad-request" ? 400 : outcome.reason === "engine-offline" ? 503 : 200;
    return NextResponse.json(outcome, { status });
  }
  // Only "now" plans (backup-route lookups) carry a live board to match
  // against — a future-dated plan has nothing running yet to enrich.
  const journeys = when
    ? outcome.journeys
    : await Promise.all(outcome.journeys.map(enrichJourneyLive));
  return NextResponse.json({ ...outcome, journeys });
}
