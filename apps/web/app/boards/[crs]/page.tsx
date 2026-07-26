import Link from "next/link";
import { notFound } from "next/navigation";
import { BoardFilter } from "@/components/board-filter";
import { BoardRefresher } from "@/components/board-refresher";
import { LiveCountdown } from "@/components/live-countdown";
import { getBoard, type BoardDeparture } from "@/lib/board";
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
      return (
        <span className="board-status status-delayed">
          {showCountdown && departsIso ? (
            <LiveCountdown iso={departsIso} />
          ) : (
            <>Exp. {d.live ? t(d.live) : `+${d.delayMinutes}m`}</>
          )}
          {d.live && <span className="board-status-sub">exp. {t(d.live)}</span>}
        </span>
      );
    case "on-time":
      return (
        <span className="board-status status-ontime">
          {showCountdown && departsIso ? <LiveCountdown iso={departsIso} /> : "On time"}
        </span>
      );
    default:
      return <span className="board-status status-scheduled">—</span>;
  }
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
    getBoard(crs, undefined, 20, callingAt),
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
            <div className="board" role="table" aria-label={`Departures from ${outcome.board.stationName}`}>
              <div className="board-row board-row-head" role="row">
                <span role="columnheader">Time</span>
                <span role="columnheader">Destination</span>
                <span role="columnheader" className="board-plat-col">
                  Plat
                </span>
                <span role="columnheader" className="board-status-col">
                  Expected
                </span>
              </div>
              {outcome.board.departures.map((d, i) => {
                const inner = (
                  <>
                    <span className="board-time" role="cell">
                      {t(d.scheduled)}
                    </span>
                    <span className="board-dest" role="cell">
                      <span className="board-dest-name">{d.destinationName || "—"}</span>
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
                        <span className="board-position">
                          <span className="board-position-dot" aria-hidden="true" />
                          {d.position.label}
                          {d.position.latenessMinutes && d.position.latenessMinutes > 1
                            ? ` · ${d.position.latenessMinutes} late`
                            : d.position.latenessMinutes && d.position.latenessMinutes < -1
                              ? ` · ${-d.position.latenessMinutes} early`
                              : ""}
                        </span>
                      )}
                      {d.reason && <span className="board-reason">{d.reason}</span>}
                    </span>
                    <span className="board-plat board-plat-col" role="cell">
                      {d.platform ? (
                        <span className={d.platformChanged ? "plat-changed" : ""}>
                          {d.platform}
                        </span>
                      ) : (
                        "—"
                      )}
                    </span>
                    <span className="board-status-col" role="cell">
                      <StatusCell d={d} />
                    </span>
                  </>
                );
                const rowClass = `board-row ${d.status === "cancelled" ? "board-row-cancelled" : ""}`;
                const key = `${d.tripId ?? i}-${d.scheduled}`;
                // Only LDBWS boards carry a serviceID that GetServiceDetails accepts.
                return d.tripId && outcome.board.source === "ldbws" ? (
                  <Link
                    href={`/services/${encodeURIComponent(d.tripId)}?from=${outcome.board.crs}`}
                    className={`${rowClass} board-row-link`}
                    role="row"
                    key={key}
                  >
                    {inner}
                  </Link>
                ) : (
                  <div className={rowClass} role="row" key={key}>
                    {inner}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </main>
  );
}
