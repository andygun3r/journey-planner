"use client";

import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection, LineString, Point } from "geojson";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  bearingDegrees,
  lateLabel,
  nextPathStop,
  type LiveTrain,
  type LiveTrainsResult,
  type MapTrain,
} from "./map-types";
import { useServicePosition } from "./service-live";
import { addMapIcons, arrowOffsetEms, lateBucketColor, ARROW_ICON, TRAIN_ICON } from "../lib/map-icons";
import { basemapTileUrl, BASEMAP_SOURCE, isDarkTheme, loadAbsoluteStyle } from "../lib/orm-style";

/**
 * The service-detail page's "current position" view. This used to be an SVG
 * schematic (MapCanvas over a hand-rolled corridor projection); it's now the
 * same real OpenRailwayMap-vector cartography the live map uses, so a train's
 * position is shown against actual track geometry rather than a stylised
 * abstraction.
 *
 * The route and the position are fetched separately now, because they change on
 * completely different timescales. The calling pattern and its track-following
 * geometry are the train's plan — settled before it left — and were being
 * re-downloaded every 25 seconds to redraw an identical line. They are fetched
 * once; only the position streams.
 */

const POLL_MS = 25_000;
const TRAIN_SOURCE = "service-train";
const ROUTE_SOURCE = "service-route";
const BADGE_RADIUS = 12;

// Keeps the fitted corridor off the canvas edges, and stops a single-point
// fit (train with no known path) from zooming to street level.
const FIT_PADDING = 48;
const MAX_FIT_ZOOM = 12.5;

function trainToGeoJSON(train: MapTrain): FeatureCollection<Point> {
  // No GPS heading for GB rail — derive a bearing from the train's plotted
  // position toward its next calling point (see bearingDegrees's comment). The
  // stream sends just that next point's coordinates rather than the whole path.
  const next =
    train.nextLat != null && train.nextLon != null
      ? { lat: train.nextLat, lon: train.nextLon }
      : undefined;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [train.lon, train.lat] },
        properties: {
          lateBucket: lateLabel(train.latenessMinutes).cls || "unknown",
          bearing: next ? bearingDegrees(train, next) : 0,
          hasBearing: Boolean(next),
        },
      },
    ],
  };
}

/**
 * Same leg-by-leg assembly as the live map: prefer the precomputed
 * track-following corridor per leg, fall back to a straight chord where none
 * was precomputed.
 */
function routeToGeoJSON(train: LiveTrain): FeatureCollection<LineString> {
  if (!train.path || train.path.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }
  const coordinates: [number, number][] = [];
  for (let i = 1; i < train.path.length; i += 1) {
    const from = train.path[i - 1]!;
    const to = train.path[i]!;
    const leg = train.pathGeometry?.[i - 1];
    const segment: [number, number][] = leg ?? [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ];
    for (const c of coordinates.length === 0 ? segment : segment.slice(1)) coordinates.push(c);
  }
  if (coordinates.length < 2) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: {},
      },
    ],
  };
}

function corridorBounds(train: LiveTrain, at: { lat: number; lon: number }): maplibregl.LngLatBounds {
  const bounds = new maplibregl.LngLatBounds();
  bounds.extend([at.lon, at.lat]);
  for (const p of train.path ?? []) bounds.extend([p.lon, p.lat]);
  // Real track curves away from the straight calling-point chords, so fit to
  // the drawn geometry too or the route can bow outside the initial view.
  for (const leg of train.pathGeometry ?? []) {
    for (const c of leg ?? []) bounds.extend(c);
  }
  return bounds;
}

export function ServicePositionMap({ rid }: { rid: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // The train's plan: calling pattern and track-following geometry. Fetched
  // once — this is settled before the train leaves.
  const [route, setRoute] = useState<LiveTrain | null>(null);
  const [loadedRoute, setLoadedRoute] = useState(false);
  const [error, setError] = useState(false);
  // Fit the view to the train's corridor once, on the first position we get —
  // refitting on every update would yank the map out from under a user who has
  // panned or zoomed to look at something.
  const fittedRef = useRef(false);

  const { position: streamed, streaming } = useServicePosition(rid);
  // Where the poll's answer lands when the stream isn't carrying anything.
  const [polled, setPolled] = useState<MapTrain | null | undefined>(undefined);

  const fetchTrain = useCallback(async () => {
    try {
      const res = await fetch(`/api/live-trains?rid=${encodeURIComponent(rid)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("bad");
      const json = (await res.json()) as LiveTrainsResult;
      const train = json.trains[0] ?? null;
      // The route only needs setting once — but take it from whichever response
      // first carries one, since a train may not be correlated straight away.
      setRoute((current) => (current?.path?.length ? current : train));
      setLoadedRoute(true);
      setPolled(
        train
          ? {
              id: train.id,
              lat: train.lat,
              lon: train.lon,
              latenessMinutes: train.latenessMinutes,
              reportedAgoSeconds: train.reportedAgoSeconds,
              rid: train.rid,
              nextLat: nextPathStop(train)?.lat,
              nextLon: nextPathStop(train)?.lon,
            }
          : null,
      );
      setError(false);
    } catch {
      setError(true);
    }
  }, [rid]);

  // Fetch the route once on mount. This is also what fills the first position,
  // so the map draws immediately rather than waiting on the stream.
  useEffect(() => {
    void fetchTrain();
  }, [fetchTrain]);

  // Poll only while the stream isn't working — behind a buffering proxy, or on
  // a server with no Redis. The stream stands this down as soon as it delivers.
  useEffect(() => {
    if (streaming) return;
    const id = setInterval(() => void fetchTrain(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchTrain, streaming]);

  const train = streamed !== undefined ? streamed : (polled ?? null);
  const loaded = streamed !== undefined || polled !== undefined || loadedRoute;

  // Create the map once we know there's a train to show — see
  // loadAbsoluteStyle's comment for why the style is fetched and absolutized
  // rather than handed to MapLibre as a URL string.
  useEffect(() => {
    if (!train || !containerRef.current || mapRef.current) return;
    let cancelled = false;

    loadAbsoluteStyle(isDarkTheme()).then((style) => {
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: [train.lon, train.lat],
        zoom: 10,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

      map.on("load", () => {
        addMapIcons(map);
        map.addSource(ROUTE_SOURCE, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addSource(TRAIN_SOURCE, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: `${ROUTE_SOURCE}-line`,
          type: "line",
          source: ROUTE_SOURCE,
          paint: { "line-color": "#d4202c", "line-width": 2.5 },
        });
        // Same three-layer vehicle marker as the live map — badge, glyph,
        // bearing arrow — so a train reads identically in both places.
        map.addLayer({
          id: `${TRAIN_SOURCE}-badge`,
          type: "circle",
          source: TRAIN_SOURCE,
          paint: {
            "circle-radius": BADGE_RADIUS,
            "circle-color": lateBucketColor,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#f4f4f6",
          },
        });
        map.addLayer({
          id: `${TRAIN_SOURCE}-icon`,
          type: "symbol",
          source: TRAIN_SOURCE,
          layout: {
            "icon-image": TRAIN_ICON,
            "icon-size": 0.38,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
          paint: { "icon-color": "#f4f4f6" },
        });
        map.addLayer({
          id: `${TRAIN_SOURCE}-arrow`,
          type: "symbol",
          source: TRAIN_SOURCE,
          filter: ["==", ["get", "hasBearing"], true],
          layout: {
            "icon-image": ARROW_ICON,
            "icon-size": 0.32,
            "icon-rotate": ["get", "bearing"],
            "icon-rotation-alignment": "map",
            "icon-offset": [0, arrowOffsetEms(BADGE_RADIUS, 0.32)],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
          paint: { "icon-color": lateBucketColor, "icon-halo-color": "#f4f4f6", "icon-halo-width": 1 },
        });
      });
    });

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Only the first train matters for construction; later polls flow through
    // the data effect below rather than rebuilding the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(train)]);

  // Match the live map: ThemeToggle flips data-theme on <html> directly, so
  // watch for it and swap just the basemap raster tiles.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const source = mapRef.current?.getSource(BASEMAP_SOURCE) as
        | maplibregl.RasterTileSource
        | undefined;
      source?.setTiles([basemapTileUrl(isDarkTheme())]);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // The route line, drawn once. It was being redrawn from a fresh download
  // every 25 seconds to produce the identical line.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !route) return;
    const apply = () => {
      (map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined)?.setData(routeToGeoJSON(route));
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [route]);

  // Push each fresh position into the map's train source.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !train) return;
    const apply = () => {
      (map.getSource(TRAIN_SOURCE) as GeoJSONSource | undefined)?.setData(trainToGeoJSON(train));
      // Needs the route, so it may have to wait for it — hence the guard rather
      // than doing this in the route effect.
      if (!fittedRef.current && route) {
        fittedRef.current = true;
        const bounds = corridorBounds(route, train);
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM, animate: false });
        }
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [train, route]);

  if (error) return null; // honest uncertainty: no map rather than a broken one
  if (!loaded) return <p className="notice-muted">Loading live position…</p>;
  if (!train) return null; // not currently correlated — text banner above still covers it

  return <div ref={containerRef} className="service-position-map" />;
}
