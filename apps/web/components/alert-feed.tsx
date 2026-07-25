"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AlertItem {
  id: string;
  kind: string;
  headline: string;
  detail: string | null;
  direction: string | null;
  createdAt: string;
  seenAt: string | null;
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});

interface Props {
  initialAlerts: AlertItem[];
}

export function AlertFeed({ initialAlerts }: Props) {
  const [alerts, setAlerts] = useState<AlertItem[]>(initialAlerts);
  const esRef = useRef<EventSource | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts");
      if (!res.ok) return;
      const data = (await res.json()) as { alerts: AlertItem[] };
      setAlerts(data.alerts);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    // Prefer the live SSE stream; fall back to polling when unavailable.
    if (typeof window !== "undefined" && "EventSource" in window) {
      const es = new EventSource("/api/commute/stream");
      es.addEventListener("alert", () => void refetch());
      es.onerror = () => {
        es.close();
        esRef.current = null;
      };
      esRef.current = es;
    }
    const poll = setInterval(() => void refetch(), 30_000);
    return () => {
      clearInterval(poll);
      esRef.current?.close();
    };
  }, [refetch]);

  async function dismiss(id: string) {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try {
      await fetch(`/api/alerts/${id}/seen`, { method: "POST" });
    } catch {
      /* the optimistic removal is enough for the UI */
    }
  }

  const unseen = alerts.filter((a) => !a.seenAt);
  if (unseen.length === 0) return null;

  return (
    <section className="alert-feed" aria-label="Commute alerts">
      <h2 className="editor-subhead">Alerts</h2>
      <ul className="alert-list">
        {unseen.map((a) => (
          <li key={a.id} className={`alert-item alert-${a.kind}`}>
            <span className={`chip ${a.kind === "cancellation" ? "chip-danger" : "chip-warn"}`}>
              {a.kind === "cancellation" ? "Cancelled" : "Delayed"}
            </span>
            <div className="alert-body">
              <p className="alert-headline">{a.headline}</p>
              {a.detail && <p className="alert-detail">{a.detail}</p>}
              <p className="alert-time">{timeFmt.format(new Date(a.createdAt))}</p>
            </div>
            <button
              type="button"
              className="btn-link-danger"
              onClick={() => dismiss(a.id)}
              aria-label="Dismiss alert"
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
