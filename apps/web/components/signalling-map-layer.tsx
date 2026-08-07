"use client";

import type maplibregl from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import { useEffect, useRef } from "react";

/**
 * The national signalling overlay for /map: live signal markers where a real
 * coordinate exists (see apps/web/lib/signalling.ts's getAllAreasSignalMarkers
 * — all anchored to a station via station_track_model_position; anything
 * unanchored is omitted rather than fabricated). Off by default, toggled from
 * live-map.tsx, same pattern as its tube/bus/DLR toggle.
 *
 * There is NO separate track-line layer here — /map's base style is already
 * the real OpenRailwayMap-vector stack (see lib/orm-style.ts), which draws
 * actual track geometry (proper curves/junctions from OSM, not our own
 * bbox-filtered Track Model approximation) and its own static signal icons
 * (the `signals_railway_signals` source, appearing from zoom 13). Drawing a
 * second, less accurate track layer on top would be redundant map-draw cost
 * for a strictly worse line. This overlay only adds what ORM's static style
 * can't: LIVE state. Its zoom gating matches ORM's own signal layer (13) so
 * the live markers appear alongside the real signal icons rather than popping
 * in at an unrelated zoom level.
 *
 * The signal markers carry decoded aspects only where an area's SOP map has
 * actually been sourced; unknown markers remain visible so missing mappings can
 * be fixed deliberately instead of hidden.
 *
 * Everything is fetched per-viewport (bbox-scoped), not as one national blob.
 */

const MARKERS_SOURCE = "national-signal-markers";
const TRAINS_BADGE_LAYER = "live-trains-badge";
// Matches ORM's own signals_railway_signals minzoom (martin/configuration.yml)
// so the live overlay appears at the same zoom the real signal icons do.
const MARKERS_MINZOOM = 13;
const POLL_MS = 15_000;

const EMPTY_POINTS: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };

function bboxParam(map: maplibregl.Map): string {
  const b = map.getBounds();
  return `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
}

/** Adds the sources/layers once, on map load — call from live-map.tsx's existing `load` handler. */
export function addSignallingLayers(map: maplibregl.Map): void {
  map.addSource(MARKERS_SOURCE, { type: "geojson", data: EMPTY_POINTS });

  // Signals are the primary signalling objects on the map: a dark casing gives
  // them enough railway-diagram weight on both light and dark basemaps, while
  // the inner dot carries the decoded aspect.
  map.addLayer({
    id: `${MARKERS_SOURCE}-casing`,
    type: "circle",
    source: MARKERS_SOURCE,
    minzoom: MARKERS_MINZOOM,
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], MARKERS_MINZOOM, 5, 18, 9],
      "circle-color": "#05070a",
      "circle-stroke-width": ["case", ["==", ["get", "mapped"], true], 1.5, 1],
      "circle-stroke-color": ["case", ["==", ["get", "mapped"], true], "#ffffff", "#d6352c"],
      "circle-opacity": ["case", ["==", ["get", "mapped"], true], 0.96, 0.82],
    },
  });
  map.addLayer({
    id: `${MARKERS_SOURCE}-aspect`,
    type: "circle",
    source: MARKERS_SOURCE,
    minzoom: MARKERS_MINZOOM,
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], MARKERS_MINZOOM, 2.6, 18, 5],
      "circle-color": [
        "match",
        ["get", "aspect"],
        "off",
        "#2e7d46",
        "red",
        "#d6352c",
        /* unknown */ "#8a8fa3",
      ],
      "circle-stroke-width": ["case", ["==", ["get", "aspect"], "unknown"], 1.5, 0],
      "circle-stroke-color": "#f6f4f0",
    },
  });
  map.addLayer({
    id: `${MARKERS_SOURCE}-label`,
    type: "symbol",
    source: MARKERS_SOURCE,
    minzoom: MARKERS_MINZOOM,
    layout: {
      visibility: "none",
      "text-field": ["coalesce", ["get", "itemId"], ["get", "berthAhead"], ["get", "id"], ""],
      "text-size": ["interpolate", ["linear"], ["zoom"], MARKERS_MINZOOM, 8.25, 18, 11],
      "text-offset": [0, -1.35],
      "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#05070a",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  });
}

async function fetchMarkers(map: maplibregl.Map): Promise<void> {
  try {
    const res = await fetch(`/api/signalling/national?bbox=${bboxParam(map)}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = (await res.json()) as FeatureCollection<Point>;
    const source = map.getSource(MARKERS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData(data);
  } catch {
    // Leave the previous data in place — a transient failure shouldn't blank the layer.
  }
}

/**
 * Owns the toggle-on/off behaviour and the pan/zoom-triggered refetching.
 * `map` is null until the underlying MapLibre instance has loaded.
 */
export function SignallingMapLayer({
  map,
  enabled,
}: {
  map: maplibregl.Map | null;
  enabled: boolean;
}) {
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (!map) return;

    const setVisible = (visible: boolean) => {
      const v = visible ? "visible" : "none";
      const layerIds = [
        `${MARKERS_SOURCE}-casing`,
        `${MARKERS_SOURCE}-aspect`,
        `${MARKERS_SOURCE}-label`,
      ];
      for (const id of layerIds) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
      }
      if (visible) {
        const beforeLayer = map.getLayer(TRAINS_BADGE_LAYER) ? TRAINS_BADGE_LAYER : undefined;
        for (const id of layerIds) {
          if (map.getLayer(id)) {
            if (beforeLayer) map.moveLayer(id, beforeLayer);
            else map.moveLayer(id);
          }
        }
      }
    };

    if (!enabled) {
      setVisible(false);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = undefined;
      const markersSource = map.getSource(MARKERS_SOURCE) as maplibregl.GeoJSONSource | undefined;
      markersSource?.setData(EMPTY_POINTS);
      return;
    }

    setVisible(true);
    const refetch = () => {
      void fetchMarkers(map);
    };
    refetch();
    map.on("moveend", refetch);
    pollRef.current = setInterval(refetch, POLL_MS);

    return () => {
      map.off("moveend", refetch);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = undefined;
    };
  }, [map, enabled]);

  return null;
}
