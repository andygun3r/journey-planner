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
}

/** On-demand alternative journeys, fetched when the usual route is disrupted. */
export function BackupRoutes({ originCrs, destCrs, originLabel, destLabel }: Props) {
  const [journeys, setJourneys] = useState<JourneyView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function findRoutes() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/journeys?from=${encodeURIComponent(originCrs)}&to=${encodeURIComponent(destCrs)}`,
      );
      const data = await res.json();
      if (data.ok) {
        setJourneys(data.journeys as JourneyView[]);
      } else {
        setError(
          data.reason === "engine-offline"
            ? "Routing engine is offline right now."
            : "No alternative routes found.",
        );
      }
    } catch {
      setError("Couldn't load alternatives. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="backup-routes">
      <button type="button" className="btn btn-secondary" onClick={findRoutes} disabled={loading}>
        {loading ? "Finding routes…" : "Find another way"}
      </button>

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
