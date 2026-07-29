"use client";

import type maplibregl from "maplibre-gl";

/**
 * Shared loader for the self-hosted OpenRailwayMap-vector style (see
 * docker-compose.yml's orm-db/import/martin/proxy services) composited over a
 * CARTO raster basemap. Used by both the full live map (/map) and the
 * service-detail position map, which replaced an SVG schematic so that every
 * map in the app is the same real rail cartography.
 */

// An empty NEXT_PUBLIC_TILES_URL must not silently degrade to "": that turns
// every absolutize() call into a no-op, leaving the style's server-relative
// paths pointing at the page origin, where they all 404. Treat blank as unset.
export const TILES_URL =
  (process.env.NEXT_PUBLIC_TILES_URL || "").replace(/\/$/, "") || "http://localhost:8081";
const STYLE_URL = `${TILES_URL}/style/standard.json`;

/**
 * The style JSON's vector source `url`s (TileJSON references, e.g.
 * "/operator_railway_symbols"), `sprite`, and `glyphs` are all plain
 * server-relative paths. MapLibre does not resolve any of these against the
 * style's own URL — passing STYLE_URL as a bare string makes it request them
 * against the PAGE's origin (localhost:3000) and 404, and calling
 * `map.setStyle()` with an object containing relative sprite/glyphs URLs
 * throws outright ("must be absolute"). Fetch the style ourselves and
 * absolutize every one of these fields against the tile server first.
 */
function absolutize(path: string): string {
  return path.startsWith("/") ? `${TILES_URL}${path}` : path;
}

/**
 * OpenRailwayMap-vector's "standard" style is a rail-only overlay: 460+
 * layers of track/signals/stations, but no background, land, water or place
 * labels — it's meant to sit over a general basemap (openrailwaymap.org
 * composites it over OSM the same way). We don't run our own basemap import
 * (see vendor/openrailwaymap-vector/SETUP.md — it only ingests railway
 * features), so this pulls CARTO's free, no-key raster tiles underneath it.
 *
 * Raster, not vector: CARTO's vector basemap ships its own sprite and glyph
 * URLs, and MapLibre allows only one sprite/glyphs pair per style — merging
 * it with OpenRailwayMap's own sprite/glyphs (which its 460+ layers reference
 * by name) would require rewriting every layer's icon/text references. A
 * raster tile source sidesteps that entirely: no sprite, no glyphs, just
 * pixels under the vector rail layers.
 */
export const BASEMAP_SOURCE = "carto-basemap";
const BASEMAP_LAYER = "carto-basemap-layer";

export function basemapTileUrl(dark: boolean): string {
  return `https://basemaps.cartocdn.com/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}.png`;
}

export function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
}

function withBasemap(
  style: maplibregl.StyleSpecification,
  dark: boolean,
): maplibregl.StyleSpecification {
  return {
    ...style,
    sources: {
      ...style.sources,
      [BASEMAP_SOURCE]: {
        type: "raster",
        tiles: [basemapTileUrl(dark)],
        tileSize: 256,
        maxzoom: 20,
        attribution:
          '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    // Prepended so every OpenRailwayMap layer draws on top of it.
    layers: [{ id: BASEMAP_LAYER, type: "raster", source: BASEMAP_SOURCE }, ...style.layers],
  };
}

export async function loadAbsoluteStyle(dark: boolean): Promise<maplibregl.StyleSpecification> {
  const res = await fetch(STYLE_URL);
  const style = (await res.json()) as maplibregl.StyleSpecification;

  for (const source of Object.values(style.sources ?? {})) {
    if ("url" in source && typeof source.url === "string") {
      source.url = absolutize(source.url);
    }
  }

  if (typeof style.sprite === "string") {
    style.sprite = absolutize(style.sprite);
  } else if (Array.isArray(style.sprite)) {
    style.sprite = style.sprite.map((s) => ({ ...s, url: absolutize(s.url) }));
  }

  if (typeof style.glyphs === "string") {
    style.glyphs = absolutize(style.glyphs);
  }

  return withBasemap(style, dark);
}
