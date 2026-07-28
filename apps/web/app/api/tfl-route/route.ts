import { NextRequest, NextResponse } from "next/server";
import { lineRouteSequence, tflConfigured } from "@/lib/tfl";

export const dynamic = "force-dynamic";

/** Route polyline + stop list for one bus line/direction — the map's "show this bus's route" panel. */
export async function GET(req: NextRequest) {
  if (!tflConfigured()) {
    return NextResponse.json({ route: null }, { headers: { "Cache-Control": "no-store" } });
  }
  const lineId = req.nextUrl.searchParams.get("lineId");
  const direction = req.nextUrl.searchParams.get("direction");
  if (!lineId || !direction) {
    return NextResponse.json({ error: "lineId and direction required" }, { status: 400 });
  }

  try {
    const route = await lineRouteSequence(lineId, direction);
    return NextResponse.json(
      { route },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
  } catch {
    return NextResponse.json({ route: null }, { status: 503 });
  }
}
