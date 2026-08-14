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
 * The merge itself lives in packages/shared/src/map-style.ts; this file is only
 * the web-side fetch and typing.
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

/** Bare basemap, no rail overlay — used when the ORM tile server (self-hosted,
 * `NEXT_PUBLIC_TILES_URL`) can't be reached. Keeps the map usable for
 * planning/search even though signalling/rail-line detail is missing. */
async function fetchRailStyle(): Promise<MapStyle | null> {
  try {
    const res = await fetch(STYLE_URL);
    if (!res.ok) throw new Error(`rail style ${res.status}`);
    return absolutizeStyle((await res.json()) as MapStyle, TILES_URL);
  } catch (err) {
    console.error(`Rail map style unavailable at ${STYLE_URL}; showing basemap only.`, err);
    return null;
  }
}

export async function loadAbsoluteStyle(): Promise<maplibregl.StyleSpecification> {
  const [rail, basemap] = await Promise.all([fetchRailStyle(), fetchBasemap()]);
  if (!rail) return basemap as unknown as maplibregl.StyleSpecification;
  return compositeStyle(rail, basemap) as unknown as maplibregl.StyleSpecification;
}
