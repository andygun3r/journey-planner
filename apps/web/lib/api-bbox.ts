import { NextResponse } from "next/server";

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export type BboxResult = { ok: true; bbox: Bbox } | { ok: false; response: NextResponse };

export function parseBboxParam(
  value: string | null,
  opts: { maxAreaDeg2: number },
): BboxResult {
  if (!value) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "bbox required: minLon,minLat,maxLon,maxLat" },
        { status: 400 },
      ),
    };
  }

  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "bbox must be minLon,minLat,maxLon,maxLat" },
        { status: 400 },
      ),
    };
  }

  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
  if (
    minLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    maxLat > 90 ||
    minLon >= maxLon ||
    minLat >= maxLat
  ) {
    return {
      ok: false,
      response: NextResponse.json({ error: "bbox is out of range" }, { status: 400 }),
    };
  }

  const area = (maxLon - minLon) * (maxLat - minLat);
  if (area > opts.maxAreaDeg2) {
    return {
      ok: false,
      response: NextResponse.json({ error: "bbox is too large" }, { status: 413 }),
    };
  }

  return { ok: true, bbox: { minLon, minLat, maxLon, maxLat } };
}
