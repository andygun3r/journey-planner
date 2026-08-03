import type { Feature, FeatureCollection, Point } from "geojson";
import { NextResponse } from "next/server";
import { getBerthsInBbox } from "@/lib/signalling";

export const dynamic = "force-dynamic";

/**
 * Berths within a map viewport, for the national signalling layer's berth
 * boxes. Same bbox-scoped, plain-polling design as /api/signalling/national —
 * see that route's docstring for the reasoning.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const bboxParam = url.searchParams.get("bbox");
  if (!bboxParam) {
    return NextResponse.json({ error: "bbox required: minLon,minLat,maxLon,maxLat" }, { status: 400 });
  }
  const parts = bboxParam.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ error: "bbox must be minLon,minLat,maxLon,maxLat" }, { status: 400 });
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];

  try {
    const berths = await getBerthsInBbox({ minLon, minLat, maxLon, maxLat });
    const features: Feature<Point>[] = berths.map((b) => ({
      type: "Feature",
      properties: {
        id: b.id,
        tdArea: b.tdArea,
        berth: b.berth,
        place: b.place,
        headcode: b.headcode,
        blockedAhead: b.blockedAhead,
      },
      geometry: { type: "Point", coordinates: [b.lon, b.lat] },
    }));
    const collection: FeatureCollection<Point> = { type: "FeatureCollection", features };
    return NextResponse.json(collection, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "signalling data unavailable" }, { status: 503 });
  }
}
