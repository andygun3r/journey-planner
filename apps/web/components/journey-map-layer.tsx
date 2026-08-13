"use client";

import type maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { useEffect } from "react";
import { tflColour } from "@signaller/shared";
// `import type` only — erased at build time, so this client component never
// pulls the server-side planner into the bundle. Same convention as
// commute-panel.tsx and backup-routes.tsx.
import type { JourneyLegView } from "../lib/journeys";

/**
 * Draws a planned journey on the map: one line per leg, plus a marker at every
 * boarding/alighting point.
 *
 * Same shape as signalling-map-layer.tsx — `addJourneyLayers` is called once
 * from live-map.tsx's `load` handler, and the component below only pushes data
 * — so live-map.tsx doesn't grow another 200 lines.
 *
 * Legs are distinguished by more than colour (PRODUCT.md / WCAG 2.2 AA): walk
 * legs are dashed and thin, transit legs solid and thick, so the difference
 * survives greyscale and colour-blindness.
 */

const ROUTE_SOURCE = "journey-route";
const STOPS_SOURCE = "journey-stops";

const EMPTY_LINES: FeatureCollection<LineString> = { type: "FeatureCollection", features: [] };
const EMPTY_POINTS: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };

/**
 * Leg colours. Rail is Rail Navy — the structural colour, and the app's
 * backbone mode. Walking is Ink Muted: present, but quiet. TfL legs take
 * their real per-line colour (Central red, Victoria light blue) from
 * packages/shared, since that's what people already read as "the tube map".
 *
 * Signal Red is deliberately NOT used for rail: DESIGN.md reserves it as the
 * one spotlight colour for live status and alerts, so spending it on a route
 * line would blunt exactly the signal it exists to carry.
 */
const RAIL_COLOUR = "#1c2340";
const WALK_COLOUR = "#4a4e5c";

function colourFor(mode: string, lineId?: string): string {
  if (mode === "rail") return RAIL_COLOUR;
  if (mode === "walk") return WALK_COLOUR;
  return tflColour(lineId, mode) ?? RAIL_COLOUR;
}

/** Adds the sources/layers once, on map load — call from live-map.tsx's `load` handler. */
export function addJourneyLayers(map: maplibregl.Map): void {
  map.addSource(ROUTE_SOURCE, { type: "geojson", data: EMPTY_LINES });
  map.addSource(STOPS_SOURCE, { type: "geojson", data: EMPTY_POINTS });

  // A pale casing under every leg keeps the route readable wherever it crosses
  // the rail overlay's own dark track lines.
  map.addLayer({
    id: `${ROUTE_SOURCE}-casing`,
    type: "line",
    source: ROUTE_SOURCE,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-width": ["case", ["get", "selected"], 11, 8],
      "line-opacity": 0.9,
    },
  });

  map.addLayer({
    id: `${ROUTE_SOURCE}-line`,
    type: "line",
    source: ROUTE_SOURCE,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "colour"],
      "line-width": ["case", ["get", "selected"], 6, 4],
      // Unselected legs fade back so the chosen one reads first, but stay
      // visible — the whole journey should remain legible at a glance.
      "line-opacity": ["case", ["get", "dimmed"], 0.35, 1],
      // Dashes mark walking without relying on colour alone.
      "line-dasharray": ["case", ["get", "walk"], ["literal", [2, 1.5]], ["literal", [1, 0]]],
    },
  });

  map.addLayer({
    id: `${STOPS_SOURCE}-circle`,
    type: "circle",
    source: STOPS_SOURCE,
    paint: {
      "circle-radius": ["case", ["get", "terminus"], 7, 5],
      "circle-color": "#ffffff",
      "circle-stroke-color": ["get", "colour"],
      "circle-stroke-width": ["case", ["get", "terminus"], 3.5, 2.5],
    },
  });

  map.addLayer({
    id: `${STOPS_SOURCE}-label`,
    type: "symbol",
    source: STOPS_SOURCE,
    // Only the start and end are labelled by default; labelling every
    // interchange turns a cross-country journey into a wall of text.
    filter: ["get", "terminus"],
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["OpenRailwayMap-Bold"],
      "text-size": 12,
      "text-offset": [0, 1.4],
      "text-anchor": "top",
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": "#14161f",
      "text-halo-color": "#f6f4f0",
      "text-halo-width": 1.6,
    },
  });
}

/** Line features for a journey's legs, skipping legs with no known geometry. */
export function journeyRouteFeatures(
  legs: JourneyLegView[],
  selectedLeg: number | null,
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (const [i, leg] of legs.entries()) {
    // A leg with no geometry is drawn as nothing at all rather than a straight
    // chord between endpoints — see lib/corridor-geometry.ts for why.
    if (!leg.geometry || leg.geometry.length < 2) continue;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: leg.geometry },
      properties: {
        legIndex: i,
        colour: colourFor(leg.mode, leg.lineId),
        walk: leg.mode === "walk",
        selected: selectedLeg === i,
        dimmed: selectedLeg !== null && selectedLeg !== i,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Boarding/alighting markers, deduped where one leg's end is the next one's start. */
export function journeyStopFeatures(legs: JourneyLegView[]): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  const seen = new Set<string>();

  function add(
    lat: number | undefined,
    lon: number | undefined,
    name: string,
    mode: string,
    lineId: string | undefined,
    terminus: boolean,
  ) {
    if (typeof lat !== "number" || typeof lon !== "number") return;
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { name, colour: colourFor(mode, lineId), terminus },
    });
  }

  for (const [i, leg] of legs.entries()) {
    add(leg.originLat, leg.originLon, leg.originName, leg.mode, leg.lineId, i === 0);
    add(leg.destLat, leg.destLon, leg.destName, leg.mode, leg.lineId, i === legs.length - 1);
  }
  return { type: "FeatureCollection", features };
}

/** Bounds covering everything drawn, or null when the journey has no geometry at all. */
export function journeyBounds(legs: JourneyLegView[]): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  function extend(lon: number, lat: number) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  for (const leg of legs) {
    for (const [lon, lat] of leg.geometry ?? []) extend(lon, lat);
    if (typeof leg.originLat === "number" && typeof leg.originLon === "number") {
      extend(leg.originLon, leg.originLat);
    }
    if (typeof leg.destLat === "number" && typeof leg.destLon === "number") {
      extend(leg.destLon, leg.destLat);
    }
  }

  return Number.isFinite(west) && Number.isFinite(south) ? [west, south, east, north] : null;
}

interface Props {
  map: maplibregl.Map | null;
  legs: JourneyLegView[];
  /** Index of the leg to highlight, or null to show the whole journey evenly. */
  selectedLeg: number | null;
  /** Padding for fitBounds — the caller knows how much sheet is covering the map. */
  fitPadding?: { top: number; bottom: number; left: number; right: number };
}

export function JourneyMapLayer({ map, legs, selectedLeg, fitPadding }: Props) {
  // Push route + stop data whenever the journey or the selection changes.
  useEffect(() => {
    if (!map) return;
    const route = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    const stops = map.getSource(STOPS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!route || !stops) return;
    route.setData(journeyRouteFeatures(legs, selectedLeg));
    stops.setData(journeyStopFeatures(legs));
  }, [map, legs, selectedLeg]);

  // Frame the selected leg, or the whole journey when nothing is selected.
  useEffect(() => {
    if (!map || legs.length === 0) return;
    const target = selectedLeg !== null && legs[selectedLeg] ? [legs[selectedLeg]!] : legs;
    const bounds = journeyBounds(target);
    if (!bounds) return;

    map.fitBounds(bounds, {
      padding: fitPadding ?? { top: 64, bottom: 64, left: 48, right: 48 },
      maxZoom: 14,
      // Respect the OS "reduce motion" setting rather than animating regardless.
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700,
    });
  }, [map, legs, selectedLeg, fitPadding]);

  return null;
}
