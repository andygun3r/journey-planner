"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { H, W, type Projection } from "../lib/map-projection";
import { lateLabel, type LiveTrain } from "./map-types";

/**
 * The projection-agnostic SVG that both map views render. Draws station dots,
 * each live train's route line (from its calling-point path), and the trains
 * themselves. Pan by drag, zoom by wheel/buttons. Hover pins a tooltip; click
 * selects a train (highlighting its line and dimming the rest).
 *
 * The only difference between the geographic and schematic views is the
 * `project` prop — everything geometric flows through it.
 */

export function MapCanvas({
  stations,
  trains,
  project,
  selectedId,
  onSelect,
}: {
  stations: Array<[number, number]>;
  trains: LiveTrain[];
  project: Projection;
  selectedId: string | null;
  onSelect: (train: LiveTrain | null) => void;
}) {
  const [hovered, setHovered] = useState<LiveTrain | null>(null);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(
    null,
  );

  const stationDots = useMemo(
    () =>
      stations.map(([lat, lon], i) => {
        const { x, y } = project(lat, lon);
        return <circle key={i} cx={x} cy={y} r={0.9} className="map-station" />;
      }),
    [stations, project],
  );

  // Route lines: one polyline per correlated train, built from its path coords.
  const lines = useMemo(() => {
    const hasSelection = selectedId !== null;
    return trains
      .filter((t) => t.path && t.path.length > 1)
      .map((t) => {
        const pts = t
          .path!.map((s) => {
            const { x, y } = project(s.lat, s.lon);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
        const selected = t.id === selectedId;
        const cls = selected ? "map-line map-line-selected" : hasSelection ? "map-line map-line-dim" : "map-line";
        return (
          <polyline
            key={t.id}
            points={pts}
            className={cls}
            strokeWidth={(selected ? 1.6 : 0.8) / Math.sqrt(view.scale)}
          />
        );
      });
  }, [trains, project, selectedId, view.scale]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const scale = Math.min(8, Math.max(1, v.scale * factor));
      return { ...v, scale };
    });
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  // A click on empty canvas (that wasn't a drag) clears the selection.
  const onBackgroundClick = () => {
    if (drag.current?.moved) return;
    onSelect(null);
  };

  const zoom = (factor: number) =>
    setView((v) => ({ ...v, scale: Math.min(8, Math.max(1, v.scale * factor)) }));
  const reset = () => setView({ scale: 1, tx: 0, ty: 0 });

  return (
    <div className="map-canvas">
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

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="map-svg"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onClick={onBackgroundClick}
        role="img"
        aria-label="Live map of trains across Great Britain"
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          <g className="map-stations">{stationDots}</g>
          <g className="map-lines" fill="none">
            {lines}
          </g>
          <g className="map-trains">
            {trains.map((tr) => {
              const { x, y } = project(tr.lat, tr.lon);
              const late = lateLabel(tr.latenessMinutes);
              const selected = tr.id === selectedId;
              const r = (selected ? 3.6 : 2.6) / Math.sqrt(view.scale);
              return (
                <circle
                  key={tr.id}
                  cx={x}
                  cy={y}
                  r={r}
                  className={`map-train map-train-${late.cls || "unknown"}${selected ? " map-train-selected" : ""}`}
                  onPointerEnter={() => setHovered(tr)}
                  onPointerLeave={() => setHovered((h) => (h?.id === tr.id ? null : h))}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (drag.current?.moved) return;
                    onSelect(tr);
                  }}
                />
              );
            })}
          </g>
        </g>
      </svg>

      {hovered && <TrainTooltip train={hovered} />}
    </div>
  );
}

function TrainTooltip({ train }: { train: LiveTrain }) {
  const late = lateLabel(train.latenessMinutes);
  const verb =
    train.event === "ARRIVAL" ? "At" : train.event === "DEPARTURE" ? "Departed" : "Passed";
  return (
    <div className="map-tip map-tip-anchor">
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
      <div className="map-tip-line map-tip-hint">Click for calling points</div>
    </div>
  );
}
