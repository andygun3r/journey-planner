import Link from "next/link";
import { AlertFeed } from "@/components/alert-feed";
import { BoardRefresher } from "@/components/board-refresher";
import { CommutePanel } from "@/components/commute-panel";
import { CommuteSwitcher } from "@/components/commute-switcher";
import { DailyFlex } from "@/components/daily-flex";
import { QuickJourneys } from "@/components/quick-journeys";
import { SearchForm } from "@/components/search-form";
import { listAlerts } from "@/lib/alerts";
import { getDashboardData } from "@/lib/commute-dashboard";
import { getUserId } from "@/lib/current-user";
import { serviceIndicatorsByRegion } from "@/lib/disruptions";
import { listFavourites } from "@/lib/favourites";
import { getStations } from "@/lib/stations";
import { activeTsrs } from "@/lib/tsr";

export const dynamic = "force-dynamic";

/** The commute status panel: next trains, alerts, and route disruptions. */
async function CommuteStatus({
  userId,
  commuteId,
  shiftMinutes,
}: {
  userId: string | null;
  commuteId?: string;
  shiftMinutes: number;
}) {
  if (!userId) {
    return (
      <section className="commute-focus">
        <div className="notice">
          <h2>Sign in to set up a commute</h2>
          <p>
            Tell Signaller your weekly schedule and we&rsquo;ll watch your usual trains and warn
            you when they&rsquo;re disrupted.
          </p>
          <p>
            <Link className="btn btn-primary" href="/login">
              Sign in
            </Link>
          </p>
        </div>
      </section>
    );
  }

  const [state, alerts] = await Promise.all([
    getDashboardData(userId, new Date(), commuteId, shiftMinutes),
    listAlerts(userId, { limit: 20 }),
  ]);

  if (state.kind === "no-commute") {
    return (
      <section className="commute-focus">
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
      </section>
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
      <section className="commute-focus">
        <div className="commute-focus-head">
          <h2>{state.commuteLabel}</h2>
          <span className="when">
            <Link href="/commute">details</Link>
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
      </section>
    );
  }

  const { leg } = state;
  return (
    <>
      <AlertFeed initialAlerts={alerts} />
      <section className="commute-focus">
        <div className="commute-focus-head">
          <span className="chip chip-muted">{leg.direction === "am" ? "To work" : "Home"}</span>
          <h2>
            {leg.originLabel} <span className="commute-arrow">→</span> {leg.destLabel}
          </h2>
          <p className="commute-route-crs">
            {leg.originCrs} → {leg.destCrs} · window {leg.windowStart}–{leg.windowEnd} ·{" "}
            <Link href="/commute">details</Link>
          </p>
        </div>

        <CommuteSwitcher
          activeId={state.commuteId}
          activeLabel={state.commuteLabel}
          otherCommutes={state.otherCommutes}
        />

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
          <CommutePanel leg={leg} journeys={state.journeys} />
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
    </>
  );
}

/** Per-operator service status, grouped by Network Rail region. */
async function RegionalDisruptions() {
  const byRegion = await serviceIndicatorsByRegion();
  if (byRegion.size === 0) return null;

  return (
    <section className="dashboard-regions">
      <h2 className="editor-subhead">Service status by region</h2>
      <ul className="dashboard-region-list">
        {[...byRegion.entries()].map(([region, indicators]) => {
          const disrupted = indicators.filter((i) => !i.good);
          return (
            <li key={region} className="dashboard-region">
              <span className={`chip ${disrupted.length === 0 ? "chip-ok" : "chip-warn"}`}>
                {disrupted.length === 0 ? "Good service" : `${disrupted.length} affected`}
              </span>
              <span className="dashboard-region-name">{region}</span>
              {disrupted.length > 0 && (
                <span className="dashboard-region-tocs">
                  {disrupted.map((i) => i.tocName).join(", ")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Active Temporary Speed Restrictions from the NR feed, by route. */
async function SpeedRestrictions() {
  const tsrs = await activeTsrs();
  if (tsrs.length === 0) return null;

  return (
    <section className="dashboard-regions">
      <h2 className="editor-subhead">Speed restrictions</h2>
      <ul className="dashboard-region-list">
        {tsrs.map((tsr) => (
          <li key={tsr.tsrId} className="dashboard-region">
            <span className="chip chip-warn">
              {tsr.passengerSpeedMph !== null ? `${tsr.passengerSpeedMph}mph` : "Restricted"}
            </span>
            <span className="dashboard-region-name">
              {tsr.lineName ?? tsr.routeGroup ?? "Unnamed route"}
            </span>
            <span className="dashboard-region-tocs">
              {tsr.fromStanox ?? "?"} → {tsr.toStanox ?? "?"}
              {tsr.reason ? ` · ${tsr.reason}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ commute?: string; shift?: string }>;
}) {
  // Stations power the empty-state check only; the typeahead fetches from
  // /api/stations on demand, so we don't embed the full list in the client.
  let stationCount = 0;
  let stationsUnavailable = false;
  try {
    stationCount = (await getStations()).length;
  } catch {
    stationsUnavailable = true;
  }

  const userId = await getUserId();
  const favourites = userId ? await listFavourites(userId).catch(() => []) : [];
  const { commute: commuteId, shift } = await searchParams;
  const shiftMinutes = shift ? Number(shift) || 0 : 0;

  return (
    <main className="commute-page">
      <div className="results-head">
        <h1>Dashboard</h1>
        <span className="when">
          <BoardRefresher intervalMs={30_000} />
        </span>
      </div>

      <CommuteStatus userId={userId} commuteId={commuteId} shiftMinutes={shiftMinutes} />

      <section>
        <h2 className="editor-subhead">Plan a journey</h2>
        <SearchForm />
        <QuickJourneys initialFavourites={favourites} />
      </section>

      <RegionalDisruptions />

      <SpeedRestrictions />

      <p className="editor-hint">
        <Link href="/status">Full network status →</Link>
      </p>

      {(stationsUnavailable || stationCount === 0) && (
        <div className="notice">
          <h2>Station data not loaded yet</h2>
          <p>
            The timetable hasn&rsquo;t been imported into the database, so station search
            has nothing to suggest.
          </p>
          <p>
            Run <code>pnpm --filter @signaller/etl exec tsx src/index.ts postprocess</code> to load
            stations and trip mappings, then refresh.
          </p>
        </div>
      )}
    </main>
  );
}
