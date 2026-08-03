"use client";

import type maplibregl from "maplibre-gl";
import type { FeatureCollection, MultiLineString, Point } from "geojson";
import { useEffect, useRef } from "react";

/**
 * The national signalling overlay for /map: live signal markers, berth boxes
 * and recent train paths where a real coordinate exists (see
 * apps/web/lib/signalling.ts's getAllAreasSignalMarkers/getAllAreasBerths/
 * getRecentPathsInBbox — all anchored to a station via
 * station_track_model_position; anything unanchored is omitted rather than
 * fabricated). Off by default, toggled from live-map.tsx, same pattern as its
 * tube/bus/DLR toggle.
 *
 * There is NO separate track-line layer here — /map's base style is already
 * the real OpenRailwayMap-vector stack (see lib/orm-style.ts), which draws
 * actual track geometry (proper curves/junctions from OSM, not our own
 * bbox-filtered Track Model approximation) and its own static signal icons
 * (the `signals_railway_signals` source, appearing from zoom 13). Drawing a
 * second, less accurate track layer on top would be redundant map-draw cost
 * for a strictly worse line. This overlay only adds what ORM's static style
 * can't: LIVE state. Its zoom gating matches ORM's own signal layer (13) so
 * the live markers/berths appear alongside the real signal icons rather than
 * popping in at an unrelated zoom level.
 *
 * Two of these three layers do NOT need SOP/S-class decode at all:
 *   - berth boxes' headcode label is straight TD occupancy (nr_train_position).
 *   - berth boxes' "blocked ahead" colour is derived purely from occupancy of
 *     the next berth along the layout graph — a real block-signalling rule
 *     (one train per section), not a guess.
 *   - paths are TD berth-step history (nr_train_position_history), again no
 *     SOP involved.
 * Only the small dot markers (national-signal-markers) carry a genuinely
 * decoded aspect, and only where an area's SOP map has actually been sourced.
 *
 * Everything is fetched per-viewport (bbox-scoped), not as one national blob.
 */

const MARKERS_SOURCE = "national-signal-markers";
const BERTHS_SOURCE = "national-berths";
const PATHS_SOURCE = "national-train-paths";
// Matches ORM's own signals_railway_signals minzoom (martin/configuration.yml)
// so the live overlay appears at the same zoom the real signal icons do.
const MARKERS_MINZOOM = 13;
const BERTHS_MINZOOM = 13;
const PATHS_MINZOOM = 11;
const POLL_MS = 15_000;

const EMPTY_MULTILINES: FeatureCollection<MultiLineString> = { type: "FeatureCollection", features: [] };
const EMPTY_POINTS: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };

function bboxParam(map: maplibregl.Map): string {
  const b = map.getBounds();
  return `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
}

/** Adds the sources/layers once, on map load — call from live-map.tsx's existing `load` handler. */
export function addSignallingLayers(map: maplibregl.Map): void {
  map.addSource(MARKERS_SOURCE, { type: "geojson", data: EMPTY_POINTS });
  map.addSource(BERTHS_SOURCE, { type: "geojson", data: EMPTY_POINTS });
  map.addSource(PATHS_SOURCE, { type: "geojson", data: EMPTY_MULTILINES });

  // Recent train paths: derived from berth-step history, not SOP.
  map.addLayer({
    id: `${PATHS_SOURCE}-line`,
    type: "line",
    source: PATHS_SOURCE,
    minzoom: PATHS_MINZOOM,
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#2f7bff",
      "line-width": ["interpolate", ["linear"], ["zoom"], PATHS_MINZOOM, 1, 16, 3],
      "line-opacity": 0.7,
      "line-dasharray": [2, 1.5],
    },
  });

  // Berth boxes: a coloured square (occupancy/block state) with the headcode
  // as its text label, same idea as the schematic diagram's <rect>+<text>,
  // just at real ground coordinates instead of layout pixels.
  map.addLayer({
    id: `${BERTHS_SOURCE}-box`,
    type: "circle",
    source: BERTHS_SOURCE,
    minzoom: BERTHS_MINZOOM,
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], BERTHS_MINZOOM, 5, 18, 10],
      "circle-color": [
        "case",
        ["has", "headcode"],
        "#2f7bff",
        ["==", ["get", "blockedAhead"], true],
        "#e03131",
        "#20242c",
      ],
      "circle-stroke-width": 1,
      "circle-stroke-color": "#f4f4f6",
    },
  });
  map.addLayer({
    id: `${BERTHS_SOURCE}-label`,
    type: "symbol",
    source: BERTHS_SOURCE,
    minzoom: BERTHS_MINZOOM,
    layout: {
      visibility: "none",
      "text-field": ["get", "headcode"],
      "text-size": 11,
      "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#f4f4f6",
      "text-halo-color": "#20242c",
      "text-halo-width": 1,
    },
  });

  map.addLayer({
    id: `${MARKERS_SOURCE}-circle`,
    type: "circle",
    source: MARKERS_SOURCE,
    minzoom: MARKERS_MINZOOM,
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], MARKERS_MINZOOM, 3, 18, 6],
      "circle-color": [
        "match",
        ["get", "aspect"],
        "off",
        "#2f9e44",
        "red",
        "#e03131",
        /* unknown */ "#868e96",
      ],
      "circle-stroke-width": 1,
      "circle-stroke-color": "#f4f4f6",
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

async function fetchBerths(map: maplibregl.Map): Promise<void> {
  try {
    const res = await fetch(`/api/signalling/berths?bbox=${bboxParam(map)}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as FeatureCollection<Point>;
    const source = map.getSource(BERTHS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData(data);
  } catch {
    // Keep the last good berths rather than clearing them.
  }
}

async function fetchPaths(map: maplibregl.Map): Promise<void> {
  try {
    const res = await fetch(`/api/signalling/paths?bbox=${bboxParam(map)}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as FeatureCollection<MultiLineString>;
    const source = map.getSource(PATHS_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData(data);
  } catch {
    // Keep the last good paths rather than clearing them.
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
      const layerIds = [`${PATHS_SOURCE}-line`, `${BERTHS_SOURCE}-box`, `${BERTHS_SOURCE}-label`, `${MARKERS_SOURCE}-circle`];
      for (const id of layerIds) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
      }
    };

    if (!enabled) {
      setVisible(false);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = undefined;
      const markersSource = map.getSource(MARKERS_SOURCE) as maplibregl.GeoJSONSource | undefined;
      const berthsSource = map.getSource(BERTHS_SOURCE) as maplibregl.GeoJSONSource | undefined;
      const pathsSource = map.getSource(PATHS_SOURCE) as maplibregl.GeoJSONSource | undefined;
      markersSource?.setData(EMPTY_POINTS);
      berthsSource?.setData(EMPTY_POINTS);
      pathsSource?.setData(EMPTY_MULTILINES);
      return;
    }

    setVisible(true);
    const refetch = () => {
      void fetchMarkers(map);
      void fetchBerths(map);
      void fetchPaths(map);
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
