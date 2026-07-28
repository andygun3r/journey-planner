import { NextRequest, NextResponse } from "next/server";
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
  return NextResponse.json(outcome);
}
