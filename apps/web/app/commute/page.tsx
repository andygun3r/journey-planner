import Link from "next/link";
import { redirect } from "next/navigation";
import { AdHocCommuteStart } from "@/components/ad-hoc-commute-start";
import { AlertFeed } from "@/components/alert-feed";
import { BoardRefresher } from "@/components/board-refresher";
import { CommutePanel } from "@/components/commute-panel";
import { CommuteRunControl } from "@/components/commute-run-control";
import { CommuteSwitcher } from "@/components/commute-switcher";
import { DailyFlex } from "@/components/daily-flex";
import { listAlerts } from "@/lib/alerts";
import { getDashboardData } from "@/lib/commute-dashboard";
import { getUserId } from "@/lib/current-user";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ commute?: string; shift?: string }>;
}

export default async function CommuteDashboardPage({ searchParams }: Props) {
  const userId = await getUserId();
  if (!userId) redirect("/login");
  const { commute: commuteId, shift } = await searchParams;
  const shiftMinutes = shift ? Number(shift) || 0 : 0;

  const [state, alerts] = await Promise.all([
    getDashboardData(userId, new Date(), commuteId, shiftMinutes),
    listAlerts(userId, { limit: 20 }),
  ]);

  if (state.kind === "no-commute") {
    return (
      <main className="commute-page">
        <div className="results-head">
          <h1>My commute</h1>
        </div>
        <div className="notice">
          <h2>Set up your commute</h2>
          <p>
            Tell Signaller your weekly schedule — where you travel each day and roughly when — and
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
        : state.reason === "skipped"
          ? "You've marked today as not travelling on this commute."
          : state.reason === "no-leg-today"
            ? "No commute scheduled for today."
            : "You're done for today. Nothing more scheduled on this commute.";
    return (
      <main className="commute-page">
        <div className="results-head">
          <h1>{state.commuteLabel}</h1>
          <span className="when">
            <Link href="/commute/edit">edit</Link> · <Link href="/commute/list">manage</Link> ·{" "}
            <Link href="/commute/calendar">calendar</Link> ·{" "}
          <Link href="/commute/holidays">holidays</Link>
          </span>
        </div>
        <CommuteSwitcher
          activeId={state.commuteId}
          activeLabel={state.commuteLabel}
          otherCommutes={state.otherCommutes}
        />
        <div className="notice">
          <h2>Nothing right now</h2>
          <p>{message}</p>
        </div>
        {state.quickStart && <AdHocCommuteStart quickStart={state.quickStart} />}
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
          <Link href="/commute/list">manage</Link> · <Link href="/commute/calendar">calendar</Link> ·{" "}
          <Link href="/commute/holidays">holidays</Link>
        </span>
      </div>

      <CommuteSwitcher
        activeId={state.commuteId}
        activeLabel={state.commuteLabel}
        otherCommutes={state.otherCommutes}
      />

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
            {leg.originCrs} → {leg.destCrs}
            {/* A started run widens the window to the whole day (it's the run,
                not the clock, holding this leg on screen), so printing
                "00:00–23:59" here would be noise. */}
            {!state.run && ` · window ${leg.windowStart}–${leg.windowEnd}`}
          </p>
        </div>

        {leg.upcoming && <DailyFlex shiftMinutes={shiftMinutes} />}

        {state.pinStaleNotice && (
          <div className="notice notice-warn">
            <p>{state.pinStaleNotice.headline}</p>
            <p className="editor-hint">
              <Link href="/commute/edit">Edit this commute</Link> to pick a new service.
            </p>
          </div>
        )}

        {state.engineOffline ? (
          <div className="notice notice-danger">
            <h2>Live routing is offline</h2>
            <p>Signaller couldn&rsquo;t reach the routing engine to show your next trains.</p>
          </div>
        ) : (
          <>
            <CommuteRunControl
              commuteId={state.commuteId}
              leg={leg}
              journey={state.journeys[0]}
              activeRun={state.run ? { id: state.run.id, startedAt: state.run.startedAt } : undefined}
            />
            <CommutePanel leg={leg} journeys={state.journeys} />
          </>
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

    </main>
  );
}
