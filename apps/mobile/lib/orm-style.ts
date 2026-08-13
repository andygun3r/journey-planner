import {
  BASEMAP_STYLE_URL,
  absolutizeStyle,
  compositeStyle,
  groundOnlyBasemap,
  type MapStyle,
} from "@signaller/shared";
import type { StyleSpecification } from "@maplibre/maplibre-react-native";

/**
 * Native counterpart to apps/web/lib/orm-style.ts. Same composite — the
 * OpenRailwayMap-vector style over the OpenFreeMap vector basemap, merged by
 * the shared packages/shared/src/map-style.ts — but pointed straight at the
 * hosted openrailwaymap.app instance rather than through apps/web's
 * /api/map-tiles proxy.
 *
 * The web proxy exists for two browser-only constraints (see
 * apps/web/app/api/map-tiles/[...path]/route.ts): no CORS headers on
 * openrailwaymap.app's responses, and a Referer/User-Agent check. Neither
 * applies to a native HTTP client — RN is not subject to CORS, and headers are
 * freely set on any request — so this fetches the style directly and sends the
 * same Referer/User-Agent the proxy already sends upstream.
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

export async function loadAbsoluteStyle(): Promise<StyleSpecification> {
  const [railRes, basemap] = await Promise.all([
    fetch(STYLE_URL, { headers: UPSTREAM_HEADERS }),
    fetchBasemap(),
  ]);
  const rail = absolutizeStyle((await railRes.json()) as MapStyle, UPSTREAM);
  return compositeStyle(rail, basemap) as unknown as StyleSpecification;
}
