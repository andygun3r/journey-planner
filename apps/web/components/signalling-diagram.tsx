"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Traksy-style corridor signalling board. Draws the berth graph (auto-laid-out
 * server-side from SMART) as a linear track diagram, with live headcodes riding
 * their berths and signal aspects decoded from S-class where SOP data exists.
 * Signals with no SOP mapping render "unknown" (grey) — honest to the data.
 *
 * Shown in a modal launched from a train's detail panel; polls every 8s.
 */

interface LaidBerth {
  id: string;
  tdArea: string;
  berth: string;
  x: number;
  y: number;
}
interface DiagramSignal {
  id: string;
  itemId?: string;
  aspect: "off" | "red" | "unknown";
  occupiedAhead?: boolean;
  mapped: boolean;
  x: number;
  y: number;
}
interface DiagramTrain {
  headcode: string;
  berthId: string;
  lateness?: number;
  focus: boolean;
}
interface CorridorDiagram {
  generatedAt: string;
  areas: string[];
  focusHeadcode?: string;
  layout: {
    berths: LaidBerth[];
    edges: Array<{ from: string; to: string }>;
    width: number;
    height: number;
  };
  signals: DiagramSignal[];
  trains: DiagramTrain[];
  mappedAreas: number;
}

export function SignallingDiagram({
  query,
  title,
  onClose,
}: {
  query: string; // e.g. "trainId=TD:1A23" or "rid=..."
  title: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<CorridorDiagram | null>(null);
  const [error, setError] = useState(false);

  const fetchDiagram = useCallback(async () => {
    try {
      const res = await fetch(`/api/signalling?${query}`, { cache: "no-store" });
      if (!res.ok) throw new Error("bad");
      setData((await res.json()) as CorridorDiagram);
      setError(false);
    } catch {
      setError(true);
    }
  }, [query]);

  useEffect(() => {
    fetchDiagram();
    const id = setInterval(fetchDiagram, 8_000);
    return () => clearInterval(id);
  }, [fetchDiagram]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const berthById = useMemo(() => {
    const m = new Map<string, LaidBerth>();
    for (const b of data?.layout.berths ?? []) m.set(b.id, b);
    return m;
  }, [data]);

  const layout = data?.layout;
  const hasBerths = (layout?.berths.length ?? 0) > 0;

  return (
    <div className="sig-modal" role="dialog" aria-modal="true" aria-label="Signalling diagram">
      <div className="sig-backdrop" onClick={onClose} />
      <div className="sig-panel">
        <div className="sig-head">
          <div>
            <h2 className="sig-title">Signalling · {title}</h2>
            {data && (
              <p className="sig-sub">
                {data.areas.length ? `TD area ${data.areas.join(", ")}` : "No area"} ·{" "}
                {data.mappedAreas > 0
                  ? `${data.mappedAreas}/${data.areas.length} area(s) with signal data`
                  : "no SOP signal data for these areas"}
              </p>
            )}
          </div>
          <button type="button" className="sig-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="sig-board">
          {error && <p className="sig-empty">Signalling data offline.</p>}
          {!error && !data && <p className="sig-empty">Loading signalling…</p>}
          {!error && data && !hasBerths && (
            <p className="sig-empty">
              No berth topology for this corridor yet — SMART reference data is needed for its TD
              area(s).
            </p>
          )}
          {hasBerths && layout && (
            <svg
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className="sig-svg"
              role="img"
              aria-label="Corridor signalling diagram"
            >
              {/* Track edges */}
              <g className="sig-edges">
                {layout.edges.map((e, i) => {
                  const a = berthById.get(e.from);
                  const b = berthById.get(e.to);
                  if (!a || !b) return null;
                  return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="sig-track" />;
                })}
              </g>
              {/* Signals */}
              <g className="sig-signals">
                {data.signals.map((s) => (
                  <circle
                    key={s.id}
                    cx={s.x}
                    cy={s.y}
                    r={4}
                    className={`sig-signal sig-signal-${s.aspect}`}
                  >
                    <title>
                      {s.itemId ? `Signal ${s.itemId}: ` : "Signal: "}
                      {s.aspect === "unknown" ? "no data" : s.aspect}
                    </title>
                  </circle>
                ))}
              </g>
              {/* Berths */}
              <g className="sig-berths">
                {layout.berths.map((b) => (
                  <rect
                    key={b.id}
                    x={b.x - 9}
                    y={b.y - 6}
                    width={18}
                    height={12}
                    rx={2}
                    className="sig-berth"
                  >
                    <title>{`${b.tdArea} berth ${b.berth}`}</title>
                  </rect>
                ))}
              </g>
              {/* Trains riding their berths */}
              <g className="sig-trains">
                {data.trains.map((t) => {
                  const b = berthById.get(t.berthId);
                  if (!b) return null;
                  return (
                    <g key={t.headcode + t.berthId} className={t.focus ? "sig-train-focus" : ""}>
                      <rect
                        x={b.x - 9}
                        y={b.y - 6}
                        width={18}
                        height={12}
                        rx={2}
                        className={`sig-berth-occupied${t.focus ? " sig-berth-focus" : ""}`}
                      />
                      <text x={b.x} y={b.y - 10} className="sig-headcode" textAnchor="middle">
                        {t.headcode}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
        </div>

        <p className="sig-legend">
          <span className="sig-key sig-key-off">Off</span>
          <span className="sig-key sig-key-red">On (red)</span>
          <span className="sig-key sig-key-unknown">No data</span>
          <span className="sig-legend-note">
            Aspects decoded from Network Rail TD S-class where SOP maps exist. Legacy areas without
            published maps show “no data”.
          </span>
        </p>
      </div>
    </div>
  );
}
