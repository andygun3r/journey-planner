import Link from "next/link";
import { notFound } from "next/navigation";
import { BoardFilter } from "@/components/board-filter";
import { BoardRefresher } from "@/components/board-refresher";
import { LiveCountdown } from "@/components/live-countdown";
import { StationSignallingButton } from "@/components/station-signalling-button";
import { type BoardDeparture } from "@/lib/board";
import { cachedBoard } from "@/lib/board-cache";
import { ridServiceId } from "@/lib/service-details";
import { getStations, stationName } from "@/lib/stations";

export const dynamic = "force-dynamic";

type BoardDirection = "departures" | "arrivals";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/London",
});

function t(iso: string): string {
  return timeFmt.format(new Date(iso));
}

/** "12 coaches · 3 First" — a compact class breakdown, full per-coach detail lives on the service page. */
function coachSummary(d: BoardDeparture): string {
  if (!d.coachCount) return "";
  const firstCount = d.coaches?.filter((c) => c.first).length ?? 0;
  const base = `${d.coachCount} coach${d.coachCount === 1 ? "" : "es"}`;
  return firstCount > 0 ? `${base} · ${firstCount} First` : base;
}

function StatusCell({ d, direction }: { d: BoardDeparture; direction: BoardDirection }) {
  // The instant we expect it to leave/arrive here: the live estimate, else scheduled.
  const expectedIso = d.live ?? d.scheduled;
  // Show a ticking "N mins" only while the train is actually tracked live
  // (Network Rail position present) and not cancelled — otherwise the board
  // stays a scheduled/expected clock, as before.
  const showCountdown = direction === "departures" && d.status !== "cancelled" && Boolean(d.position);

  switch (d.status) {
    case "cancelled":
      return <span className="board-status status-cancelled">Cancelled</span>;
    case "delayed":
      // The expected time appears once: as the sub-line under a countdown, or
      // as the headline when there's no countdown. It used to render in both
      // places at once, printing the same time twice in one cell.
      return (
        <span className="board-status status-delayed">
          {showCountdown ? (
            <>
              <LiveCountdown iso={expectedIso} />
              {d.live && <span className="board-status-sub">exp. {t(d.live)}</span>}
            </>
          ) : d.live ? (
            <>Exp. {t(d.live)}</>
          ) : typeof d.delayMinutes === "number" ? (
            <>Exp. +{d.delayMinutes}m</>
          ) : (
            "Delayed"
          )}
        </span>
      );
    case "on-time":
      return (
        <span className="board-status status-ontime">
          {showCountdown ? <LiveCountdown iso={expectedIso} /> : "On time"}
        </span>
      );
    default:
      // "No report", "Starts here", "Bus" and friends — stated, not dressed up
      // as a confirmed on-time status.
      return <span className="board-status status-scheduled">{d.reason || "No report"}</span>;
  }
}

/**
 * A stable identity for a board row.
 *
 * Never the array index: rows are now ordered by expected departure, so a
 * delayed train genuinely moves between refreshes. With an index-derived key
 * React reuses the wrong DOM node and LiveCountdown's ticking state sticks to
 * whatever row inherited its position.
 */
function rowKey(d: BoardDeparture): string {
  return (
    d.tripId ??
    d.rid ??
    `${d.scheduled}-${d.originCrs ?? d.originName ?? ""}-${d.destinationCrs ?? d.destinationName}`
  );
}

function placeName(d: BoardDeparture, direction: BoardDirection): string {
  return direction === "arrivals" ? (d.originName ?? "") : d.destinationName;
}

function placeLabel(direction: BoardDirection): string {
  return direction === "arrivals" ? "Origin" : "Destination";
}

function serviceHref(
  d: BoardDeparture,
  direction: BoardDirection,
  crs: string,
  source: string,
): string | undefined {
  const serviceId =
    d.tripId && source === "ldbws" ? d.tripId : d.rid ? ridServiceId(d.rid) : undefined;
  if (!serviceId) return undefined;
  const param = direction === "arrivals" ? "to" : "from";
  return `/services/${encodeURIComponent(serviceId)}?${param}=${crs}`;
}

function boardHref(crs: string, direction: BoardDirection, callingAt?: string): string {
  const params = new URLSearchParams();
  if (direction === "arrivals") params.set("board", "arrivals");
  if (callingAt) params.set("callingAt", callingAt);
  const query = params.toString();
  return `/boards/${encodeURIComponent(crs)}${query ? `?${query}` : ""}`;
}

function BoardSwitch({
  active,
  callingAt,
  crs,
  departures,
  arrivals,
}: {
  active: BoardDirection;
  callingAt?: string;
  crs: string;
  departures: number;
  arrivals: number;
}) {
  return (
    <nav className="board-switch" aria-label="Board type">
      <Link
        className={`board-switch-card ${active === "departures" ? "board-switch-card-active" : ""}`}
        href={boardHref(crs, "departures", callingAt)}
        aria-current={active === "departures" ? "page" : undefined}
      >
        <span className="board-switch-label">Departures</span>
        <span className="board-switch-count">{departures}</span>
      </Link>
      <Link
        className={`board-switch-card ${active === "arrivals" ? "board-switch-card-active" : ""}`}
        href={boardHref(crs, "arrivals", callingAt)}
        aria-current={active === "arrivals" ? "page" : undefined}
      >
        <span className="board-switch-label">Arrivals</span>
        <span className="board-switch-count">{arrivals}</span>
      </Link>
    </nav>
  );
}

function EmptyBoard({
  activeFilter,
  crs,
  direction,
}: {
  activeFilter?: { crs: string; name: string };
  crs: string;
  direction: BoardDirection;
}) {
  if (direction === "departures" && activeFilter) {
    return (
      <div className="notice">
        <h2>No trains calling at {activeFilter.name}</h2>
        <p>
          Nothing departing here soon stops at {activeFilter.name}.{" "}
          <Link href={`/boards/${crs}`}>Clear the filter</Link> to see all departures.
        </p>
      </div>
    );
  }

  if (direction === "arrivals" && activeFilter) {
    return (
      <div className="notice">
        <h2>No arrivals from {activeFilter.name}</h2>
        <p>
          Nothing arriving here soon has called at {activeFilter.name}.{" "}
          <Link href={`/boards/${crs}?board=arrivals`}>Clear the filter</Link> to see all arrivals.
        </p>
      </div>
    );
  }

  return (
    <div className="notice">
      <h2>No {direction} in the next couple of hours</h2>
      <p>Nothing is scheduled {direction === "arrivals" ? "to arrive" : "from here"} right now.</p>
    </div>
  );
}

function BoardSection({
  activeFilter,
  crs,
  direction,
  services,
  source,
  stationName,
}: {
  activeFilter?: { crs: string; name: string };
  crs: string;
  direction: BoardDirection;
  services: BoardDeparture[];
  source: string;
  stationName: string;
}) {
  const title = direction === "arrivals" ? "Arrivals" : "Departures";

  return (
    <section className="board-section" aria-label={title}>
      {services.length === 0 ? (
        <EmptyBoard activeFilter={activeFilter} crs={crs} direction={direction} />
      ) : (
        <>
          <div className="board-legend" aria-hidden="true">
            <span className="board-legend-time">Time</span>
            <span className="board-legend-dest">{placeLabel(direction)}</span>
            <span className="board-legend-plat">Plat</span>
            <span className="board-legend-status">Expected</span>
          </div>
          <ol className="board" aria-label={`${title} ${direction === "arrivals" ? "at" : "from"} ${stationName}`}>
            {services.map((d, i) => {
              const isNext =
                d.status !== "cancelled" &&
                services.findIndex((x) => x.status !== "cancelled") === i;
              const href = serviceHref(d, direction, crs, source);
              const linkable = Boolean(href);
              return (
                <li
                  key={rowKey(d)}
                  className={`board-card ${d.status === "cancelled" ? "board-card-cancelled" : ""} ${
                    isNext ? "board-card-next" : ""
                  } ${linkable ? "board-card-link" : ""}`}
                >
                  <span className="board-time">
                    <span className="board-time-sched">{t(d.scheduled)}</span>
                    {d.live && d.status !== "cancelled" && t(d.live) !== t(d.scheduled) && (
                      <span className="board-time-live">{t(d.live)}</span>
                    )}
                  </span>
                  <span className="board-dest">
                    <span className="board-dest-name">
                      {href ? (
                        <Link className="board-card-stretch" href={href}>
                          {placeName(d, direction) || "-"}
                        </Link>
                      ) : (
                        (placeName(d, direction) || "-")
                      )}
                    </span>
                    {(d.operator || d.coachCount) && (
                      <span className="board-operator">
                        {d.operator}
                        {d.operator && d.operatorPunctuality !== undefined
                          ? ` (${d.operatorPunctuality}% on time)`
                          : ""}
                        {d.operator && d.coachCount ? " · " : ""}
                        {coachSummary(d)}
                      </span>
                    )}
                    {d.position && d.status !== "cancelled" && direction === "departures" && (
                      <span
                        className={`board-position ${
                          d.position.latenessMinutes && d.position.latenessMinutes > 1
                            ? "board-position-late"
                            : ""
                        }`}
                      >
                        <span className="board-position-dot" aria-hidden="true" />
                        {d.position.label}
                        {d.position.latenessMinutes && d.position.latenessMinutes > 1
                          ? ` · ${d.position.latenessMinutes} late`
                          : d.position.latenessMinutes && d.position.latenessMinutes < -1
                            ? ` · ${-d.position.latenessMinutes} early`
                            : ""}
                      </span>
                    )}
                    {d.movedFromSchedule && d.status !== "cancelled" && direction === "departures" && (
                      <span className="board-moved">Booked {t(d.scheduled)}</span>
                    )}
                    {d.reason && <span className="board-reason">{d.reason}</span>}
                  </span>
                  <span className="board-plat">
                    {d.platform ? (
                      <span className={d.platformChanged ? "plat-changed" : ""}>
                        {d.platform}
                        {d.platformChanged && <span className="plat-changed-tag">changed</span>}
                      </span>
                    ) : (
                      <span className="board-plat-unknown" title="No platform assigned yet">
                        -
                      </span>
                    )}
                  </span>
                  <span className="board-status-col">
                    <StatusCell d={d} direction={direction} />
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ crs: string }>;
  searchParams: Promise<{ board?: string; callingAt?: string }>;
}) {
  const { crs } = await params;
  const { board, callingAt } = await searchParams;
  const [outcome, stations] = await Promise.all([
    cachedBoard(crs, undefined, 20, callingAt),
    getStations().catch(() => []),
  ]);

  if (!outcome.ok && outcome.reason === "unknown-station") notFound();

  const activeFilter =
    outcome.ok && callingAt
      ? { crs: callingAt.toUpperCase(), name: outcome.board.filterName ?? (await stationName(callingAt)) }
      : undefined;
  const activeBoard: BoardDirection = board === "arrivals" ? "arrivals" : "departures";

  return (
    <main>
      {!outcome.ok ? (
        <>
          <div className="results-head">
            <h1>Boards</h1>
            <span className="when">
              <Link href="/boards">choose a station</Link>
            </span>
          </div>
          <div className="notice notice-danger">
            <h2>
              {outcome.reason === "engine-offline"
                ? "Board data is offline"
                : "That station code isn’t valid"}
            </h2>
            <p>
              {outcome.reason === "engine-offline"
                ? "Signaller couldn’t reach the routing engine to build this board. If you’re running locally, start MOTIS and try again."
                : "Use a 3-letter station code (CRS), like KGX or EDB."}
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="results-head board-head">
            <h1>
              {outcome.board.stationName}
              <span className="board-crs">{outcome.board.crs}</span>
            </h1>
            <span className="when board-status-line">
              {outcome.board.live ? (
                <span className="live-dot" aria-label="Live data">
                  ● Live
                </span>
              ) : (
                <span className="chip chip-muted">Timetabled — live data unavailable</span>
              )}
              <BoardRefresher />
              {" · "}
              <Link href="/boards">change station</Link>
            </span>
          </div>

          <StationSignallingButton crs={outcome.board.crs} name={outcome.board.stationName} />

          <BoardFilter crs={outcome.board.crs} stations={stations} active={activeFilter} />
          {activeFilter && (
            <p className="board-filter-note">
              Showing only services calling at <strong>{activeFilter.name}</strong>.
            </p>
          )}

          {outcome.board.disruptions.length > 0 && (
            <div className="disruptions">
              {outcome.board.disruptions.map((d) => (
                <details key={d.id} className="disruption">
                  <summary className="disruption-summary">
                    <span className="disruption-icon" aria-hidden="true">
                      {d.planned ? "🛠" : "⚠"}
                    </span>
                    <span className="disruption-head">
                      <span className="disruption-title">{d.summary}</span>
                      {d.operators.length > 0 && (
                        <span className="disruption-ops">{d.operators.join(", ")}</span>
                      )}
                    </span>
                  </summary>
                  <div className="disruption-body">
                    {d.blocks.map((block, bi) =>
                      block.heading ? (
                        <p key={bi} className="disruption-block-heading">
                          {block.content.map((c) => c.text).join("")}
                        </p>
                      ) : (
                        <p key={bi} className="disruption-block">
                          {block.content.map((c, ci) =>
                            "href" in c ? (
                              <a key={ci} href={c.href} target="_blank" rel="noopener noreferrer">
                                {c.text}
                              </a>
                            ) : (
                              <span key={ci}>{c.text}</span>
                            ),
                          )}
                        </p>
                      ),
                    )}
                    {d.link && (
                      <a
                        className="disruption-more"
                        href={d.link}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        More on National Rail →
                      </a>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}

          {outcome.board.messages.length > 0 && (
            <div className="board-messages" role="note">
              {outcome.board.messages.map((msg, i) => (
                <p key={i}>{msg}</p>
              ))}
            </div>
          )}

          <BoardSwitch
            active={activeBoard}
            callingAt={callingAt}
            crs={outcome.board.crs}
            departures={outcome.board.departures.length}
            arrivals={outcome.board.arrivals.length}
          />

          <BoardSection
            activeFilter={activeFilter}
            crs={outcome.board.crs}
            direction={activeBoard}
            services={
              activeBoard === "arrivals" ? outcome.board.arrivals : outcome.board.departures
            }
            source={outcome.board.source}
            stationName={outcome.board.stationName}
          />
        </>
      )}
    </main>
  );
}
