import Link from "next/link";
import { AlertFeed } from "@/components/alert-feed";
import { BackupRoutes } from "@/components/backup-routes";
import { BoardRefresher } from "@/components/board-refresher";
import { Departures } from "@/components/commute-departures";
import { PushToggle } from "@/components/push-toggle";
import { listAlerts } from "@/lib/alerts";
import { getDashboardData } from "@/lib/commute-dashboard";
import { requireDevice } from "@/lib/device";
import { hasPushSubscription, vapidPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";

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
