import type { StyleSpecification } from "@maplibre/maplibre-react-native";

/**
 * Native port of apps/web/lib/orm-style.ts. Same OpenRailwayMap-vector style
 * + CARTO light basemap composite, same absolutize-relative-URLs logic — but
 * points straight at the hosted openrailwaymap.app instance rather than
 * through apps/web's /api/map-tiles proxy.
 *
 * The web proxy exists for two browser-only constraints (see
 * apps/web/app/api/map-tiles/[...path]/route.ts): no CORS headers on
 * openrailwaymap.app's responses, and a Referer/User-Agent check. Neither
 * applies to a native HTTP client — RN is not subject to CORS, and headers
 * are freely set on any request — so this fetches the style directly and
 * sets the same Referer/User-Agent the proxy already sends upstream.
 */

const UPSTREAM = "https://openrailwaymap.app";
const STYLE_URL = `${UPSTREAM}/style/standard.json`;
const UPSTREAM_HEADERS = {
  // apps/web's proxy sends req.nextUrl.origin (the deployed web app's own
  // domain) as Referer — there's no single equivalent for a native client.
  // TODO: once the production web domain is fixed, set Referer to that
  // (openrailwaymap.app's usage policy wants a Referer identifying "a real
  // application", not necessarily the exact caller's own origin).
  Referer: "https://github.com/andygun3r/journey-planner",
  "User-Agent": "Signaller (https://github.com/andygun3r/journey-planner)",
};

function absolutize(path: string): string {
  return path.startsWith("/") ? `${UPSTREAM}${path}` : path;
}

export const BASEMAP_SOURCE = "carto-basemap";
const BASEMAP_LAYER = "carto-basemap-layer";

// Light only — see DESIGN.md, no dark theme to branch on.
export function basemapTileUrl(): string {
  return "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png";
}

function withBasemap(style: StyleSpecification): StyleSpecification {
  return {
    ...style,
    sources: {
      ...style.sources,
      [BASEMAP_SOURCE]: {
        type: "raster",
        tiles: [basemapTileUrl()],
        tileSize: 256,
        maxzoom: 20,
        attribution:
          '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: [{ id: BASEMAP_LAYER, type: "raster", source: BASEMAP_SOURCE }, ...style.layers],
  };
}

export async function loadAbsoluteStyle(): Promise<StyleSpecification> {
  const res = await fetch(STYLE_URL, { headers: UPSTREAM_HEADERS });
  const style = (await res.json()) as StyleSpecification;

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

  return withBasemap(style);
}
