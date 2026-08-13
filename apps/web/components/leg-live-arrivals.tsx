"use client";

import { useEffect, useState } from "react";

/**
 * Live next-departures for the boarding stop of a selected TfL leg.
 *
 * A planned journey says "catch the Victoria line at 08:14". This answers the
 * question you actually have standing on the platform — when is the next one,
 * really. Rail legs already have this via the departure boards, so it's only
 * mounted for tube/bus/DLR/Overground/tram legs.
 *
 * Fails quietly: if TfL isn't configured or the call fails, the leg detail
 * simply shows without a live section rather than surfacing an error.
 */

interface Prediction {
  lineName: string;
  destinationName?: string;
  platformName?: string;
  timeToStation: number;
}

const POLL_MS = 30_000;
const MAX_SHOWN = 3;

/** "Due" under a minute, else whole minutes — matches how TfL's own boards read. */
function countdown(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? "Due" : `${minutes} min`;
}

interface Props {
  naptanId: string;
  /** Only predictions for this line are shown, when known. */
  lineId?: string;
}

export function LegLiveArrivals({ naptanId, lineId }: Props) {
  const [predictions, setPredictions] = useState<Prediction[] | null>(null);

  useEffect(() => {
    if (!naptanId) return;
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch(`/api/tfl-stop-arrivals/${encodeURIComponent(naptanId)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { arrivals?: (Prediction & { lineId?: string })[] };
        if (cancelled) return;
        const all = data.arrivals ?? [];
        // Filter to this leg's line where we know it — a Victoria line leg
        // shouldn't list Circle line trains at the same interchange.
        const mine = lineId ? all.filter((a) => a.lineId === lineId) : all;
        setPredictions((mine.length > 0 ? mine : all).slice(0, MAX_SHOWN));
      } catch {
        // Aborted or failed — leave whatever was last shown.
      }
    }

    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [naptanId, lineId]);

  if (!predictions || predictions.length === 0) return null;

  return (
    <div className="leg-live" aria-live="polite">
      <p className="leg-live-title">Next departures</p>
      <ul className="leg-live-list">
        {predictions.map((p, i) => (
          <li key={i}>
            <span className="leg-live-dest">
              {p.destinationName ?? p.lineName}
              {p.platformName ? ` · ${p.platformName}` : ""}
            </span>
            <span className="leg-live-time">{countdown(p.timeToStation)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
