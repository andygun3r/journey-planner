"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BLUEPRINT_TOP,
  LABEL_GUTTER,
  TRACK_PITCH,
  buildBlueprint,
  type BlueprintModel,
  type BlueprintTrack,
  type StationPosition,
} from "@/lib/blueprint-layout";
import { namedSignallingCorridor, trackRoleName } from "@/lib/signalling-corridors";
import type { TrackSection } from "@signaller/shared";

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

const BLUEPRINT_LABEL_X = 20;

function numericPlatform(platform: string | undefined): number | undefined {
  const match = platform?.match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

/**
 * Which running line a train sits on.
 *
 * Returns undefined rather than guessing. The previous renderer fell back to
 * `laneIndexForBerth`, which summed the character codes of the berth name and
 * took a modulo to pick a lane — so a train whose line was genuinely unknown
 * was still drawn confidently on a specific running line, and the line it got
 * was an artefact of how its berth happened to be spelled. On a signalling
 * diagram that is worse than showing nothing, so unknowns now go to their own
 * gutter column and are labelled as unplaced.
 */
function trackForTrain(
  tracks: BlueprintTrack[],
  platform: string | undefined,
): { track: BlueprintTrack; inferred: boolean } | undefined {
  const n = numericPlatform(platform);
  if (!n || tracks.length === 0) return undefined;

  // SMART gives a platform, not a line. Odd/even platform numbering does track
  // up/down direction at most SWML stations, so this is a real signal — but it
  // is an inference, and the renderer marks trains placed this way.
  const wantUp = n % 2 === 1;
  const candidates = tracks.filter((t) => t.trackId.startsWith(wantUp ? "2" : "1"));
  const chosen = candidates[0] ?? tracks[0];
  return chosen ? { track: chosen, inferred: true } : undefined;
}

/**
 * The vertical corridor blueprint.
 *
 * Reads top-to-bottom: running lines are vertical columns, stations are ticks
 * across them spaced by real track mileage, and names sit upright in the left
 * gutter. Branches hang off their junction station to either side.
 *
 * All geometry comes from lib/blueprint-layout.ts so it can be tested without
 * a DOM; this function only draws.
 */
function CorridorBlueprint({
  model,
  trainsByStation,
  signalCounts,
}: {
  model: BlueprintModel;
  trainsByStation: Map<string, Array<DiagramTrain & { berth: LaidBerth }>>;
  signalCounts: Map<string, { off: number; red: number; unknown: number; routeSet: number }>;
}) {
  const { stations, tracks, branches } = model;
  const firstY = stations[0]?.y ?? BLUEPRINT_TOP;
  const lastY = stations.at(-1)?.y ?? firstY;
  const trackLeft = tracks.length ? Math.min(...tracks.map((t) => t.x)) : LABEL_GUTTER;
  const trackRight = tracks.length ? Math.max(...tracks.map((t) => t.x)) : LABEL_GUTTER;
  const unknownX = trackRight + TRACK_PITCH;

  // Mileage runs one way or the other along the ELR; map it to y using the two
  // outermost stations we actually placed, so track spans line up with ticks.
  const placed = stations.filter((s) => s.mile !== undefined);
  const yForMile = (mile: number): number => {
    const first = placed[0];
    const last = placed.at(-1);
    if (!first || !last || first.mile === last.mile) return firstY;
    const span = (last.mile as number) - (first.mile as number);
    const ratio = (mile - (first.mile as number)) / span;
    return first.y + ratio * (last.y - first.y);
  };

  return (
    <>
      <rect x={0} y={0} width={model.width} height={model.height} className="sig-blueprint-paper" />

      <g className="sig-blueprint-lanes">
        {tracks.map((track) => {
          const top = placed.length ? Math.max(firstY, yForMile(track.fromMile)) : firstY;
          const bottom = placed.length ? Math.min(lastY, yForMile(track.toMile)) : lastY;
          return (
            <g key={track.trackId}>
              <line
                x1={track.x}
                y1={Math.min(top, bottom) - 14}
                x2={track.x}
                y2={Math.max(top, bottom) + 14}
                className="sig-blueprint-road"
              />
              <text
                x={track.x}
                y={BLUEPRINT_TOP - 26}
                className="sig-blueprint-road-label"
                textAnchor="start"
                transform={`rotate(-52 ${track.x} ${BLUEPRINT_TOP - 26})`}
              >
                {track.label}
              </text>
            </g>
          );
        })}
      </g>

      <g className="sig-blueprint-stations">
        {stations.map((station) => {
          const platformCount = station.platforms.size;
          return (
            <g key={station.crs}>
              <line
                x1={trackLeft - 12}
                y1={station.y}
                x2={trackRight + 12}
                y2={station.y}
                className={station.junction ? "sig-blueprint-station-major" : "sig-blueprint-station"}
              />
              <text
                x={BLUEPRINT_LABEL_X}
                y={station.y + 3.5}
                className={
                  station.junction
                    ? "sig-blueprint-station-label-major"
                    : "sig-blueprint-station-label"
                }
              >
                {station.name}
                {station.estimated && (
                  <title>
                    {station.name}: position estimated — no Track Model match, so this station is
                    spaced evenly rather than by real mileage.
                  </title>
                )}
              </text>
              <text x={LABEL_GUTTER - 34} y={station.y + 3.5} className="sig-blueprint-chainage">
                {station.crs}
              </text>
              {station.estimated && (
                <circle
                  cx={LABEL_GUTTER - 14}
                  cy={station.y}
                  r={2}
                  className="sig-blueprint-estimated"
                >
                  <title>Position estimated — no Track Model match for {station.name}.</title>
                </circle>
              )}
              {platformCount > 0 && (
                <text x={trackRight + 18} y={station.y + 3} className="sig-blueprint-platform-count">
                  {platformCount}p
                  <title>
                    {station.name}: {platformCount} platform{platformCount === 1 ? "" : "s"} in
                    matched berth data
                  </title>
                </text>
              )}
            </g>
          );
        })}
      </g>

      <g className="sig-blueprint-signals">
        {stations.map((station) => {
          const counts = signalCounts.get(station.crs);
          if (!counts) return null;
          const signals = [
            ...Array.from({ length: Math.min(counts.red, 3) }, () => "red"),
            ...Array.from({ length: Math.min(counts.off, 3) }, () => "off"),
            ...Array.from({ length: Math.min(counts.unknown, 3) }, () => "unknown"),
          ].slice(0, 5);
          return (
            <g key={station.crs}>
              {signals.map((aspect, i) => (
                <circle
                  key={`${station.crs}-${aspect}-${i}`}
                  cx={trackLeft - 22}
                  cy={station.y - 8 + i * 4.2}
                  r={2.6}
                  className={`sig-signal-head sig-signal-${aspect}`}
                >
                  <title>
                    {station.name}: {counts.red} red, {counts.off} off, {counts.unknown} unknown
                  </title>
                </circle>
              ))}
            </g>
          );
        })}
      </g>

      <g className="sig-blueprint-branches">
        {branches.map((branch, i) => {
          const right = branch.side === "down";
          const stubX = right ? trackRight + 46 : trackLeft - 46;
          const endX = right ? stubX + 34 : stubX - 34;
          // Stagger branches leaving the same station so their labels don't stack.
          const sameStation = branches.slice(0, i).filter((b) => b.atCrs === branch.atCrs).length;
          const y = branch.y + sameStation * 13;
          return (
            <a key={branch.id} href={`/signalling/${branch.id}`} className="sig-blueprint-branch-link">
              <path
                d={`M ${right ? trackRight : trackLeft} ${branch.y} C ${stubX} ${branch.y}, ${stubX} ${y}, ${endX} ${y}`}
                className="sig-blueprint-branch-road"
              />
              <circle cx={endX} cy={y} r={4} className="sig-blueprint-branch-node" />
              <text
                x={right ? endX + 9 : endX - 9}
                y={y + 3.5}
                className="sig-blueprint-branch-label"
                textAnchor={right ? "start" : "end"}
              >
                {branch.label}
              </text>
            </a>
          );
        })}
      </g>

      <g className="sig-blueprint-trains">
        {stations.flatMap((station) => {
          const trains = trainsByStation.get(station.crs) ?? [];
          return trains.slice(0, 4).map((train, i) => {
            const placement = trackForTrain(tracks, train.berth.platform);
            const x = placement ? placement.track.x : unknownX;
            // Several trains at one station would land on top of each other;
            // step them down a few pixels each so all of them stay readable.
            const y = station.y + (i - Math.min(trains.length, 4) / 2 + 0.5) * 13;
            return (
              <g
                key={`${train.headcode}-${train.berthId}`}
                className={train.focus ? "sig-train-focus" : ""}
              >
                <rect
                  x={x - 17}
                  y={y - 6}
                  width={34}
                  height={12}
                  rx={2}
                  className={`sig-berth-occupied${train.focus ? " sig-berth-focus" : ""}${
                    placement ? "" : " sig-berth-unplaced"
                  }`}
                >
                  <title>
                    {train.headcode} at {station.name}, berth {train.berth.tdArea}{" "}
                    {train.berth.berth}
                    {placement
                      ? ` — line inferred from platform ${train.berth.platform}`
                      : " — running line unknown, shown outside the running lines"}
                  </title>
                </rect>
                <text
                  x={x}
                  y={y + 0.5}
                  className="sig-headcode sig-blueprint-headcode"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {train.headcode}
                </text>
              </g>
            );
          });
        })}
      </g>

      <g className="sig-blueprint-unknown-key">
        <text x={unknownX} y={BLUEPRINT_TOP - 26} className="sig-blueprint-road-label-muted" textAnchor="start" transform={`rotate(-52 ${unknownX} ${BLUEPRINT_TOP - 26})`}>
          Line unknown
        </text>
      </g>
    </>
  );
}

export function SignallingDiagram({
  query,
  title,
  mode = "modal",
  variant = "topology",
  geometry,
  onClose,
}: {
  query: string; // e.g. "trainId=TD:1A23" or "rid=..."
  title: string;
  mode?: "modal" | "inline";
  variant?: "topology" | "blueprint";
  /**
   * Where this corridor's stations sit on the railway, and how many running
   * lines each stretch has. Fetched once on the server and passed in, rather
   * than streamed: it changes when the Track Model ETL re-runs, not every eight
   * seconds like the live state does. Absent means "no Track Model coverage",
   * and the diagram falls back to even spacing and says so.
   */
  geometry?: { stations: StationPosition[]; sections: TrackSection[] };
  onClose?: () => void;
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
    if (!onClose) return;
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

  const areaBands = useMemo(() => {
    const bands = new Map<string, { area: string; minY: number; maxY: number }>();
    for (const b of layout?.berths ?? []) {
      const band = bands.get(b.tdArea);
      if (!band) {
        bands.set(b.tdArea, { area: b.tdArea, minY: b.y, maxY: b.y });
      } else {
        band.minY = Math.min(band.minY, b.y);
        band.maxY = Math.max(band.maxY, b.y);
      }
    }
    return [...bands.values()].sort((a, b) => a.minY - b.minY);
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

  /**
   * The corridor id this diagram is drawing, if any.
   *
   * Parsed properly rather than the old `query.includes("corridor=swml")`
   * substring check, which hardcoded the one corridor that existed and would
   * have matched any query string that merely contained that text.
   */
  const corridorId = useMemo(() => {
    const value = new URLSearchParams(query).get("corridor");
    return value ? value.toLowerCase() : undefined;
  }, [query]);

  const blueprint = useMemo(() => {
    if (variant !== "blueprint" || !layout || !data || !corridorId) return null;
    const corridor = namedSignallingCorridor(corridorId);
    if (!corridor) return null;

    const model = buildBlueprint({
      corridor,
      positions: geometry?.stations ?? [],
      sections: geometry?.sections ?? [],
      berths: layout.berths,
      nameFor: trackRoleName,
    });

    const onCorridor = new Set(corridor.stations.map((s) => s.crs));

    const trainsByStation = new Map<string, Array<DiagramTrain & { berth: LaidBerth }>>();
    for (const train of data.trains) {
      const berth = berthById.get(train.berthId);
      if (!berth?.crs || !onCorridor.has(berth.crs)) continue;
      const list = trainsByStation.get(berth.crs);
      if (list) list.push({ ...train, berth });
      else trainsByStation.set(berth.crs, [{ ...train, berth }]);
    }

    const signalCounts = new Map<
      string,
      { off: number; red: number; unknown: number; routeSet: number }
    >();
    for (const signal of data.signals) {
      const berth = signal.berthAhead ? berthById.get(signal.berthAhead) : undefined;
      if (!berth?.crs || !onCorridor.has(berth.crs)) continue;
      const counts = signalCounts.get(berth.crs) ?? { off: 0, red: 0, unknown: 0, routeSet: 0 };
      counts[signal.aspect] += 1;
      if (signal.routeSet) counts.routeSet += 1;
      signalCounts.set(berth.crs, counts);
    }

    return { model, trainsByStation, signalCounts };
  }, [berthById, corridorId, data, geometry, layout, variant]);


  const hasBerths = (layout?.berths.length ?? 0) > 0;
  const LABEL_BAND = 70;
  const isBlueprint = Boolean(blueprint);
  const viewBoxWidth = blueprint?.model.width ?? layout?.width ?? 0;
  const viewBoxHeight = blueprint
    ? blueprint.model.height
    : (layout?.height ?? 0) + (placeLabels.length ? LABEL_BAND : 0);
  // Render close to native size (viewBox units are already pixel-scale) rather
  // than stretching to the panel's width — a long corridor stays legible and
  // the board scrolls instead of squashing everything into the panel. The
  // blueprint is the tall one now, so it scrolls vertically; see
  // .sig-board-blueprint in globals.css.
  const SCALE = isBlueprint ? 1 : mode === "inline" ? 0.85 : 1.5;
  const renderWidth = viewBoxWidth * SCALE;
  const renderHeight = viewBoxHeight * SCALE;

  const panel = (
      <div className={`sig-panel${isBlueprint ? " sig-panel-blueprint" : ""}`}>
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
          {onClose && (
            <button type="button" className="sig-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </div>

        <div className={`sig-board${isBlueprint ? " sig-board-blueprint" : ""}`}>
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
              viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
              width={renderWidth}
              height={renderHeight}
              className={`sig-svg${isBlueprint ? " sig-blueprint-svg" : ""}`}
              role="img"
              aria-label="Corridor signalling diagram"
            >
              {blueprint ? (
                <CorridorBlueprint
                  model={blueprint.model}
                  trainsByStation={blueprint.trainsByStation}
                  signalCounts={blueprint.signalCounts}
                />
              ) : (
                <>
                  <g className="sig-area-bands" aria-hidden="true">
                {areaBands.map((band, i) => (
                  <g key={band.area}>
                    <rect
                      x={0}
                      y={Math.max(0, band.minY - 24)}
                      width={layout.width}
                      height={band.maxY - band.minY + 48}
                      className={i % 2 === 0 ? "sig-area-band" : "sig-area-band-alt"}
                    />
                    <text x={8} y={band.minY - 8} className="sig-area-label">
                      {band.area}
                    </text>
                  </g>
                ))}
              </g>
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
                </>
              )}
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
  );

  if (mode === "inline") {
    return (
      <section className="sig-inline" aria-label="Signalling diagram">
        {panel}
      </section>
    );
  }

  return (
    <div className="sig-modal" role="dialog" aria-modal="true" aria-label="Signalling diagram">
      <div className="sig-backdrop" onClick={onClose} />
      {panel}
    </div>
  );
}
