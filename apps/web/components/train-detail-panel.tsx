"use client";

import Link from "next/link";
import { useState } from "react";
import { lateLabel, type LiveTrain } from "./map-types";
import { SignallingDiagram } from "./signalling-diagram";

/**
 * Inline detail panel for a selected train: headcode, live status, origin →
 * destination, and its calling points, drawn from the train's `path` (the same
 * data that draws its line). Reuses the service page's `.calls` timeline styling
 * so the two views feel like one product. A link to the full service page keeps
 * formation/coach detail one click away without duplicating it here.
 *
 * "View signalling diagram" opens the Traksy-style corridor board for this
 * train, derived from its TD area(s).
 */

export function TrainDetailPanel({
  train,
  onClose,
}: {
  train: LiveTrain;
  onClose: () => void;
}) {
  const late = lateLabel(train.latenessMinutes);
  const path = train.path ?? [];
  const origin = path[0]?.name ?? train.atName;
  const dest = path[path.length - 1]?.name ?? train.destName;
  // The train sits at the first not-yet-departed stop.
  const currentIndex = path.findIndex((s) => s.status === "current");
  const [showSignalling, setShowSignalling] = useState(false);

  // The diagram resolves the corridor from the train: prefer the NR train id,
  // fall back to the Darwin rid.
  const sigQuery = train.id.startsWith("TD:")
    ? `trainId=${encodeURIComponent(train.id)}`
    : train.rid
      ? `rid=${encodeURIComponent(train.rid)}`
      : `trainId=${encodeURIComponent(train.id)}`;

  return (
    <aside className="map-panel" aria-label="Train details">
      <div className="map-panel-head">
        <div className="map-panel-title">
          <span className="map-panel-code">{train.headcode ?? "Train"}</span>
          {late.text && (
            <span className={`map-tip-late map-tip-late-${late.cls}`}>{late.text}</span>
          )}
        </div>
        <button type="button" className="map-panel-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {(origin || dest) && (
        <p className="map-panel-route">
          <strong>{origin ?? "—"}</strong> → <strong>{dest ?? "—"}</strong>
        </p>
      )}

      {path.length > 1 ? (
        <ol className="calls calls-tracked map-panel-calls">
          {path.map((s, i) => (
            <li key={`${s.crs}-${i}`} className={`call call-${s.status}`}>
              <span className="call-marker" aria-hidden="true">
                {i === currentIndex && (
                  <span className="call-train" role="img" aria-label={`Train approaching ${s.name}`}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                      <path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5V21h2l2-2h4l2 2h2v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4Zm-6 6h5v4H6V8Zm7 0h5v4h-5V8Zm-4.5 9A1.5 1.5 0 1 1 10 15.5 1.5 1.5 0 0 1 8.5 17Zm7 0A1.5 1.5 0 1 1 17 15.5 1.5 1.5 0 0 1 15.5 17Z" />
                    </svg>
                  </span>
                )}
                <span className="call-node" />
              </span>
              <span className="call-time">
                {s.expected ?? s.scheduled ?? "—"}
                {s.expected && s.scheduled && s.expected !== s.scheduled && (
                  <span className="call-sched-was">{s.scheduled}</span>
                )}
              </span>
              <span className="call-name">{s.name}</span>
              <span className="call-status-col">
                {s.status === "departed" ? (
                  <span className="call-status status-departed">Departed</span>
                ) : s.status === "current" ? (
                  <span className="call-status status-current">Now</span>
                ) : (
                  ""
                )}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="map-panel-empty">
          No calling points available for this train yet — it isn’t correlated to a schedule.
        </p>
      )}

      <button
        type="button"
        className="map-panel-signal"
        onClick={() => setShowSignalling(true)}
      >
        View signalling diagram →
      </button>

      {train.rid && (
        <Link className="map-panel-full" href={`/services/${encodeURIComponent(train.rid)}`}>
          Full service page →
        </Link>
      )}

      {showSignalling && (
        <SignallingDiagram
          query={sigQuery}
          title={train.headcode ?? "Train"}
          onClose={() => setShowSignalling(false)}
        />
      )}
    </aside>
  );
}
