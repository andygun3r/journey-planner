"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Traksy-style corridor signalling board. Draws the berth graph (auto-laid-out
 * server-side from SMART) as a single-lane linear track diagram, with live
 * headcodes riding their berths and signal aspects decoded from S-class where
 * SOP data exists. Signals with no SOP mapping render "unknown" (grey) —
 * honest to the data.
 *
 * Shown in a modal launched from a station board — every TD area signalling
 * that station, not one train's corridor. Live over SSE, with polling as the
 * fallback.
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
  place?: string;
  crs?: string;
  platform?: string;
}
interface DiagramSignal {
  id: string;
  itemId?: string;
  aspect: "off" | "red" | "unknown";
  occupiedAhead?: boolean;
  routeSet?: boolean;
  berthAhead?: string;
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

  // One label per distinct place, at its leftmost x, so a station spanning many
  // berths/platforms only gets labelled once. Ranks near the start of a large
  // area can bunch dozens of distinct places into a narrow x range (many
  // source nodes with no incoming edge all land at x=MARGIN); labelling every
  // one there would just overlap into an unreadable smear, so once sorted by
  // x we drop any label too close to the one already placed.
  const MIN_LABEL_GAP = 60;
  const placeLabels = useMemo(() => {
    const leftmost = new Map<string, number>();
    for (const b of layout?.berths ?? []) {
      if (!b.place) continue;
      const x = leftmost.get(b.place);
      if (x === undefined || b.x < x) leftmost.set(b.place, b.x);
    }
    const sorted = [...leftmost.entries()]
      .map(([place, x]) => ({ place, x }))
      .sort((a, b) => a.x - b.x);
    const spaced: typeof sorted = [];
    let lastX = -Infinity;
    for (const label of sorted) {
      if (label.x - lastX < MIN_LABEL_GAP) continue;
      spaced.push(label);
      lastX = label.x;
    }
    return spaced;
  }, [layout]);

  const hasBerths = (layout?.berths.length ?? 0) > 0;
  const LABEL_BAND = 70;
  const viewBoxHeight = (layout?.height ?? 0) + (placeLabels.length ? LABEL_BAND : 0);
  // Render close to native size (viewBox units are already pixel-scale, e.g.
  // 90px per berth column) rather than stretching to the modal's width — a
  // wide/tall corridor stays legible and the board scrolls instead of
  // squashing everything into the panel.
  const SCALE = 1.5;
  const renderWidth = (layout?.width ?? 0) * SCALE;
  const renderHeight = viewBoxHeight * SCALE;

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
              viewBox={`0 0 ${layout.width} ${viewBoxHeight}`}
              width={renderWidth}
              height={renderHeight}
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
              {/* Route-set overlay: a highlighted line from a signal to the berth its route protects. */}
              <g className="sig-routes">
                {data.signals.map((s) => {
                  if (!s.routeSet || !s.berthAhead) return null;
                  const ahead = berthById.get(s.berthAhead);
                  if (!ahead) return null;
                  return (
                    <line
                      key={`route-${s.id}`}
                      x1={s.x}
                      y1={s.y}
                      x2={ahead.x}
                      y2={ahead.y}
                      className="sig-route-set"
                    />
                  );
                })}
              </g>
              {/* Signals: a short trackside post with a coloured head, angled off the line. */}
              <g className="sig-signals">
                {data.signals.map((s) => (
                  <g key={s.id} className="sig-signal-mark">
                    <line x1={s.x} y1={s.y} x2={s.x} y2={s.y - 8} className="sig-signal-post" />
                    <circle
                      cx={s.x}
                      cy={s.y - 8}
                      r={3}
                      className={`sig-signal-head sig-signal-${s.aspect}`}
                    >
                      <title>
                        {s.itemId ? `Signal ${s.itemId}: ` : "Signal: "}
                        {s.aspect === "unknown" ? "no data" : s.aspect}
                        {s.routeSet ? " · route set" : ""}
                      </title>
                    </circle>
                    {s.mapped && s.itemId && (
                      <text x={s.x} y={s.y - 12} className="sig-signal-label" textAnchor="middle">
                        {s.itemId}
                      </text>
                    )}
                  </g>
                ))}
              </g>
              {/* Berths */}
              <g className="sig-berths">
                {layout.berths.map((b) => (
                  <rect
                    key={b.id}
                    x={b.x - 11}
                    y={b.y - 7}
                    width={22}
                    height={14}
                    rx={2}
                    className="sig-berth"
                  >
                    <title>
                      {b.place ? `${b.place} — ` : ""}
                      {b.tdArea} berth {b.berth}
                      {b.platform ? ` · platform ${b.platform}` : ""}
                    </title>
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
                        x={b.x - 11}
                        y={b.y - 7}
                        width={22}
                        height={14}
                        rx={2}
                        className={`sig-berth-occupied${t.focus ? " sig-berth-focus" : ""}`}
                      />
                      <text
                        x={b.x}
                        y={b.y}
                        className="sig-headcode"
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        {t.headcode}
                      </text>
                    </g>
                  );
                })}
              </g>
              {/* Station/place labels, once per distinct place, below the track. */}
              <g className="sig-places">
                {placeLabels.map(({ place, x }) => (
                  <text
                    key={place}
                    x={x}
                    y={layout.height + 16}
                    className="sig-place-label"
                    textAnchor="end"
                    transform={`rotate(-40 ${x} ${layout.height + 16})`}
                  >
                    {place}
                  </text>
                ))}
              </g>
            </svg>
          )}
        </div>

        <p className="sig-legend">
          <span className="sig-key sig-key-off">Off (clear)</span>
          <span className="sig-key sig-key-red">On (red)</span>
          <span className="sig-key sig-key-route">Route set</span>
          <span className="sig-key sig-key-unknown">No data</span>
          <span className="sig-legend-note">
            Aspects decoded from Network Rail TD S-class where SOP maps exist. Legacy areas without
            published maps show “no data”. Signals are matched to their decoded data by position
            along the line, not a verified id — even a signal showing a real aspect may be paired
            to the wrong one.
          </span>
        </p>
      </div>
    </div>
  );
}
