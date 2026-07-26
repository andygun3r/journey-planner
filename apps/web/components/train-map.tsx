"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { projectGeographic } from "../lib/map-projection";
import { MapCanvas } from "./map-canvas";
import { type LiveTrainsResult } from "./map-types";
import { TrainDetailPanel } from "./train-detail-panel";

/**
 * Live GB train map. Fetches Network Rail positions every 15s and plots them on
 * a coordinate-projected SVG (looks like the UK). Route lines come from each
 * train's calling-point path; clicking a train pins a detail panel with its
 * calling points, from which the signalling diagram can be opened.
 */

export function TrainMap({ stations }: { stations: Array<[number, number]> }) {
  const [data, setData] = useState<LiveTrainsResult | null>(null);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const trains = useMemo(() => data?.trains ?? [], [data]);
  // Re-resolve the selected train from the freshest poll so the panel updates.
  const selected = useMemo(
    () => (selectedId ? (trains.find((t) => t.id === selectedId) ?? null) : null),
    [trains, selectedId],
  );

  return (
    <div className={`map-wrap${selected ? " map-wrap-open" : ""}`}>
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
      </div>

      <div className="map-stage">
        <div className="map-canvas-slot">
          <MapCanvas
            stations={stations}
            trains={trains}
            project={projectGeographic}
            selectedId={selectedId}
            onSelect={(t) => setSelectedId(t?.id ?? null)}
          />
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

        {selected && (
          <TrainDetailPanel train={selected} onClose={() => setSelectedId(null)} />
        )}
      </div>

      <p className="map-legend">
        <span className="map-key map-key-ontime">On time</span>
        <span className="map-key map-key-late">Late</span>
        <span className="map-key map-key-early">Early</span>
        <span className="map-legend-note">
          Positions and lines from Network Rail TRUST &amp; Train Describer — timing-point derived,
          not GPS. Drag to pan, scroll to zoom, click a train for calling points.
        </span>
      </p>
    </div>
  );
}
