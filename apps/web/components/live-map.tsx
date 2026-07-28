"use client";

import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bearingDegrees, lateLabel, nextPathStop, type LiveTrain, type LiveTrainsResult } from "./map-types";
import { TrainDetailPanel } from "./train-detail-panel";
import { BusStopPanel } from "./bus-stop-panel";
import { BusRoutePanel } from "./bus-route-panel";

/**
 * Live GB train map: full-bleed MapLibre canvas over the self-hosted
 * OpenRailwayMap-vector stack (see docker-compose.yml's orm-db/import/martin/
 * proxy services) — its nginx proxy serves the "standard" style at /style.
 * Fetches Network Rail positions every 15s and plots them as a GeoJSON layer.
 * On load, centers on the browser's geolocation at ~5 miles wide; falls back
 * to a London-centered default at the same zoom if permission is denied or
 * unavailable.
 */

// An empty NEXT_PUBLIC_TILES_URL must not silently degrade to "": that turns
// every absolutize() call into a no-op, leaving the style's server-relative
// paths pointing at the page origin, where they all 404. Treat blank as unset.
const TILES_URL = (process.env.NEXT_PUBLIC_TILES_URL || "").replace(/\/$/, "") || "http://localhost:8081";
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
const BASEMAP_SOURCE = "carto-basemap";
const BASEMAP_LAYER = "carto-basemap-layer";

function basemapTileUrl(dark: boolean): string {
  return `https://basemaps.cartocdn.com/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}.png`;
}

function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
}

function withBasemap(style: maplibregl.StyleSpecification, dark: boolean): maplibregl.StyleSpecification {
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
    layers: [
      { id: BASEMAP_LAYER, type: "raster", source: BASEMAP_SOURCE },
      ...style.layers,
    ],
  };
}

async function loadAbsoluteStyle(dark: boolean): Promise<maplibregl.StyleSpecification> {
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

/**
 * Renders an SVG path string to an SDF (signed-distance-field) image MapLibre
 * can recolor per-feature via `icon-color` — the same trick used for the
 * on-time/late/early train dots before this became icon-based, now applied to
 * a train/bus glyph instead of a plain circle. SDF wants a single-channel
 * alpha mask, so this fills the path solid black on a transparent canvas and
 * lets MapLibre derive the distance field from the alpha channel itself
 * (that's what `sdf: true` on addImage does — no manual distance-field math
 * needed here).
 */
function rasterizeIcon(svgPath: string, viewBoxSize: number, outputSize: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new ImageData(outputSize, outputSize);
  ctx.scale(outputSize / viewBoxSize, outputSize / viewBoxSize);
  ctx.fillStyle = "#000";
  ctx.fill(new Path2D(svgPath));
  return ctx.getImageData(0, 0, outputSize, outputSize);
}

// Front-facing train glyph — the same path already used in the train detail
// panel's "approaching" marker (train-detail-panel.tsx), so the map icon and
// the panel icon read as the same symbol.
const TRAIN_ICON_PATH =
  "M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5V21h2l2-2h4l2 2h2v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4Zm-6 6h5v4H6V8Zm7 0h5v4h-5V8Zm-4.5 9A1.5 1.5 0 1 1 10 15.5 1.5 1.5 0 0 1 8.5 17Zm7 0A1.5 1.5 0 1 1 17 15.5 1.5 1.5 0 0 1 15.5 17Z";

// Simple front-facing bus glyph in the same visual weight as the train icon.
const BUS_ICON_PATH =
  "M4 5.5C4 3 6.5 2 12 2s8 1 8 3.5v11A2.5 2.5 0 0 1 17.5 19H17l1 2h-2l-1-2H9l-1 2H6l1-2h-.5A2.5 2.5 0 0 1 4 16.5Zm2.5 2.5v5h11v-5ZM7 15.5A1.5 1.5 0 1 0 8.5 17 1.5 1.5 0 0 0 7 15.5Zm10 0A1.5 1.5 0 1 0 18.5 17 1.5 1.5 0 0 0 17 15.5Z";

// A short arrowhead that sits just past the badge's edge (see the
// *-arrow layers' icon-offset) and gets `icon-rotate`d per-feature — the
// "arrow poking out of the circle" pointing along direction of travel.
const ARROW_ICON_PATH = "M9 0 L15.5 11 L9 8.5 L2.5 11 Z";
const ARROW_RASTER_SIZE = 64;

/**
 * `icon-offset` is measured in ems of the icon's own *rendered* size, not
 * pixels — an earlier version assumed pixels outright (offset -34, which
 * placed the arrow ~34 icon-widths away, invisible off past the tile it was
 * drawn in) and a later fix still undershot by an arbitrary /2. This computes
 * the em value needed to push the arrow's center `pastPx` pixels beyond the
 * badge's edge: (badgeRadius + pastPx) converted into the arrow's own
 * rendered-size units, negative because -y is "up/outward" before rotation
 * (icon-rotate then turns that "up" to point along the real bearing).
 */
function arrowOffsetEms(badgeRadius: number, arrowIconSize: number, pastPx = 4): number {
  const arrowRenderedPx = arrowIconSize * ARROW_RASTER_SIZE;
  return -(badgeRadius + pastPx) / arrowRenderedPx;
}

function addMapIcons(map: maplibregl.Map): void {
  const size = 64;
  if (!map.hasImage(TRAIN_ICON)) {
    map.addImage(TRAIN_ICON, rasterizeIcon(TRAIN_ICON_PATH, 24, size), { sdf: true });
  }
  if (!map.hasImage(BUS_ICON)) {
    map.addImage(BUS_ICON, rasterizeIcon(BUS_ICON_PATH, 24, size), { sdf: true });
  }
  if (!map.hasImage(ARROW_ICON)) {
    map.addImage(ARROW_ICON, rasterizeIcon(ARROW_ICON_PATH, 18, size), { sdf: true });
  }
}

const POLL_MS = 15_000;
const BUS_POLL_MS = 20_000;
const TRAINS_SOURCE = "live-trains";
const ROUTE_SOURCE = "selected-route";
const BUS_ROUTE_SOURCE = "selected-bus-route";
const TFL_STOPS_SOURCE = "tfl-stops";
const TFL_BUSES_SOURCE = "tfl-buses";

const TRAIN_ICON = "mainline-train-icon";
const BUS_ICON = "mainline-bus-icon";
const ARROW_ICON = "mainline-direction-arrow";

interface TflStop {
  naptanId: string;
  commonName: string;
  lat: number;
  lon: number;
  modes: string[];
}

interface ApproxBus {
  id: string;
  lineId?: string;
  lineName: string;
  destinationName?: string;
  lat: number;
  lon: number;
  etaSeconds: number;
  atStopNaptanId: string;
  atStopName: string;
  direction?: string;
  bearing?: number;
}

interface BusRoute {
  lineId: string;
  lineName: string;
  direction: string;
  polylines: [number, number][][];
  stops: { naptanId: string; name: string; lat: number; lon: number }[];
}

// ~5 miles wide at GB latitudes on a ~1280px-wide viewport — simplest way to
// hit a target ground width without per-latitude bbox math. (MapLibre zoom is
// log2 of ground resolution, so this isn't a round number.)
const INITIAL_ZOOM = 13.85;

// London — used as the map's default center when geolocation is denied or
// unavailable, so the initial view is still a useful ~5-mile window rather
// than the whole-GB overview (which was the old fallback behaviour).
const DEFAULT_CENTER: [number, number] = [-0.1276, 51.5072];

function trainsToGeoJSON(
  trains: LiveTrain[],
  selectedId: string | null,
): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: trains.map((t) => {
      // No GPS heading for GB rail — derive a bearing from the train's plotted
      // position toward its next calling point (see bearingDegrees's comment).
      // Falls back to 0 (icon points north) when there's no known next stop,
      // e.g. an uncorrelated train with no path at all.
      const next = nextPathStop(t);
      const bearing = next ? bearingDegrees(t, next) : 0;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [t.lon, t.lat] },
        properties: {
          id: t.id,
          headcode: t.headcode ?? "",
          lateBucket: lateLabel(t.latenessMinutes).cls || "unknown",
          selected: t.id === selectedId,
          bearing,
          hasBearing: Boolean(next),
        },
      };
    }),
  };
}

function tflStopsToGeoJSON(stops: TflStop[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: stops.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { id: s.naptanId, name: s.commonName, isBusOnly: s.modes.length === 1 && s.modes[0] === "bus" },
    })),
  };
}

function tflBusesToGeoJSON(buses: ApproxBus[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: buses.map((b) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [b.lon, b.lat] },
      properties: {
        id: b.id,
        line: b.lineName,
        lineId: b.lineId ?? "",
        direction: b.direction ?? "",
        dest: b.destinationName ?? "",
        // Real GPS bearing from TfL when this vehicle has a fix — unlike
        // trains, never synthesized: an approximated position with a made-up
        // heading on top would compound one guess with another.
        bearing: b.bearing ?? 0,
        hasBearing: b.bearing !== undefined,
      },
    })),
  };
}

function busRouteToGeoJSON(route: BusRoute | null): FeatureCollection<LineString> {
  if (!route || route.polylines.length === 0) {
    return { type: "FeatureCollection", features: [] };
  }
  return {
    type: "FeatureCollection",
    features: route.polylines.map((coords) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {},
    })),
  };
}

function routeToGeoJSON(train: LiveTrain | null): FeatureCollection<LineString> {
  if (!train?.path || train.path.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }
  const feature: Feature<LineString> = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: train.path.map((s) => [s.lon, s.lat]),
    },
    properties: {},
  };
  return { type: "FeatureCollection", features: [feature] };
}

export function LiveMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [data, setData] = useState<LiveTrainsResult | null>(null);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tflStops, setTflStops] = useState<TflStop[]>([]);
  const [tflBuses, setTflBuses] = useState<ApproxBus[]>([]);
  const [showTfl, setShowTfl] = useState(true);
  // Bus stop and bus-route panels are mutually exclusive with the train panel
  // and each other — only one map-driven detail panel is ever open at a time.
  const [selectedStop, setSelectedStop] = useState<TflStop | null>(null);
  const [selectedBusRoute, setSelectedBusRoute] = useState<{ lineId: string; direction: string; lineName: string } | null>(null);
  const [busRoute, setBusRoute] = useState<BusRoute | null>(null);
  const trains = useMemo(() => data?.trains ?? [], [data]);
  const selected = useMemo(
    () => (selectedId ? (trains.find((t) => t.id === selectedId) ?? null) : null),
    [trains, selectedId],
  );

  const fetchTrains = useCallback(async () => {
    try {
      const res = await fetch("/api/live-trains", { cache: "no-store" });
      if (!res.ok) throw new Error("bad");
      setData((await res.json()) as LiveTrainsResult);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    fetchTrains();
    const id = setInterval(fetchTrains, POLL_MS);
    return () => clearInterval(id);
  }, [fetchTrains]);

  // TfL stop/station backdrop: static, loaded once — the API route serves it
  // from a Postgres cache refreshed server-side, so no need to poll.
  useEffect(() => {
    fetch("/api/tfl-stops")
      .then((res) => (res.ok ? res.json() : { stops: [] }))
      .then((json: { stops: TflStop[] }) => setTflStops(json.stops ?? []))
      .catch(() => setTflStops([]));
  }, []);

  const fetchBuses = useCallback(() => {
    const map = mapRef.current;
    if (!map || !showTflRef.current) return;
    const b = map.getBounds();
    const params = new URLSearchParams({
      minLat: String(b.getSouth()),
      maxLat: String(b.getNorth()),
      minLon: String(b.getWest()),
      maxLon: String(b.getEast()),
    });
    fetch(`/api/tfl-buses?${params}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { buses: [] }))
      .then((json: { buses: ApproxBus[] }) => setTflBuses(json.buses ?? []))
      .catch(() => setTflBuses([]));
  }, []);

  const fetchBusesRef = useRef(fetchBuses);
  fetchBusesRef.current = fetchBuses;
  const showTflRef = useRef(showTfl);
  showTflRef.current = showTfl;

  useEffect(() => {
    if (!showTfl) return;
    fetchBuses();
    const id = setInterval(fetchBuses, BUS_POLL_MS);
    return () => clearInterval(id);
  }, [showTfl, fetchBuses]);

  // Fetch the route shape + stop list for a clicked bus. Route/line/direction
  // rarely change, so this is a one-shot fetch per selection, not a poll.
  useEffect(() => {
    if (!selectedBusRoute) {
      setBusRoute(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({
      lineId: selectedBusRoute.lineId,
      direction: selectedBusRoute.direction,
    });
    fetch(`/api/tfl-route?${params}`)
      .then((res) => (res.ok ? res.json() : { route: null }))
      .then((json: { route: BusRoute | null }) => {
        if (!cancelled) setBusRoute(json.route);
      })
      .catch(() => {
        if (!cancelled) setBusRoute(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBusRoute]);

  // Create the map once, after fetching an absolutized style — see
  // loadAbsoluteStyle's comment for why passing STYLE_URL as a bare string
  // and letting MapLibre fetch+resolve it itself doesn't work here.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    loadAbsoluteStyle(isDarkTheme()).then((style) => {
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: DEFAULT_CENTER,
        zoom: INITIAL_ZOOM,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      if (process.env.NODE_ENV !== "production") {
        (window as unknown as { __debugMap?: maplibregl.Map }).__debugMap = map;
      }
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      attachMapHandlers(map);
    });

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // ThemeToggle flips document.documentElement.dataset.theme directly (no
  // React state/event to subscribe to), so watch for it and swap just the
  // basemap's raster tile URL — cheaper and less jarring than reloading the
  // whole style, which would also re-trigger every source/layer/handler setup.
  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => {
      const map = mapRef.current;
      if (!map) return;
      const source = map.getSource(BASEMAP_SOURCE) as maplibregl.RasterTileSource | undefined;
      source?.setTiles([basemapTileUrl(isDarkTheme())]);
    });
    observer.observe(target, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Everything that used to run inside the old synchronous map-creation
  // effect's `load` handler — split out so the async style-fetch above stays
  // readable.
  const attachMapHandlers = useCallback((map: maplibregl.Map) => {
    map.on("load", () => {
      addMapIcons(map);

      map.addSource(TFL_STOPS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(TFL_BUSES_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(TRAINS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(ROUTE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(BUS_ROUTE_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: `${ROUTE_SOURCE}-line`,
        type: "line",
        source: ROUTE_SOURCE,
        paint: { "line-color": "#d4202c", "line-width": 2.5 },
      });
      map.addLayer({
        id: `${BUS_ROUTE_SOURCE}-line`,
        type: "line",
        source: BUS_ROUTE_SOURCE,
        paint: { "line-color": "#8a4fd6", "line-width": 2.5, "line-dasharray": [2, 1.5] },
      });
      // TfL static backdrop: small neutral dots, well below trains/buses visually.
      // A light stroke (rather than the dark-navy one used elsewhere) keeps
      // these legible against both the light and dark CARTO basemap variants —
      // a dark stroke on bus stops was reading as near-invisible in dark mode.
      map.addLayer({
        id: `${TFL_STOPS_SOURCE}-circle`,
        type: "circle",
        source: TFL_STOPS_SOURCE,
        minzoom: 12,
        paint: {
          "circle-radius": ["case", ["get", "isBusOnly"], 3, 3.5],
          "circle-color": ["case", ["get", "isBusOnly"], "#8a8fa3", "#c99a2e"],
          "circle-stroke-width": 1.25,
          "circle-stroke-color": "#f4f4f6",
          "circle-opacity": 0.9,
        },
      });
      // Each vehicle is drawn as three stacked layers at the same point: a
      // coloured circle badge (plain `circle` type — full colour control,
      // same as the old plain-dot design), the train/bus glyph centred on
      // top of it in white, and a small arrowhead just outside the circle's
      // edge, rotated to the vehicle's bearing. `icon-offset` is in units of
      // the *arrow icon's own* rendered size, not pixels — sized here so the
      // arrow clears the badge radius rather than overlapping it.
      const BUS_RADIUS = 10;
      map.addLayer({
        id: `${TFL_BUSES_SOURCE}-badge`,
        type: "circle",
        source: TFL_BUSES_SOURCE,
        paint: {
          "circle-radius": BUS_RADIUS,
          "circle-color": "#8a4fd6",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#f4f4f6",
        },
      });
      map.addLayer({
        id: `${TFL_BUSES_SOURCE}-icon`,
        type: "symbol",
        source: TFL_BUSES_SOURCE,
        layout: {
          "icon-image": BUS_ICON,
          "icon-size": 0.34,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": "#f4f4f6" },
      });
      // Approximated bus positions get an arrow only when TfL actually
      // reported a live bearing for this vehicle, never synthesized (see
      // tflBusesToGeoJSON) — an approximated position with a made-up heading
      // on top would compound one guess with another.
      map.addLayer({
        id: `${TFL_BUSES_SOURCE}-arrow`,
        type: "symbol",
        source: TFL_BUSES_SOURCE,
        filter: ["==", ["get", "hasBearing"], true],
        layout: {
          "icon-image": ARROW_ICON,
          "icon-size": 0.3,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-offset": [0, arrowOffsetEms(BUS_RADIUS, 0.3)],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": "#8a4fd6", "icon-halo-color": "#f4f4f6", "icon-halo-width": 1 },
      });

      // Trains: badge colour encodes on-time/late/early (the one thing that
      // was working well with plain coloured dots), plus a direction arrow
      // derived from the train's next calling point (see
      // trainsToGeoJSON/bearingDegrees — there's no GPS heading for GB rail).
      const lateBucketColor: maplibregl.ExpressionSpecification = [
        "match",
        ["get", "lateBucket"],
        "ontime",
        "#076d3a",
        "late",
        "#d4202c",
        "early",
        "#0033a0",
        "#5c6070",
      ];
      map.addLayer({
        id: `${TRAINS_SOURCE}-badge`,
        type: "circle",
        source: TRAINS_SOURCE,
        paint: {
          "circle-radius": ["case", ["get", "selected"], 14, 11],
          "circle-color": lateBucketColor,
          "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
          "circle-stroke-color": "#f4f4f6",
        },
      });
      map.addLayer({
        id: `${TRAINS_SOURCE}-icon`,
        type: "symbol",
        source: TRAINS_SOURCE,
        layout: {
          "icon-image": TRAIN_ICON,
          "icon-size": ["case", ["get", "selected"], 0.42, 0.34],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": "#f4f4f6" },
      });
      map.addLayer({
        id: `${TRAINS_SOURCE}-arrow`,
        type: "symbol",
        source: TRAINS_SOURCE,
        filter: ["==", ["get", "hasBearing"], true],
        layout: {
          "icon-image": ARROW_ICON,
          "icon-size": ["case", ["get", "selected"], 0.34, 0.3],
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-offset": [
            "case",
            ["get", "selected"],
            ["literal", [0, arrowOffsetEms(14, 0.34)]],
            ["literal", [0, arrowOffsetEms(11, 0.3)]],
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": lateBucketColor, "icon-halo-color": "#f4f4f6", "icon-halo-width": 1 },
      });

      map.on("click", `${TRAINS_SOURCE}-icon`, (e) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) {
          setSelectedId(id);
          setSelectedStop(null);
          setSelectedBusRoute(null);
        }
      });
      map.on("click", `${TFL_STOPS_SOURCE}-circle`, (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        const props = f.properties ?? {};
        const [lon, lat] = f.geometry.coordinates as [number, number];
        setSelectedStop({
          naptanId: String(props.id ?? ""),
          commonName: String(props.name ?? ""),
          lat,
          lon,
          modes: props.isBusOnly ? ["bus"] : [],
        });
        setSelectedId(null);
        setSelectedBusRoute(null);
      });
      map.on("click", `${TFL_BUSES_SOURCE}-icon`, (e) => {
        const props = e.features?.[0]?.properties ?? {};
        const lineId = props.lineId as string | undefined;
        const direction = props.direction as string | undefined;
        if (!lineId || !direction) return;
        setSelectedBusRoute({ lineId, direction, lineName: String(props.line ?? lineId) });
        setSelectedId(null);
        setSelectedStop(null);
      });
      map.on("click", (e) => {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: [`${TRAINS_SOURCE}-icon`, `${TFL_STOPS_SOURCE}-circle`, `${TFL_BUSES_SOURCE}-icon`],
        });
        if (hits.length === 0) {
          setSelectedId(null);
          setSelectedStop(null);
          setSelectedBusRoute(null);
        }
      });

      for (const layer of [`${TRAINS_SOURCE}-icon`, `${TFL_STOPS_SOURCE}-circle`, `${TFL_BUSES_SOURCE}-icon`]) {
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }

      const stopPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
      map.on("mouseenter", `${TFL_STOPS_SOURCE}-circle`, (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        stopPopup
          .setLngLat(f.geometry.coordinates as [number, number])
          .setText(String(f.properties?.name ?? ""))
          .addTo(map);
      });
      map.on("mouseleave", `${TFL_STOPS_SOURCE}-circle`, () => {
        stopPopup.remove();
      });

      const busPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
      map.on("mouseenter", `${TFL_BUSES_SOURCE}-icon`, (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        const line = f.properties?.line ?? "";
        const dest = f.properties?.dest ?? "";
        busPopup
          .setLngLat(f.geometry.coordinates as [number, number])
          .setText(dest ? `${line} → ${dest}` : String(line))
          .addTo(map);
      });
      map.on("mouseleave", `${TFL_BUSES_SOURCE}-icon`, () => {
        busPopup.remove();
      });
    });

    map.on("moveend", () => fetchBusesRef.current());

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          map.jumpTo({
            center: [pos.coords.longitude, pos.coords.latitude],
            zoom: INITIAL_ZOOM,
          });
        },
        () => {
          // Denied/unavailable — stays on the London default center/zoom set above.
        },
        { timeout: 8000 },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push fresh train data into the map's GeoJSON sources.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const trainsSource = map.getSource(TRAINS_SOURCE) as GeoJSONSource | undefined;
      trainsSource?.setData(trainsToGeoJSON(trains, selectedId));
      const routeSource = map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined;
      routeSource?.setData(routeToGeoJSON(selected));
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [trains, selectedId, selected]);

  // Push fresh TfL stop/bus data, respecting the visibility toggle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const stopsSource = map.getSource(TFL_STOPS_SOURCE) as GeoJSONSource | undefined;
      stopsSource?.setData(showTfl ? tflStopsToGeoJSON(tflStops) : { type: "FeatureCollection", features: [] });
      const busesSource = map.getSource(TFL_BUSES_SOURCE) as GeoJSONSource | undefined;
      busesSource?.setData(showTfl ? tflBusesToGeoJSON(tflBuses) : { type: "FeatureCollection", features: [] });
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [tflStops, tflBuses, showTfl]);

  // Draw the selected bus's route once its polyline/stop list has loaded.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const source = map.getSource(BUS_ROUTE_SOURCE) as GeoJSONSource | undefined;
      source?.setData(busRouteToGeoJSON(busRoute));
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [busRoute]);

  return (
    <div className="live-map-wrap">
      <div className="map-toolbar live-map-toolbar">
        <div className="map-stat">
          {error ? (
            <span className="map-stat-off">● data offline</span>
          ) : data ? (
            <>
              <span className="map-live-dot" aria-hidden="true" />
              <strong>{data.count}</strong> trains live
            </>
          ) : (
            "Loading live positions…"
          )}
        </div>
        <button
          type="button"
          className="map-tfl-toggle"
          aria-pressed={showTfl}
          onClick={() => setShowTfl((v) => !v)}
        >
          {showTfl ? "Hide" : "Show"} tube/bus/DLR
        </button>
      </div>

      <div ref={containerRef} className="live-map-canvas" />

      {selected && (
        <div className="live-map-panel">
          <TrainDetailPanel train={selected} onClose={() => setSelectedId(null)} />
        </div>
      )}

      {selectedStop && (
        <div className="live-map-panel">
          <BusStopPanel stop={selectedStop} onClose={() => setSelectedStop(null)} />
        </div>
      )}

      {selectedBusRoute && (
        <div className="live-map-panel">
          <BusRoutePanel
            lineName={selectedBusRoute.lineName}
            direction={selectedBusRoute.direction}
            route={busRoute}
            onClose={() => setSelectedBusRoute(null)}
          />
        </div>
      )}

      <p className="map-legend live-map-legend">
        <span className="map-key map-key-ontime">On time</span>
        <span className="map-key map-key-late">Late</span>
        <span className="map-key map-key-early">Early</span>
        {showTfl && (
          <>
            <span className="map-key map-key-tfl-stop">Tube/rail/DLR stop</span>
            <span className="map-key map-key-tfl-bus-stop">Bus stop</span>
            <span className="map-key map-key-tfl-bus">Approx. bus</span>
          </>
        )}
        <span className="map-legend-note">
          Rail positions from Network Rail TRUST &amp; Train Describer — timing-point derived, not
          GPS. Bus positions are approximated from TfL arrival countdowns, not tracked GPS.
        </span>
      </p>
    </div>
  );
}
