import { NextRequest, NextResponse } from "next/server";
import { getApproxBuses } from "@/lib/tfl-buses";
import { tflConfigured } from "@/lib/tfl";

export const dynamic = "force-dynamic";

function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: NextRequest) {
  if (!tflConfigured()) {
    return NextResponse.json(
      { generatedAt: new Date().toISOString(), buses: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const params = req.nextUrl.searchParams;
  const minLat = num(params.get("minLat"));
  const maxLat = num(params.get("maxLat"));
  const minLon = num(params.get("minLon"));
  const maxLon = num(params.get("maxLon"));
  if (minLat === undefined || maxLat === undefined || minLon === undefined || maxLon === undefined) {
    return NextResponse.json({ error: "minLat/maxLat/minLon/maxLon required" }, { status: 400 });
  }

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
