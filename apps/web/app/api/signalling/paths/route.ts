import type { Feature, FeatureCollection, MultiLineString } from "geojson";
import { NextResponse } from "next/server";
import { parseBboxParam } from "@/lib/api-bbox";
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
  const parsed = parseBboxParam(url.searchParams.get("bbox"), { maxAreaDeg2: 4 });
  if (!parsed.ok) return parsed.response;

  try {
    const paths = await getRecentPathsInBbox(parsed.bbox);
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
