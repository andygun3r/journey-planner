import { NextRequest, NextResponse } from "next/server";
import { TFL_MODES } from "@signaller/shared";
import { getMapStops } from "@/lib/tfl-stops";
import { tflConfigured } from "@/lib/tfl";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!tflConfigured()) {
    return NextResponse.json({ stops: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const modesParam = req.nextUrl.searchParams.get("modes");
  const modes = modesParam
    ? modesParam.split(",").filter((m): m is (typeof TFL_MODES)[number] =>
        (TFL_MODES as readonly string[]).includes(m),
      )
    : [...TFL_MODES];

  try {
    const stops = await getMapStops(modes);
    return NextResponse.json(
      { stops },
      // Static backdrop, refreshed weekly server-side — safe to cache in the browser for a while.
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch {
    return NextResponse.json({ stops: [] }, { status: 503 });
  }
}
