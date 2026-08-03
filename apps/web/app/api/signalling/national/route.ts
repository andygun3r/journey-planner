import type { Feature, FeatureCollection, Point } from "geojson";
import { NextResponse } from "next/server";
import { getSignalMarkersInBbox } from "@/lib/signalling";

export const dynamic = "force-dynamic";

/**
 * Signal markers within a map viewport, for the national signalling layer.
 *
 * Bbox-scoped rather than one giant national blob: national signal-state is
 * a lot more data than one corridor, so this bounds payload to "what's on
 * screen" the same way the existing per-corridor lookups are per-train/
 * per-station rather than per-network. Plain polling (not SSE, unlike the
 * per-corridor /api/live/signalling) — the map is inherently viewport-scoped
 * already via this bbox param, and per-viewport SSE filtering would add real
 * server-side state for little benefit versus a client re-fetching on pan/zoom.
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
    const markers = await getSignalMarkersInBbox({ minLon, minLat, maxLon, maxLat });
    const features: Feature<Point>[] = markers.map((m) => ({
      type: "Feature",
      properties: {
        id: m.id,
        itemId: m.itemId,
        berthAhead: m.berthAhead,
        source: m.source,
        osmId: m.osmId,
        signalDirection: m.signalDirection,
        signalPosition: m.signalPosition,
        trackBearing: m.trackBearing,
        mainForm: m.mainForm,
        signalKind: m.signalKind,
        signalTags: m.signalTags,
        aspect: m.aspect,
        routeSet: m.routeSet,
        mapped: m.mapped,
      },
      geometry: { type: "Point", coordinates: [m.lon, m.lat] },
    }));
    const collection: FeatureCollection<Point> = { type: "FeatureCollection", features };
    return NextResponse.json(collection, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "signalling data unavailable" }, { status: 503 });
  }
}
