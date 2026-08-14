/**
 * Shared map style composition for web and native.
 *
 * OpenRailwayMap-vector's "standard" style is a rail-only overlay: 460+ layers
 * of track/signals/stations, but no background, land, water or place labels.
 * It has to sit over a general basemap. This module fetches both styles and
 * merges them into the single style object MapLibre wants.
 *
 * Previously app-local copies of this logic used a CARTO *raster* basemap
 * underneath.
 * Raster was chosen to dodge the sprite/glyph problem described below; the cost
 * was blurry labels at every zoom and a basemap whose colours fought the
 * Platform White ground. This does the real merge instead, so the basemap is
 * vector: crisp labels, and tinted to match DESIGN.md.
 *
 * Light only, deliberately. See DESIGN.md's One-Theme Rule — there is no dark
 * theme to branch on, and the retired Mainline brand's dark map is not coming
 * back.
 */

/**
 * Minimal structural view of a MapLibre style. Web and native ship their own
 * (incompatible) StyleSpecification types, so this module speaks a structural
 * subset and each app casts at its own boundary — the alternative is making
 * packages/shared depend on a specific MapLibre build.
 */
export interface MapStyle {
  version: number;
  name?: string;
  sources: Record<string, MapStyleSource>;
  layers: MapStyleLayer[];
  sprite?: string | Array<{ id: string; url: string }>;
  glyphs?: string;
  [key: string]: unknown;
}

export interface MapStyleSource {
  type: string;
  url?: string;
  tiles?: string[];
  attribution?: string;
  [key: string]: unknown;
}

export interface MapStyleLayer {
  id: string;
  type: string;
  source?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  [key: string]: unknown;
}

/** OpenFreeMap's free, keyless vector basemap — no usage limits, no signup. */
export const BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

/**
 * Credit for the basemap. Required by ODbL for the OSM data underneath, and by
 * OpenFreeMap's own terms — and it is not optional just because their style
 * omits it. Kept here rather than in the UI so both apps get it automatically.
 */
export const BASEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a> ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

/** Prefix for every basemap source/layer id, so ids can never clash with ORM's. */
const BASEMAP_PREFIX = "basemap-";

/**
 * The three fonts openrailwaymap.app's glyph server actually serves. A style
 * may declare only ONE glyphs URL, and neither font server carries the other's
 * fonts (verified: OpenFreeMap 404s on OpenRailwayMap-Regular and vice versa).
 * We keep ORM's glyphs URL — its 45 label layers reference these by name and
 * cannot be rewritten — and remap the basemap's fonts onto them.
 */
const ORM_FONTS = {
  regular: "OpenRailwayMap-Regular",
  bold: "OpenRailwayMap-Bold",
} as const;

/** Map an OpenFreeMap font name (Noto Sans *) to the nearest ORM equivalent. */
function remapFont(font: string): string {
  return /bold/i.test(font) ? ORM_FONTS.bold : ORM_FONTS.regular;
}

/**
 * Basemap colours, tuned to sit *under* the rail overlay without competing
 * with it. Ground matches DESIGN.md's Platform White; everything else is a
 * desaturated wash so that Signal Red and the rail lines stay the only things
 * that draw the eye.
 */
const PALETTE = {
  ground: "#f6f4f0", // Platform White — same as the page
  water: "#d9e2ec",
  greenery: "#e6eadf",
  building: "#eae7e1",
  road: "#ffffff",
  roadCasing: "#e2ded7",
  boundary: "#c8c4bd",
  label: "#4a4e5c", // Ink Muted
  labelHalo: "#f6f4f0",
} as const;

/** Which palette colour a basemap layer should take, by what it draws. */
function tintFor(layerId: string): string | null {
  const id = layerId.toLowerCase();
  if (id.includes("background")) return PALETTE.ground;
  if (id.includes("water") || id.includes("ocean") || id.includes("sea")) return PALETTE.water;
  if (
    id.includes("park") ||
    id.includes("wood") ||
    id.includes("forest") ||
    id.includes("grass") ||
    id.includes("landcover") ||
    id.includes("landuse")
  ) {
    return PALETTE.greenery;
  }
  if (id.includes("building")) return PALETTE.building;
  if (id.includes("boundary") || id.includes("admin")) return PALETTE.boundary;
  if (id.includes("bridge") || id.includes("tunnel") || id.includes("casing")) {
    return PALETTE.roadCasing;
  }
  if (id.includes("road") || id.includes("highway") || id.includes("transportation")) {
    return PALETTE.road;
  }
  return null;
}

/**
 * Recolour and re-font one basemap layer. Colour expressions are replaced
 * outright with a flat tint: OpenFreeMap's originals are data-driven ramps
 * tuned for a standalone map, and preserving them would reintroduce exactly
 * the colour competition we're removing.
 */
function restyleBasemapLayer(layer: MapStyleLayer): MapStyleLayer {
  const next: MapStyleLayer = {
    ...layer,
    id: `${BASEMAP_PREFIX}${layer.id}`,
    ...(layer.source ? { source: `${BASEMAP_PREFIX}${layer.source}` } : {}),
  };

  const tint = tintFor(layer.id);
  if (tint && layer.paint) {
    const paint = { ...layer.paint };
    for (const key of ["background-color", "fill-color", "line-color", "fill-extrusion-color"]) {
      if (key in paint) paint[key] = tint;
    }
    next.paint = paint;
  } else if (tint && layer.type === "background") {
    next.paint = { "background-color": tint };
  }

  if (layer.type === "symbol") {
    // ORM's glyph server has no icon sprite for basemap POIs, and the labels
    // matter far more than the pins — so text is kept and icons dropped.
    const layout = { ...(layer.layout ?? {}) };
    delete layout["icon-image"];
    const fonts = layout["text-font"];
    if (Array.isArray(fonts)) {
      layout["text-font"] = [...new Set(fonts.map((f) => (typeof f === "string" ? remapFont(f) : f)))];
    }
    next.layout = layout;

    next.paint = {
      ...(layer.paint ?? {}),
      "text-color": PALETTE.label,
      "text-halo-color": PALETTE.labelHalo,
      "text-halo-width": 1.2,
    };
  }

  return next;
}

/** Rewrite a server-relative path (e.g. "/sprite/symbols") against its origin. */
export function absolutizeAgainst(base: string, path: string): string {
  return path.startsWith("/") ? `${base}${path}` : path;
}

/**
 * MapLibre resolves a style's own `url`/`sprite`/`glyphs` fields against the
 * PAGE origin, not the style's URL — so a style fetched as an object must have
 * every one of these made absolute first, or they 404 (and a relative
 * sprite/glyphs passed to setStyle throws "must be absolute" outright).
 */
export function absolutizeStyle(style: MapStyle, base: string): MapStyle {
  for (const source of Object.values(style.sources ?? {})) {
    if (typeof source.url === "string") source.url = absolutizeAgainst(base, source.url);
    if (Array.isArray(source.tiles)) {
      source.tiles = source.tiles.map((t) => absolutizeAgainst(base, t));
    }
  }

  if (typeof style.sprite === "string") {
    style.sprite = absolutizeAgainst(base, style.sprite);
  } else if (Array.isArray(style.sprite)) {
    style.sprite = style.sprite.map((s) => ({ ...s, url: absolutizeAgainst(base, s.url) }));
  }

  if (typeof style.glyphs === "string") style.glyphs = absolutizeAgainst(base, style.glyphs);

  return style;
}

/**
 * Merge the vector basemap *underneath* the rail overlay.
 *
 * Basemap sources and layers are prefixed so they can never collide with ORM's
 * 21 sources / 464 layers, and its layers are prepended so every rail feature
 * draws on top. ORM's sprite and glyphs win, because its layers reference them
 * by name; the basemap's fonts are remapped and its icons dropped to suit.
 */
export function compositeStyle(rail: MapStyle, basemap: MapStyle): MapStyle {
  const basemapSources: Record<string, MapStyleSource> = {};
  const basemapIds = Object.keys(basemap.sources ?? {});
  for (const [i, id] of basemapIds.entries()) {
    const source = basemap.sources![id]!;
    basemapSources[`${BASEMAP_PREFIX}${id}`] = {
      ...source,
      // OpenFreeMap ships no attribution on its sources, so MapLibre's
      // attribution control would show nothing for the basemap and we'd be
      // using OSM data uncredited. Attach it to the first source only —
      // repeating it per source just duplicates it in the control.
      attribution: source.attribution ?? (i === 0 ? BASEMAP_ATTRIBUTION : undefined),
    };
  }

  const basemapLayers = (basemap.layers ?? []).map(restyleBasemapLayer);

  return {
    ...rail,
    sources: { ...basemapSources, ...rail.sources },
    layers: [...basemapLayers, ...rail.layers],
    // Attribution is a legal requirement for both datasets, not decoration.
    metadata: {
      ...(typeof rail.metadata === "object" && rail.metadata ? rail.metadata : {}),
      "signaller:attribution":
        "© OpenStreetMap contributors, © OpenRailwayMap, basemap © OpenFreeMap",
    },
  };
}

/**
 * A ground-only fallback for when the basemap can't be fetched. The rail
 * overlay alone renders as lines floating on a void, which reads as broken —
 * a plain Platform White ground reads as intentional.
 */
export function groundOnlyBasemap(): MapStyle {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: `${BASEMAP_PREFIX}background`,
        type: "background",
        paint: { "background-color": PALETTE.ground },
      },
    ],
  };
}

export const MAP_PALETTE = PALETTE;
