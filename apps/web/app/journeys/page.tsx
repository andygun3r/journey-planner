import Link from "next/link";
import { isCrs, normaliseCrs } from "@mainline/shared";
import { FavouriteToggle } from "@/components/favourite-toggle";
import { getUserId } from "@/lib/current-user";
import { indicativeFare, formatFare } from "@/lib/fares";
import { isFavourite, touchFavourite } from "@/lib/favourites";
import { planJourneys, type JourneyView } from "@/lib/journeys";
import { stationName } from "@/lib/stations";

export const dynamic = "force-dynamic";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});

const whenFmt = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});

function t(iso: string): string {
  return timeFmt.format(new Date(iso));
}

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Days between two instants in UK local calendar terms (for "+1" markers). */
function dayOffset(fromIso: string, toIso: string): number {
  const a = dayFmt.format(new Date(fromIso));
  const b = dayFmt.format(new Date(toIso));
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function StatusChip({ journey }: { journey: JourneyView }) {
  switch (journey.status) {
    case "cancelled":
      return <span className="chip chip-danger">Cancelled</span>;
    case "delayed":
      return <span className="chip chip-warn">+{journey.delayMinutes} min</span>;
    case "on-time":
      return <span className="chip chip-ok">On time</span>;
    default:
      return <span className="chip chip-muted">Scheduled</span>;
  }
}

function Duration({ minutes }: { minutes: number }) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return <>{h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`}</>;
}

function LegRows({ journey }: { journey: JourneyView }) {
  // Same-station walk "legs" are just transfer time; the change note covers it.
  const legs = journey.legs.filter(
    (leg) => !(leg.mode === "walk" && leg.originCrs === leg.destCrs),
  );
  return (
    <div className="journey-detail">
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
              {leg.mode === "walk" ? (
                <p className="leg-operator">Walk</p>
              ) : (
                <p className="leg-operator">
                  <Link
                    className="leg-live-link"
                    href={`/boards/${leg.originCrs}?callingAt=${leg.destCrs}`}
                    aria-label={`Live departures from ${leg.originName} towards ${leg.destName}`}
                  >
                    {(leg.operator ?? "Rail service") +
                      (leg.callCount > 0
                        ? ` · ${leg.callCount} stop${leg.callCount === 1 ? "" : "s"}`
                        : " · non-stop")}
                    <span aria-hidden="true"> · live ›</span>
                  </Link>
                </p>
              )}
              <p className="leg-station">{leg.destName}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default async function JourneysPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; when?: string; arriveBy?: string }>;
}) {
  const params = await searchParams;
  const from = params.from ?? "";
  const to = params.to ?? "";
  const when = params.when;
  const arriveBy = params.arriveBy === "1";

  const outcome = await planJourneys(from, to, when, arriveBy);
  const [fromName, toName] = await Promise.all([stationName(from), stationName(to)]);

  // Save/recall support: only for a valid station pair.
  const validPair = isCrs(from.toUpperCase()) && isCrs(to.toUpperCase()) && from !== to;
  let saved = false;
  let fare: Awaited<ReturnType<typeof indicativeFare>> = null;
  if (validPair) {
    const fromC = normaliseCrs(from);
    const toC = normaliseCrs(to);
    // Favouriting needs a signed-in user; search itself stays open to anyone.
    const userId = await getUserId();
    if (userId) {
      saved = await isFavourite(userId, fromC, toC);
      // Bump ordering if this journey is already saved (they're re-running it).
      if (saved) await touchFavourite(userId, fromC, toC);
    }
    // Indicative fare (null when fares aren't loaded — UI just omits it).
    fare = await indicativeFare(fromC, toC).catch(() => null);
  }

  const cheapestPence = fare
    ? Math.min(fare.singlePence ?? Infinity, fare.returnPence ?? Infinity)
    : Infinity;

  return (
    <main>
      <div className="results-head">
        <h1>
          {fromName} → {toName}
        </h1>
        <span className="when">
          {when
            ? `${arriveBy ? "arrive by" : "leave"} ${whenFmt.format(new Date(when))}`
            : "leaving now"}{" "}
          · <Link href="/">change</Link>
          {validPair && (
            <>
              {" · "}
              <FavouriteToggle
                fromCrs={normaliseCrs(from)}
                toCrs={normaliseCrs(to)}
                initialSaved={saved}
              />
            </>
          )}
          {Number.isFinite(cheapestPence) && (
            <span className="fare-chip" title="Indicative walk-up fare — cheapest standard single/return">
              from {formatFare(cheapestPence)}
            </span>
          )}
        </span>
      </div>

      {!outcome.ok && outcome.reason === "engine-offline" && (
        <div className="notice notice-danger">
          <h2>Routing engine is offline</h2>
          <p>
            Mainline couldn&rsquo;t reach MOTIS to compute journeys. If you&rsquo;re running
            locally, make sure the motis container is up (see README) and try again.
          </p>
        </div>
      )}

      {!outcome.ok && outcome.reason === "bad-request" && (
        <div className="notice">
          <h2>That search didn&rsquo;t make sense</h2>
          <p>
            Origin and destination need to be valid stations.{" "}
            <Link href="/">Start a new search</Link>.
          </p>
        </div>
      )}

      {!outcome.ok && outcome.reason === "no-journeys" && (
        <div className="notice">
          <h2>No journeys found</h2>
          <p>
            Nothing between these stations around that time. Try a different time, or
            check the stations are right.
          </p>
        </div>
      )}

      {outcome.ok && (
        <ol className="journey-list">
          {outcome.journeys.map((journey) => (
            <li key={journey.id} className="journey-row">
              <details>
                <summary className="journey-summary">
                  <span className="jtime">
                    {t(journey.departs)}
                    {journey.liveDeparts && journey.status === "delayed" && (
                      <span className="live-late">→ {t(journey.liveDeparts)}</span>
                    )}
                  </span>
                  <span className="jmid">
                    <span className="jroute">
                      {journey.legs
                        .filter((l) => l.mode === "rail")
                        .map((l) => l.originName)
                        .join(" · ")}
                      {" → "}
                      {journey.legs[journey.legs.length - 1]?.destName}
                    </span>
                    <span className="jmeta jmeta-duration">
                      <strong>
                        <Duration minutes={journey.durationMinutes} />
                      </strong>{" "}
                      ·{" "}
                      {journey.changes === 0
                        ? "direct"
                        : `${journey.changes} change${journey.changes === 1 ? "" : "s"}`}
                    </span>
                  </span>
                  <span className="jtime">
                    {t(journey.arrives)}
                    {dayOffset(journey.departs, journey.arrives) > 0 && (
                      <span
                        className="day-offset"
                        aria-label={`arrives ${dayOffset(journey.departs, journey.arrives)} day later`}
                      >
                        +{dayOffset(journey.departs, journey.arrives)}
                      </span>
                    )}
                  </span>
                  <StatusChip journey={journey} />
                </summary>
                <LegRows journey={journey} />
              </details>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
