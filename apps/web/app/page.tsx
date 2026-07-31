import Link from "next/link";
import { AlertFeed } from "@/components/alert-feed";
import { BoardRefresher } from "@/components/board-refresher";
import { Departures } from "@/components/commute-departures";
import { QuickJourneys } from "@/components/quick-journeys";
import { SearchForm } from "@/components/search-form";
import { listAlerts } from "@/lib/alerts";
import { getDashboardData } from "@/lib/commute-dashboard";
import { requireDevice } from "@/lib/device";
import { serviceIndicatorsByRegion } from "@/lib/disruptions";
import { listFavourites } from "@/lib/favourites";
import { getStations } from "@/lib/stations";

export const dynamic = "force-dynamic";

/** The commute status panel: next trains, alerts, and route disruptions. */
async function CommuteStatus({ deviceId }: { deviceId: string }) {
  const [state, alerts] = await Promise.all([
    getDashboardData(deviceId),
    listAlerts(deviceId, { limit: 20 }),
  ]);

  if (state.kind === "no-commute") {
    return (
      <section className="commute-focus">
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

export default async function Home() {
  // Stations power the empty-state check only; the typeahead fetches from
  // /api/stations on demand, so we don't embed the full list in the client.
  let stationCount = 0;
  let stationsUnavailable = false;
  try {
    stationCount = (await getStations()).length;
  } catch {
    stationsUnavailable = true;
  }

  const deviceId = await requireDevice();
  const favourites = await listFavourites(deviceId).catch(() => []);

  return (
    <main className="commute-page">
      <div className="results-head">
        <h1>Dashboard</h1>
        <span className="when">
          <BoardRefresher intervalMs={30_000} />
        </span>
      </div>

      <CommuteStatus deviceId={deviceId} />

      <section>
        <h2 className="editor-subhead">Plan a journey</h2>
        <SearchForm />
        <QuickJourneys initialFavourites={favourites} />
      </section>

      <RegionalDisruptions />

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
            Run <code>docker compose --profile etl run --rm etl postprocess</code> to load
            stations and trip mappings, then refresh.
          </p>
        </div>
      )}
    </main>
  );
}
