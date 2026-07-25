"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Live GB train map. Plots Network Rail positions on a coordinate-projected
 * SVG (no external tiles — the geography IS the ~3,100 station coordinates,
 * the way a schematic control-room board looks). Trains poll every 15s and
 * ease to their new positions; pan by drag, zoom by wheel/buttons.
 */

interface LiveTrain {
  id: string;
  headcode?: string;
  lat: number;
  lon: number;
  atName?: string;
  event?: string;
  towardName?: string;
  destName?: string;
  latenessMinutes?: number;
  reportedAgoSeconds: number;
  rid?: string;
}

interface LiveTrainsResult {
  generatedAt: string;
  count: number;
  trains: LiveTrain[];
}

// GB bounding box (a little padding around the extremes of the network).
const BOUNDS = { minLat: 49.9, maxLat: 58.75, minLon: -8.2, maxLon: 1.9 };
const W = 1000;
// Height from an equirectangular aspect at GB's mid-latitude (~54°N).
const MID_LAT_RAD = ((BOUNDS.minLat + BOUNDS.maxLat) / 2) * (Math.PI / 180);
const H = Math.round(
  (W * (BOUNDS.maxLat - BOUNDS.minLat)) / ((BOUNDS.maxLon - BOUNDS.minLon) * Math.cos(MID_LAT_RAD)),
);

function project(lat: number, lon: number): { x: number; y: number } {
  const x = ((lon - BOUNDS.minLon) / (BOUNDS.maxLon - BOUNDS.minLon)) * W;
  const y = ((BOUNDS.maxLat - lat) / (BOUNDS.maxLat - BOUNDS.minLat)) * H;
  return { x, y };
}

function lateLabel(m?: number): { text: string; cls: string } {
  if (m === undefined) return { text: "", cls: "" };
  if (m > 1) return { text: `${m} late`, cls: "late" };
  if (m < -1) return { text: `${-m} early`, cls: "early" };
  return { text: "on time", cls: "ontime" };
}

export function TrainMap({ stations }: { stations: Array<[number, number]> }) {
  const [data, setData] = useState<LiveTrainsResult | null>(null);
  const [error, setError] = useState(false);
  const [hovered, setHovered] = useState<LiveTrain | null>(null);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

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
    const id = setInterval(fetchTrains, 15_000);
    return () => clearInterval(id);
  }, [fetchTrains]);

  const stationDots = useMemo(
    () =>
      stations.map(([lat, lon], i) => {
        const { x, y } = project(lat, lon);
        return <circle key={i} cx={x} cy={y} r={0.9} className="map-station" />;
      }),
    [stations],
  );

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const scale = Math.min(8, Math.max(1, v.scale * factor));
      return { ...v, scale };
    });
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    // Capture the drag origin now: drag.current can be cleared by a trailing
    // pointerup before the (async) state updater runs.
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const zoom = (factor: number) =>
    setView((v) => ({ ...v, scale: Math.min(8, Math.max(1, v.scale * factor)) }));
  const reset = () => setView({ scale: 1, tx: 0, ty: 0 });

  const trains = data?.trains ?? [];

  return (
    <div className="map-wrap">
      <div className="map-toolbar">
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
        <div className="map-controls">
          <button type="button" onClick={() => zoom(1.4)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={() => zoom(1 / 1.4)} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={reset} aria-label="Reset view">
            Reset
          </button>
        </div>
      </div>

      <div className="map-canvas">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="map-svg"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          role="img"
          aria-label="Live map of trains across Great Britain"
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
            <g className="map-stations">{stationDots}</g>
            <g className="map-trains">
              {trains.map((tr) => {
                const { x, y } = project(tr.lat, tr.lon);
                const late = lateLabel(tr.latenessMinutes);
                return (
                  <circle
                    key={tr.id}
                    cx={x}
                    cy={y}
                    r={2.6 / Math.sqrt(view.scale)}
                    className={`map-train map-train-${late.cls || "unknown"}`}
                    onPointerEnter={() => setHovered(tr)}
                    onPointerLeave={() => setHovered((h) => (h?.id === tr.id ? null : h))}
                  />
                );
              })}
            </g>
          </g>
        </svg>

        {hovered && <TrainTooltip train={hovered} />}
        {!error && data && data.count === 0 && (
          <div className="map-empty">
            <p>No trains reporting right now.</p>
            <p className="map-empty-sub">
              The Network Rail ingester feeds this map. Positions appear once it’s running and
              trains are moving.
            </p>
          </div>
        )}
      </div>

      <p className="map-legend">
        <span className="map-key map-key-ontime">On time</span>
        <span className="map-key map-key-late">Late</span>
        <span className="map-key map-key-early">Early</span>
        <span className="map-legend-note">
          Positions from Network Rail TRUST &amp; Train Describer — timing-point derived, not GPS.
          Drag to pan, scroll to zoom.
        </span>
      </p>
    </div>
  );
}

function TrainTooltip({ train }: { train: LiveTrain }) {
  const late = lateLabel(train.latenessMinutes);
  const verb =
    train.event === "ARRIVAL" ? "At" : train.event === "DEPARTURE" ? "Departed" : "Passed";
  const body = (
    <div className="map-tip">
      <div className="map-tip-head">
        <span className="map-tip-code">{train.headcode ?? "Train"}</span>
        {late.text && <span className={`map-tip-late map-tip-late-${late.cls}`}>{late.text}</span>}
      </div>
      {train.atName && (
        <div className="map-tip-line">
          {verb} <strong>{train.atName}</strong>
        </div>
      )}
      {train.towardName && <div className="map-tip-line map-tip-muted">→ {train.towardName}</div>}
      {train.destName && <div className="map-tip-line map-tip-dest">to {train.destName}</div>}
    </div>
  );
  return train.rid ? (
    <Link className="map-tip-anchor" href={`/services/${encodeURIComponent(train.rid)}`}>
      {body}
    </Link>
  ) : (
    <div className="map-tip-anchor">{body}</div>
  );
}
