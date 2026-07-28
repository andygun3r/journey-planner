"use client";

import { useEffect, useState } from "react";
import { LiveCountdown } from "./live-countdown";

/**
 * Live map's "click a bus/tube/DLR stop" panel: next departures at that
 * stop, reusing the same TfL Arrivals feed live-map.tsx's approximate bus
 * layer already polls (lib/tfl.ts's arrivals()), just scoped to one stop and
 * shown as a list instead of plotted positions.
 */

interface TflStopArrival {
  lineName: string;
  destinationName?: string;
  timeToStation: number;
  expectedArrival?: string;
}

const POLL_MS = 20_000;

export function BusStopPanel({
  stop,
  onClose,
}: {
  stop: { naptanId: string; commonName: string };
  onClose: () => void;
}) {
  const [arrivals, setArrivals] = useState<TflStopArrival[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!stop.naptanId) return;
    let cancelled = false;

    const fetchArrivals = () => {
      fetch(`/api/tfl-stop-arrivals/${encodeURIComponent(stop.naptanId)}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { arrivals: [] }))
        .then((json: { arrivals: TflStopArrival[] }) => {
          if (cancelled) return;
          setArrivals(json.arrivals ?? []);
          setError(false);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    };

    fetchArrivals();
    const id = setInterval(fetchArrivals, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stop.naptanId]);

  return (
    <aside className="map-panel" aria-label="Stop departures">
      <div className="map-panel-head">
        <div className="map-panel-title">
          <span className="map-panel-code">{stop.commonName || "Stop"}</span>
        </div>
        <button type="button" className="map-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {error ? (
        <p className="map-panel-empty">Couldn&rsquo;t load departures for this stop.</p>
      ) : arrivals === null ? (
        <p className="map-panel-empty">Loading departures…</p>
      ) : arrivals.length === 0 ? (
        <p className="map-panel-empty">No departures currently predicted for this stop.</p>
      ) : (
        <ol className="map-panel-departures">
          {arrivals.slice(0, 12).map((a, i) => (
            <li key={`${a.lineName}-${a.expectedArrival ?? i}`} className="map-panel-departure">
              <span className="map-panel-departure-line">{a.lineName}</span>
              <span className="map-panel-departure-dest">{a.destinationName ?? "—"}</span>
              {a.expectedArrival ? (
                <LiveCountdown iso={a.expectedArrival} />
              ) : (
                <span className="countdown">{Math.round(a.timeToStation / 60)} mins</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
