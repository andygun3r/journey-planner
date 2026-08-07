"use client";

import { useState } from "react";
import type { JourneyView } from "@/lib/journeys";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});
const t = (iso: string) => timeFmt.format(new Date(iso));

interface Props {
  originCrs: string;
  destCrs: string;
  originLabel: string;
  destLabel: string;
  /** The user's configured backup station(s) for this leg, if any. Still always live-replanned. */
  backupOriginCrs?: string;
  backupDestCrs?: string;
  backupNote?: string;
  /** Called when the user picks a result to follow instead of the primary journey. */
  onSwitch?: (journey: JourneyView | null) => void;
  activeJourneyId?: string;
}

/** On-demand alternative journeys, fetched when the usual route is disrupted. */
export function BackupRoutes({
  originCrs,
  destCrs,
  originLabel,
  destLabel,
  backupOriginCrs,
  backupDestCrs,
  backupNote,
  onSwitch,
  activeJourneyId,
}: Props) {
  const [journeys, setJourneys] = useState<JourneyView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingBackup, setUsingBackup] = useState(false);

  const hasConfiguredBackup = Boolean(backupOriginCrs && backupDestCrs);

  async function findRoutes(fromCrs: string, toCrs: string, viaBackup: boolean) {
    setLoading(true);
    setError(null);
    setUsingBackup(viaBackup);
    try {
      const res = await fetch(
        `/api/journeys?from=${encodeURIComponent(fromCrs)}&to=${encodeURIComponent(toCrs)}`,
      );
      const data = await res.json();
      if (data.ok) {
        setJourneys(data.journeys as JourneyView[]);
      } else {
        setJourneys(null);
        setError(
          data.reason === "engine-offline"
            ? "Routing engine is offline right now."
            : "No alternative routes found.",
        );
      }
    } catch {
      setJourneys(null);
      setError("Couldn't load alternatives. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="backup-routes">
      <div className="backup-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => findRoutes(originCrs, destCrs, false)}
          disabled={loading}
        >
          {loading && !usingBackup ? "Finding routes…" : "Find another way"}
        </button>
        {hasConfiguredBackup && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => findRoutes(backupOriginCrs!, backupDestCrs!, true)}
            disabled={loading}
          >
            {loading && usingBackup
              ? "Checking backup…"
              : `Your usual backup${backupNote ? ` — ${backupNote}` : ""}`}
          </button>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {journeys && journeys.length > 0 && (
        <ol className="backup-list" aria-label={`Alternative routes ${originLabel} to ${destLabel}`}>
          {journeys.map((j) => (
            <li key={j.id} className="backup-row">
              <span className="backup-times">
                {t(j.departs)} → {t(j.arrives)}
              </span>
              <span className="backup-meta">
                {j.durationMinutes}m ·{" "}
                {j.changes === 0 ? "direct" : `${j.changes} change${j.changes === 1 ? "" : "s"}`}
              </span>
              {j.status === "cancelled" && <span className="chip chip-danger">Cancelled</span>}
              {j.status === "delayed" && <span className="chip chip-warn">+{j.delayMinutes}m</span>}
              {onSwitch && (
                <button
                  type="button"
                  className={`btn-link ${activeJourneyId === j.id ? "backup-switch-active" : ""}`}
                  onClick={() => onSwitch(activeJourneyId === j.id ? null : j)}
                >
                  {activeJourneyId === j.id ? "Following this route" : "Switch to this route"}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {journeys && journeys.length === 0 && (
        <p className="editor-hint">No alternative routes found right now.</p>
      )}
    </div>
  );
}
