"use client";

import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bearingDegrees, lateLabel, nextPathStop, type LiveTrain, type LiveTrainsResult } from "./map-types";
import { TrainDetailPanel } from "./train-detail-panel";
import { BusStopPanel } from "./bus-stop-panel";
import { BusRoutePanel } from "./bus-route-panel";
import {
  addMapIcons,
  arrowOffsetEms,
  lateBucketColor,
  ARROW_ICON,
  BUS_ICON,
  TRAIN_ICON,
} from "../lib/map-icons";
import { basemapTileUrl, BASEMAP_SOURCE, isDarkTheme, loadAbsoluteStyle } from "../lib/orm-style";

/**
 * Live GB train map: full-bleed MapLibre canvas over the self-hosted
 * OpenRailwayMap-vector stack (see docker-compose.yml's orm-db/import/martin/
 * proxy services) — its nginx proxy serves the "standard" style at /style.
 * Fetches Network Rail positions every 15s and plots them as a GeoJSON layer.
 * On load, centers on the browser's geolocation at ~5 miles wide; falls back
 * to a London-centered default at the same zoom if permission is denied or
 * unavailable.
 */

const POLL_MS = 15_000;
const BUS_POLL_MS = 20_000;
const TRAINS_SOURCE = "live-trains";
const ROUTE_SOURCE = "selected-route";
const BUS_ROUTE_SOURCE = "selected-bus-route";
const TFL_STOPS_SOURCE = "tfl-stops";
const TFL_BUSES_SOURCE = "tfl-buses";

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

/**
 * Build the selected train's route line. Each leg prefers the precomputed
 * track-following corridor (rail_corridor, via pathGeometry) and falls back to
 * a straight chord between the two calling points where none exists — so a
 * route with partial coverage still draws end to end, just less faithfully on
 * the uncovered legs.
 */
function routeToGeoJSON(train: LiveTrain | null): FeatureCollection<LineString> {
  if (!train?.path || train.path.length < 2) {
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
    // Drop the duplicated joint where this leg starts on the previous one's end.
    for (const c of coordinates.length === 0 ? segment : segment.slice(1)) coordinates.push(c);
  }
  if (coordinates.length < 2) return { type: "FeatureCollection", features: [] };
  const feature: Feature<LineString> = {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
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
  const baseSelected = useMemo(
    () => (selectedId ? (trains.find((t) => t.id === selectedId) ?? null) : null),
    [trains, selectedId],
  );
  // Track-following route geometry is fetched per selected train rather than
  // shipped with the whole map payload — see getLiveTrains, where attaching it
  // to all ~800 trains produced a 58MB response.
  const [selectedGeometry, setSelectedGeometry] = useState<{
    rid: string;
    legs: ([number, number][] | null)[];
  } | null>(null);

  useEffect(() => {
    const rid = baseSelected?.rid;
    if (!rid) {
      setSelectedGeometry(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/live-trains?rid=${encodeURIComponent(rid)}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: LiveTrainsResult | null) => {
        const legs = json?.trains[0]?.pathGeometry;
        if (!cancelled && legs) setSelectedGeometry({ rid, legs });
      })
      .catch(() => {
        // Leave geometry unset — routeToGeoJSON falls back to straight chords.
      });
    return () => {
      cancelled = true;
    };
  }, [baseSelected?.rid]);

  // Splice the fetched geometry onto the selected train, but only when it's
  // for this train — a stale response from a previous selection must not draw
  // the wrong route.
  const selected = useMemo(() => {
    if (!baseSelected) return null;
    if (!selectedGeometry || selectedGeometry.rid !== baseSelected.rid) return baseSelected;
    return { ...baseSelected, pathGeometry: selectedGeometry.legs };
  }, [baseSelected, selectedGeometry]);

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
