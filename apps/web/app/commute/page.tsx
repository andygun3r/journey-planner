import Link from "next/link";
import { AlertFeed } from "@/components/alert-feed";
import { BackupRoutes } from "@/components/backup-routes";
import { BoardRefresher } from "@/components/board-refresher";
import { PushToggle } from "@/components/push-toggle";
import { listAlerts } from "@/lib/alerts";
import { getDashboardData } from "@/lib/commute-dashboard";
import { requireDevice } from "@/lib/device";
import type { JourneyView } from "@/lib/journeys";
import { hasPushSubscription, vapidPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});
const t = (iso: string) => timeFmt.format(new Date(iso));

function StatusChip({ j }: { j: JourneyView }) {
  switch (j.status) {
    case "cancelled":
      return <span className="chip chip-danger">Cancelled</span>;
    case "delayed":
      return <span className="chip chip-warn">+{j.delayMinutes} min</span>;
    case "on-time":
      return <span className="chip chip-ok">On time</span>;
    default:
      return <span className="chip chip-muted">Scheduled</span>;
  }
}

/** The trains to catch for one journey option — inline, with change notes. */
function JourneyLegs({ journey }: { journey: JourneyView }) {
  // Drop same-station walk "legs" (pure transfer time; the change note covers it).
  const legs = journey.legs.filter(
    (leg) => !(leg.mode === "walk" && leg.originCrs === leg.destCrs),
  );
  return (
    <div className="commute-legs">
      {legs.map((leg, i) => (
        <div key={i}>
          {i > 0 && !leg.staySeated && leg.mode === "rail" && (
            <p className="change-note">Change at {leg.originName}</p>
          )}
          {leg.staySeated && (
            <p className="change-note">Stay seated — train continues as one service</p>
          )}
          <div className={`leg ${leg.mode === "walk" ? "leg-walk" : ""}`}>
            <div className="leg-times">
              <span>{t(leg.departs)}</span>
              <span>{t(leg.arrives)}</span>
            </div>
            <div className="leg-body">
              <p className="leg-station">{leg.originName}</p>
              <p className="leg-operator">
                {leg.mode === "walk"
                  ? "Walk"
                  : (leg.operator ?? "Rail service") +
                    (leg.callCount > 0
                      ? ` · ${leg.callCount} stop${leg.callCount === 1 ? "" : "s"}`
                      : " · non-stop")}
              </p>
              <p className="leg-station">{leg.destName}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The next real departures along the active leg, first one highlighted. Each
 * row expands in place to show the exact trains to catch for that option
 * (including any changes) — the services needed to follow the commute.
 */
function Departures({ journeys }: { journeys: JourneyView[] }) {
  if (journeys.length === 0) {
    return (
      <p className="editor-hint">
        No upcoming trains found for this leg right now. Try the full planner.
      </p>
    );
  }
  return (
    <ol className="commute-departures">
      {journeys.map((j, i) => {
        const disrupted = j.status === "cancelled";
        return (
          <li
            key={j.id}
            className={`commute-dep ${i === 0 && !disrupted ? "commute-dep-next" : ""} ${
              disrupted ? "commute-dep-cancelled" : ""
            }`}
          >
            <details open={i === 0}>
              <summary className="commute-dep-link">
                <span className="commute-dep-time">
                  {t(j.departs)}
                  {j.liveDeparts && j.status === "delayed" && (
                    <span className="live-late"> → {t(j.liveDeparts)}</span>
                  )}
                </span>
                <span className="commute-dep-arrive">arr {t(j.arrives)}</span>
                <span className="commute-dep-meta">
                  {j.changes === 0 ? "direct" : `${j.changes} change${j.changes === 1 ? "" : "s"}`}{" "}
                  · {j.durationMinutes}m
                </span>
                {i === 0 && !disrupted && <span className="commute-dep-catch">catch this</span>}
                <StatusChip j={j} />
                <span className="commute-dep-chevron" aria-hidden="true">▸</span>
              </summary>
              <JourneyLegs journey={j} />
            </details>
          </li>
        );
      })}
    </ol>
  );
}

export default async function CommuteDashboardPage() {
  const deviceId = await requireDevice();
  const [state, alerts, pushOn] = await Promise.all([
    getDashboardData(deviceId),
    listAlerts(deviceId, { limit: 20 }),
    hasPushSubscription(deviceId),
  ]);
  const vapid = vapidPublicKey();

  if (state.kind === "no-commute") {
    return (
      <main className="commute-page">
        <div className="results-head">
          <h1>My commute</h1>
        </div>
        <div className="notice">
          <h2>Set up your commute</h2>
          <p>
            Tell Mainline your weekly schedule — where you travel each day and roughly when — and
            we&rsquo;ll watch your usual trains and warn you when they&rsquo;re disrupted.
          </p>
          <p>
            <Link className="btn btn-primary" href="/commute/edit">
              Create a commute
            </Link>
          </p>
        </div>
      </main>
    );
  }

  if (state.kind === "no-active") {
    const message =
      state.reason === "holiday"
        ? "You're on holiday today — enjoy the break. Alerts are paused."
        : state.reason === "no-leg-today"
          ? "No commute scheduled for today."
          : "You're done for today. Nothing more scheduled on this commute.";
    return (
      <main className="commute-page">
        <div className="results-head">
          <h1>{state.commuteLabel}</h1>
          <span className="when">
            <Link href="/commute/edit">edit</Link> · <Link href="/commute/holidays">holidays</Link>
          </span>
        </div>
        <div className="notice">
          <h2>Nothing right now</h2>
          <p>{message}</p>
        </div>
      </main>
    );
  }

  const { leg } = state;
  return (
    <main className="commute-page">
      <div className="results-head">
        <h1>{state.commuteLabel}</h1>
        <span className="when">
          <BoardRefresher intervalMs={30_000} /> · <Link href="/commute/edit">edit</Link> ·{" "}
          <Link href="/commute/holidays">holidays</Link>
        </span>
      </div>

      <AlertFeed initialAlerts={alerts} />

      <section className="commute-focus">
        <div className="commute-focus-head">
          <span className={`commute-dir chip ${leg.direction === "am" ? "chip-muted" : "chip-muted"}`}>
            {leg.direction === "am" ? "To work" : "Home"}
          </span>
          <h2>
            {leg.originLabel} <span className="commute-arrow">→</span> {leg.destLabel}
          </h2>
          <p className="commute-route-crs">
            {leg.originCrs} → {leg.destCrs} · window {leg.windowStart}–{leg.windowEnd}
          </p>
        </div>

        {state.engineOffline ? (
          <div className="notice notice-danger">
            <h2>Live routing is offline</h2>
            <p>Mainline couldn&rsquo;t reach the routing engine to show your next trains.</p>
          </div>
        ) : (
          <Departures journeys={state.journeys} />
        )}
      </section>

      {state.disruptions.length > 0 && (
        <section className="commute-disruptions">
          <h2 className="editor-subhead">Disruptions on your route</h2>
          <ul className="commute-disruption-list">
            {state.disruptions.map((d) => (
              <li key={d.id} className="commute-disruption">
                <span className="chip chip-warn">{d.planned ? "Planned" : "Disruption"}</span>
                <span>{d.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="commute-backup">
        <p className="editor-hint">Train cancelled or delayed? See other ways to get there.</p>
        <BackupRoutes
          originCrs={leg.originCrs}
          destCrs={leg.destCrs}
          originLabel={leg.originLabel}
          destLabel={leg.destLabel}
        />
        {vapid && (
          <div className="commute-push">
            <PushToggle vapidPublicKey={vapid} initiallySubscribed={pushOn} />
          </div>
        )}
      </section>
    </main>
  );
}
