import { NextResponse } from "next/server";
import { getDiagramForTrain } from "@/lib/signalling";

export const dynamic = "force-dynamic";

/**
 * Corridor signalling diagram for a station or a train. Query by ?crs= (every
 * TD area signalling that station), ?trainId=/?rid= (the train whose TD areas
 * define the corridor), ?area= directly, or ?corridor=swml for a named line
 * corridor. Polled by the diagram, so
 * signalling changes show quickly.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const trainId = url.searchParams.get("trainId") ?? undefined;
  const rid = url.searchParams.get("rid") ?? undefined;
  const area = url.searchParams.get("area") ?? undefined;
  const crs = url.searchParams.get("crs") ?? undefined;
  const corridor = url.searchParams.get("corridor") ?? undefined;

  if (!trainId && !rid && !area && !crs && !corridor) {
    return NextResponse.json(
      { error: "trainId, rid, area, crs or corridor required" },
      { status: 400 },
    );
  }

  try {
    const diagram = await getDiagramForTrain({ trainId, rid, area, crs, corridor });
    return NextResponse.json(diagram, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "diagram unavailable" }, { status: 503 });
  }
}
