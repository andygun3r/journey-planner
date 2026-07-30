"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Traksy-style corridor signalling board. Draws the berth graph (auto-laid-out
 * server-side from SMART) as a linear track diagram, with live headcodes riding
 * their berths and signal aspects decoded from S-class where SOP data exists.
 * Signals with no SOP mapping render "unknown" (grey) — honest to the data.
 *
 * Shown in a modal launched from a train's detail panel. Live over SSE, with
 * polling as the fallback.
 *
 * The layout arrives once and stays put. It comes from SMART reference data and
 * does not change while the modal is open, but it used to be re-sent — hundreds
 * of berth nodes — on every 8-second poll. Only the aspects and the trains move,
 * so only those are streamed.
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
interface DiagramLayout {
  berths: LaidBerth[];
  edges: Array<{ from: string; to: string }>;
  width: number;
  height: number;
}
/** The moving part: what the signals show and where the trains are. */
interface DiagramState {
  generatedAt: string;
  areas: string[];
  focusHeadcode?: string;
  signals: DiagramSignal[];
  trains: DiagramTrain[];
  mappedAreas: number;
}
interface CorridorDiagram extends DiagramState {
  layout: DiagramLayout;
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
  const [layout, setLayout] = useState<DiagramLayout | null>(null);
  const [data, setData] = useState<DiagramState | null>(null);
  const [error, setError] = useState(false);

  const fetchDiagram = useCallback(async () => {
    try {
      const res = await fetch(`/api/signalling?${query}`, { cache: "no-store" });
      if (!res.ok) throw new Error("bad");
      const json = (await res.json()) as CorridorDiagram;
      // The polling endpoint still returns both halves together; split them so
      // the rest of the component doesn't care which path the data came from.
      setLayout(json.layout);
      setData(json);
      setError(false);
    } catch {
      setError(true);
    }
  }, [query]);

  // Same shape as the map and the alert feed: stream first, poll to cover the
  // gaps, and the mutual-exclusion guard in startPolling is what stops a tab
  // doing both at once.
  useEffect(() => {
    let stopped = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const startPolling = () => {
      if (stopped || poll) return;
      void fetchDiagram();
      poll = setInterval(() => void fetchDiagram(), 8_000);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = undefined;
    };

    const open = () => {
      if (stopped) return;
      if (typeof window === "undefined" || !("EventSource" in window)) {
        startPolling();
        return;
      }

      // Draw something immediately, and keep drawing if a proxy buffers the
      // stream — a failure that otherwise looks exactly like a quiet corridor.
      startPolling();

      const es = new EventSource(`/api/live/signalling?${query}`);

      es.addEventListener("ready", () => {
        attempt = 0;
        stopPolling();
      });

      // No Redis on the server, so the stream has no trigger. Retrying won't
      // help; stay on polling.
      es.addEventListener("unavailable", () => {
        es.close();
        startPolling();
      });

      es.addEventListener("layout", (ev) => {
        const parsed = JSON.parse((ev as MessageEvent<string>).data) as { layout: DiagramLayout };
        setLayout(parsed.layout);
      });

      es.addEventListener("state", (ev) => {
        attempt = 0;
        stopPolling();
        setData(JSON.parse((ev as MessageEvent<string>).data) as DiagramState);
        setError(false);
      });

      es.onerror = () => {
        es.close();
        if (stopped) return;
        startPolling();
        attempt += 1;
        reconnect = setTimeout(open, Math.min(1000 * 2 ** attempt, 60_000));
      };
    };

    open();

    return () => {
      stopped = true;
      stopPolling();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [fetchDiagram, query]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keyed on the layout, not the data, so it stops rebuilding on every update.
  // It used to be thrown away and reconstructed 7.5 times a minute even though
  // the berths it indexes never moved.
  const berthById = useMemo(() => {
    const m = new Map<string, LaidBerth>();
    for (const b of layout?.berths ?? []) m.set(b.id, b);
    return m;
  }, [layout]);

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
          {hasBerths && layout && data && (
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
