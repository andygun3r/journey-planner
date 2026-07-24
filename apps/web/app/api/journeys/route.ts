import { NextRequest, NextResponse } from "next/server";
import { planJourneys } from "@/lib/journeys";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const when = params.get("when") ?? undefined;

  const outcome = await planJourneys(from, to, when);
  if (!outcome.ok) {
    const status = outcome.reason === "bad-request" ? 400 : outcome.reason === "engine-offline" ? 503 : 200;
    return NextResponse.json(outcome, { status });
  }
  return NextResponse.json(outcome);
}
