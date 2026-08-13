"use client";

import {
  BASEMAP_STYLE_URL,
  absolutizeStyle,
  compositeStyle,
  groundOnlyBasemap,
  type MapStyle,
} from "@signaller/shared";
import type maplibregl from "maplibre-gl";

/**
 * Loads the self-hosted OpenRailwayMap-vector style (see the
 * orm-db/orm-import/orm-martin/orm-proxy Coolify apps) composited over the
 * OpenFreeMap vector basemap. Used by both the full live map (/map) and the
 * service-detail position map, so every map in the app shares one cartography.
 *
 * The merge itself lives in packages/shared/src/map-style.ts, shared with
 * apps/mobile — this file is only the web-side fetch and typing.
 */

// An empty NEXT_PUBLIC_TILES_URL must not silently degrade to "": that turns
// every absolutize() call into a no-op, leaving the style's server-relative
// paths pointing at the page origin, where they all 404. Treat blank as unset.
export const TILES_URL =
  (process.env.NEXT_PUBLIC_TILES_URL || "").replace(/\/$/, "") || "http://localhost:8081";
const STYLE_URL = `${TILES_URL}/style/standard.json`;

/** Retained for callers that reference the basemap source by name. */
export const BASEMAP_SOURCE = "basemap-openmaptiles";

async function fetchBasemap(): Promise<MapStyle> {
  try {
    const res = await fetch(BASEMAP_STYLE_URL);
    if (!res.ok) throw new Error(`basemap style ${res.status}`);
    return (await res.json()) as MapStyle;
  } catch {
    // A missing basemap must not take the rail map down with it — rail lines
    // on a plain Platform White ground still work.
    return groundOnlyBasemap();
  }
}

export async function loadAbsoluteStyle(): Promise<maplibregl.StyleSpecification> {
  const [railRes, basemap] = await Promise.all([fetch(STYLE_URL), fetchBasemap()]);
  const rail = absolutizeStyle((await railRes.json()) as MapStyle, TILES_URL);
  return compositeStyle(rail, basemap) as unknown as maplibregl.StyleSpecification;
}
