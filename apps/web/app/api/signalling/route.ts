import { NextResponse } from "next/server";
import { getDiagramForTrain } from "@/lib/signalling";

export const dynamic = "force-dynamic";

/**
 * Corridor signalling diagram for a train. Query by ?trainId= or ?rid= (the
 * train whose TD areas define the corridor), or ?area= directly. Polled by the
 * diagram, so signalling changes show quickly.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const trainId = url.searchParams.get("trainId") ?? undefined;
  const rid = url.searchParams.get("rid") ?? undefined;
  const area = url.searchParams.get("area") ?? undefined;

  if (!trainId && !rid && !area) {
    return NextResponse.json({ error: "trainId, rid or area required" }, { status: 400 });
  }

  try {
    const diagram = await getDiagramForTrain({ trainId, rid, area });
    return NextResponse.json(diagram, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "diagram unavailable" }, { status: 503 });
  }
}
