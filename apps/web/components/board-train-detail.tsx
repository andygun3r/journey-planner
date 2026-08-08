"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ServicePositionMap } from "@/components/service-position-map";

/**
 * The expanded detail for one board row: where the train is in its timetable
 * (Darwin), what it has actually passed (TRUST/TD movements), and where that
 * is on the map.
 *
 * The board already told you a train is "passed Hatfield, 2 late". This answers
 * the follow-up — how far along is that, and what's between it and me — without
 * leaving the board. It reuses the service page's APIs rather than re-querying:
 * the same calling pattern and position history, rendered compactly enough to
 * sit inside a board row.
 *
 * Everything loads on expand, not with the board. A station board is 20+ rows
 * and each panel is two API calls plus a map; fetching those up front would pay
 * for twenty trains to answer a question about one.
 */

/** Mirrors lib/service-details.ts's ServiceCall (client-side subset). */
interface ServiceCall {
  crs?: string;
  name: string;
  scheduled?: string;
  expected?: string;
  platform?: string;
  cancelled: boolean;
  progress?: "departed" | "current" | "upcoming";
  actual?: string;
}

/** Mirrors lib/train-history.ts's PositionHistoryEntry (client-side subset). */
interface PositionHistoryEntry {
  reportedAt: string;
  eventType: string;
  locationName?: string;
  latenessMinutes?: number;
}

interface ServiceResponse {
  ok: boolean;
  service?: { rid?: string; calls: ServiceCall[] };
}

interface HistoryResponse {
  ok: boolean;
  rid?: string;
  entries?: PositionHistoryEntry[];
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/London",
});

function eventLabel(e: string): string {
  if (e === "ARRIVAL") return "Arrived";
  if (e === "DEPARTURE") return "Departed";
  return "Passed";
}

/**
 * The movements bar: the train's last reported points, most recent last, as a
 * horizontal strip. This is the TRUST/TD layer — berth and junction passes the
 * timetable never mentions — so it moves between calling points, which is
 * exactly the gap the board's single position line leaves.
 */
function MovementsBar({ entries }: { entries: PositionHistoryEntry[] }) {
  // Oldest first, and only the tail: the full 12-hour history is far more than
  // a board row can show, and the recent end is the part that answers "where is
  // it now".
  const recent = entries.slice(-8);
  if (recent.length === 0) return null;

  return (
    <div className="bt-movements">
      <h4 className="bt-subhead">Recent movements</h4>
      <ol className="bt-movements-strip">
        {recent.map((e, i) => {
          const last = i === recent.length - 1;
          return (
            <li
              key={`${e.reportedAt}-${e.locationName ?? i}`}
              className={`bt-move ${last ? "bt-move-latest" : ""}`}
            >
              <span className="bt-move-dot" aria-hidden="true" />
              <span className="bt-move-time">{timeFmt.format(new Date(e.reportedAt))}</span>
              <span className="bt-move-place">{e.locationName ?? "On the move"}</span>
              <span className="bt-move-event">
                {eventLabel(e.eventType)}
                {typeof e.latenessMinutes === "number" && e.latenessMinutes > 1
                  ? ` · ${e.latenessMinutes} late`
                  : typeof e.latenessMinutes === "number" && e.latenessMinutes < -1
                    ? ` · ${-e.latenessMinutes} early`
                    : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The calling pattern with a "train is here" marker, from Darwin. Same
 * scheduled-over-live treatment as the service page so the two read alike.
 */
function Timetable({ calls }: { calls: ServiceCall[] }) {
  const currentIndex = calls.findIndex((c) => c.progress === "current");

  return (
    <div className="bt-timetable">
      <h4 className="bt-subhead">Timetable</h4>
      <ol className="bt-calls">
        {calls.map((call, i) => (
          <li
            key={`${call.crs ?? call.name}-${call.scheduled ?? i}`}
            className={`bt-call bt-call-${call.progress ?? "upcoming"} ${
              call.cancelled ? "bt-call-cancelled" : ""
            }`}
          >
            <span className="bt-call-marker" aria-hidden="true">
              <span className="bt-call-node" />
            </span>
            <span className="bt-call-time">
              <span className="bt-call-sched">{call.scheduled ?? "—"}</span>
              {call.actual && call.actual !== call.scheduled && (
                <span className="bt-call-live">{call.actual}</span>
              )}
              {!call.actual && call.expected && call.expected !== call.scheduled && (
                <span className="bt-call-live">{call.expected}</span>
              )}
            </span>
            <span className="bt-call-name">
              {call.name}
              {/* The marker is text, not just the node styling — status is
                  never colour-only (PRODUCT.md). */}
              {i === currentIndex && <span className="bt-call-here"> · train here</span>}
            </span>
            <span className="bt-call-plat">{call.platform ? `Plat ${call.platform}` : ""}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BoardTrainDetail({ serviceId }: { serviceId: string }) {
  const [service, setService] = useState<ServiceResponse | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const encoded = encodeURIComponent(serviceId);

    // Both are best-effort and independent: the timetable is useful without
    // movements, and movements are useful without a resolved map position.
    Promise.allSettled([
      fetch(`/api/services/${encoded}`).then((r) => r.json()),
      fetch(`/api/services/${encoded}/history`).then((r) => r.json()),
    ])
      .then(([s, h]) => {
        if (cancelled) return;
        if (s.status === "fulfilled") setService(s.value as ServiceResponse);
        else setFailed(true);
        if (h.status === "fulfilled") setHistory(h.value as HistoryResponse);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [serviceId]);

  if (failed) {
    return (
      <div className="bt-panel">
        <p className="bt-empty">Couldn&rsquo;t load live detail for this train.</p>
      </div>
    );
  }

  if (!service) {
    return (
      <div className="bt-panel">
        <p className="bt-empty">Loading live detail…</p>
      </div>
    );
  }

  const calls = service.service?.calls ?? [];
  const rid = service.service?.rid;
  const entries = history?.entries ?? [];

  return (
    <div className="bt-panel">
      {calls.length > 0 ? (
        <Timetable calls={calls} />
      ) : (
        <p className="bt-empty">No calling pattern available for this train yet.</p>
      )}

      {entries.length > 0 ? (
        <MovementsBar entries={entries} />
      ) : (
        <p className="bt-empty">
          No Network Rail movement reports yet — this train hasn&rsquo;t been matched to a live
          position.
        </p>
      )}

      {/* The map only means anything once the train is correlated to a rid;
          without one there is no position to plot. */}
      {rid && (
        <div className="bt-map">
          <h4 className="bt-subhead">Position</h4>
          <ServicePositionMap rid={rid} />
        </div>
      )}

      <Link className="bt-full" href={`/services/${encodeURIComponent(serviceId)}`}>
        Full service page →
      </Link>
    </div>
  );
}
