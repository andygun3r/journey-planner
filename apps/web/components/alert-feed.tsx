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
    // The live stream is the normal path; polling is what happens when it
    // isn't working.
    //
    // Both used to run at once. The 30s interval was started unconditionally,
    // outside the EventSource branch, so every open tab held a stream AND
    // polled twice a minute. And `onerror` closed the stream without ever
    // reopening it, so after one network blip a tab was on polling for good
    // with no way back.
    let stopped = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const startPolling = () => {
      if (stopped || poll) return;
      poll = setInterval(() => void refetch(), 30_000);
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

      const es = new EventSource("/api/commute/stream");
      esRef.current = es;

      // Connected: the stream is doing the work, so stand the poll down. Also
      // refetch once, in case an alert landed while we were disconnected.
      es.addEventListener("ready", () => {
        attempt = 0;
        stopPolling();
        void refetch();
      });

      // The server sends this when it has no Redis or no device identity —
      // polling is the only option, and retrying the stream won't help.
      es.addEventListener("unavailable", () => {
        es.close();
        esRef.current = null;
        startPolling();
      });

      es.addEventListener("alert", () => void refetch());

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (stopped) return;
        // Cover the gap with polling, then try the stream again, backing off
        // to at most a minute so a long outage doesn't hammer the server.
        startPolling();
        attempt += 1;
        const delay = Math.min(1000 * 2 ** attempt, 60_000);
        reconnect = setTimeout(open, delay);
      };
    };

    open();

    return () => {
      stopped = true;
      stopPolling();
      if (reconnect) clearTimeout(reconnect);
      esRef.current?.close();
      esRef.current = null;
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
