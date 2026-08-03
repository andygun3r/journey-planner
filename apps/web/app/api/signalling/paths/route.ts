import type { Feature, FeatureCollection, MultiLineString } from "geojson";
import { NextResponse } from "next/server";
import { getRecentPathsInBbox } from "@/lib/signalling";

export const dynamic = "force-dynamic";

/**
 * Recent train paths within a map viewport, derived from TD berth-step
 * history — no SOP data involved (see getRecentPathsInBbox's docstring). Same
 * bbox-scoped, plain-polling design as the other national signalling routes.
 *
 * One feature per train, geometry MultiLineString: a train's path is broken
 * into segments wherever two consecutive anchored points weren't an actual
 * adjacent step in the berth graph (see getRecentPathsInBbox), so it never
 * draws a straight line across the map between unrelated locations.
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
    const paths = await getRecentPathsInBbox({ minLon, minLat, maxLon, maxLat });
    const features: Feature<MultiLineString>[] = paths.map((p) => ({
      type: "Feature",
      properties: { trainId: p.trainId, headcode: p.headcode },
      geometry: {
        type: "MultiLineString",
        coordinates: p.segments.map((seg) => seg.map((pt) => [pt.lon, pt.lat])),
      },
    }));
    const collection: FeatureCollection<MultiLineString> = { type: "FeatureCollection", features };
    return NextResponse.json(collection, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "signalling data unavailable" }, { status: 503 });
  }
}
