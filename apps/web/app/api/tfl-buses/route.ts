import { NextRequest, NextResponse } from "next/server";
import { parseBboxParam } from "@/lib/api-bbox";
import { getApproxBuses } from "@/lib/tfl-buses";
import { tflConfigured } from "@/lib/tfl";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!tflConfigured()) {
    return NextResponse.json(
      { generatedAt: new Date().toISOString(), buses: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const params = req.nextUrl.searchParams;
  const bbox = [
    params.get("minLon"),
    params.get("minLat"),
    params.get("maxLon"),
    params.get("maxLat"),
  ].join(",");
  const parsed = parseBboxParam(bbox.includes("null") ? null : bbox, { maxAreaDeg2: 0.5 });
  if (!parsed.ok) return parsed.response;
  const { minLat, maxLat, minLon, maxLon } = parsed.bbox;

  try {
    const buses = await getApproxBuses({ minLat, maxLat, minLon, maxLon });
    return NextResponse.json(
      { generatedAt: new Date().toISOString(), buses },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { generatedAt: new Date().toISOString(), buses: [] },
      { status: 503 },
    );
  }
}
