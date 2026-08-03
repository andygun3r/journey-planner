import Link from "next/link";
import { notFound } from "next/navigation";
import { BoardFilter } from "@/components/board-filter";
import { BoardRefresher } from "@/components/board-refresher";
import { LiveCountdown } from "@/components/live-countdown";
import { StationSignallingButton } from "@/components/station-signalling-button";
import { type BoardDeparture } from "@/lib/board";
import { cachedBoard } from "@/lib/board-cache";
import { getStations, stationName } from "@/lib/stations";

export const dynamic = "force-dynamic";

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

function StatusCell({ d }: { d: BoardDeparture }) {
  // The instant we expect it to leave here: the live estimate, else scheduled.
  const departsIso = d.live ?? d.scheduled;
  // Show a ticking "N mins" only while the train is actually tracked live
  // (Network Rail position present) and not cancelled — otherwise the board
  // stays a scheduled/expected clock, as before.
  const showCountdown = d.status !== "cancelled" && Boolean(d.position);

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
              <LiveCountdown iso={departsIso} />
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
          {showCountdown ? <LiveCountdown iso={departsIso} /> : "On time"}
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
  return d.tripId ?? d.rid ?? `${d.scheduled}-${d.destinationCrs ?? d.destinationName}`;
}

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ crs: string }>;
  searchParams: Promise<{ callingAt?: string }>;
}) {
  const { crs } = await params;
  const { callingAt } = await searchParams;
  const [outcome, stations] = await Promise.all([
    cachedBoard(crs, undefined, 20, callingAt),
    getStations().catch(() => []),
  ]);

  if (!outcome.ok && outcome.reason === "unknown-station") notFound();

  const activeFilter =
    outcome.ok && callingAt
      ? { crs: callingAt.toUpperCase(), name: outcome.board.filterName ?? (await stationName(callingAt)) }
      : undefined;

  return (
    <main>
      {!outcome.ok ? (
        <>
          <div className="results-head">
            <h1>Departures</h1>
            <span className="when">
              <Link href="/boards">choose a station</Link>
            </span>
          </div>
          <div className="notice notice-danger">
            <h2>
              {outcome.reason === "engine-offline"
                ? "Departure data is offline"
                : "That station code isn’t valid"}
            </h2>
            <p>
              {outcome.reason === "engine-offline"
                ? "Mainline couldn’t reach the routing engine to build this board. If you’re running locally, start MOTIS and try again."
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
              Showing only trains calling at <strong>{activeFilter.name}</strong>.
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

          {outcome.board.departures.length === 0 ? (
            <div className="notice">
              {activeFilter ? (
                <>
                  <h2>No trains calling at {activeFilter.name}</h2>
                  <p>
                    Nothing departing here soon stops at {activeFilter.name}.{" "}
                    <Link href={`/boards/${outcome.board.crs}`}>Clear the filter</Link> to
                    see all departures.
                  </p>
                </>
              ) : (
                <>
                  <h2>No departures in the next couple of hours</h2>
                  <p>Nothing is scheduled from here right now. Try again later.</p>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="board-legend" aria-hidden="true">
                <span className="board-legend-time">Time</span>
                <span className="board-legend-dest">Destination</span>
                <span className="board-legend-plat">Plat</span>
                <span className="board-legend-status">Expected</span>
              </div>
              <ol className="board" aria-label={`Departures from ${outcome.board.stationName}`}>
                {outcome.board.departures.map((d, i) => {
                  // The first service still expected to run gets the "next
                  // train" treatment — DESIGN.md reserves the blue border for
                  // exactly this. Rows are ordered by expected departure, so
                  // this really is the next one off the platform.
                  const isNext =
                    d.status !== "cancelled" &&
                    outcome.board.departures.findIndex((x) => x.status !== "cancelled") === i;
                  const linkable = Boolean(d.tripId) && outcome.board.source === "ldbws";
                  return (
                    <li
                      key={rowKey(d)}
                      // Always an <li>: the element type must not flip between
                      // <Link> and <div> per row, or React remounts the row and
                      // LiveCountdown loses its tick.
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
                          {/* Only LDBWS boards carry a serviceID GetServiceDetails accepts. */}
                          {linkable ? (
                            <Link
                              className="board-card-stretch"
                              href={`/services/${encodeURIComponent(d.tripId!)}?from=${outcome.board.crs}`}
                            >
                              {d.destinationName || "—"}
                            </Link>
                          ) : (
                            (d.destinationName || "—")
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
                        {d.position && d.status !== "cancelled" && (
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
                        {/* Rows move as trains run late; say so rather than
                            appear to shuffle between refreshes. */}
                        {d.movedFromSchedule && d.status !== "cancelled" && (
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
                            —
                          </span>
                        )}
                      </span>
                      <span className="board-status-col">
                        <StatusCell d={d} />
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </>
      )}
    </main>
  );
}
