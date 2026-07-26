"use client";

import { useEffect, useState } from "react";
import { SignallingDiagram } from "./signalling-diagram";

/** Mirrors apps/web/lib/train-history.ts's PositionHistoryEntry (client-side type only). */
interface PositionHistoryEntry {
  reportedAt: string;
  eventType: string;
  locationName?: string;
  latenessMinutes?: number;
  scheduled?: { crs: string; time: string } | null;
}

interface HistoryResponse {
  ok: boolean;
  rid?: string;
  entries?: PositionHistoryEntry[];
  reason?: string;
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Europe/London",
});

function eventLabel(e: string): string {
  if (e === "ARRIVAL") return "Arrived";
  if (e === "DEPARTURE") return "Departed";
  return "Passed";
}

/**
 * The service-detail page's "advanced view": a timestamped list of every
 * junction/berth actually passed (from the new position-history table),
 * alongside the existing live signalling-diagram corridor view — composed
 * side by side rather than merged, so each stays focused on what it's good
 * at (historical breadcrumb vs. live corridor state).
 */
export function ServiceAdvancedView({ serviceId, rid }: { serviceId: string; rid: string }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [showSignalling, setShowSignalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/services/${encodeURIComponent(serviceId)}/history`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) setData(json as HistoryResponse);
      })
      .catch(() => {
        if (!cancelled) setData({ ok: false });
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId]);

  const entries = data?.entries ?? [];

  return (
    <div className="advanced-view">
      <div className="advanced-view-history">
        <p className="formation-head">Junction &amp; berth history</p>
        {!data ? (
          <p className="notice-muted">Loading position history…</p>
        ) : entries.length === 0 ? (
          <p className="notice-muted">
            No position reports recorded yet for this run — Network Rail history builds up as the
            train moves, so a service near the start of its journey may not have any yet.
          </p>
        ) : (
          <ol className="calls history-calls">
            {entries.map((e, i) => (
              <li key={i} className="call">
                <span className="call-time">{timeFmt.format(new Date(e.reportedAt))}</span>
                <span className="call-name">{e.locationName ?? "Unnamed berth"}</span>
                <span className="call-status-col">
                  <span className="call-status status-scheduled">{eventLabel(e.eventType)}</span>
                  {e.scheduled && (
                    <span className="board-status-sub">sched. {e.scheduled.time}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <button
        type="button"
        className="map-panel-signal"
        onClick={() => setShowSignalling(true)}
      >
        View live signalling diagram →
      </button>

      {showSignalling && (
        <SignallingDiagram
          query={`rid=${encodeURIComponent(rid)}`}
          title="Signalling"
          onClose={() => setShowSignalling(false)}
        />
      )}
    </div>
  );
}
