import { NextRequest, NextResponse } from "next/server";
import { arrivals, tflConfigured } from "@/lib/tfl";

export const dynamic = "force-dynamic";

/** Next departures for one TfL stop — powers the map's "click a bus stop" panel. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ naptanId: string }> },
) {
  const { naptanId } = await params;
  if (!tflConfigured()) {
    return NextResponse.json({ arrivals: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const predictions = await arrivals(naptanId);
    return NextResponse.json(
      { arrivals: predictions },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ arrivals: [] }, { status: 503 });
  }
}
