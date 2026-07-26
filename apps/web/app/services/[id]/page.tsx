import Link from "next/link";
import { notFound } from "next/navigation";
import { AdvancedViewToggle } from "@/components/advanced-view-toggle";
import { BoardRefresher } from "@/components/board-refresher";
import { LiveCountdown } from "@/components/live-countdown";
import { ServicePositionMap } from "@/components/service-position-map";
import { serviceIndicatorsByToc, type ServiceIndicator } from "@/lib/disruptions";
import {
  fetchServiceDetails,
  serviceDetailsConfigured,
  type ServiceCall,
  type ServiceCoach,
  type ServiceProgress,
} from "@/lib/service-details";

export const dynamic = "force-dynamic";

/** "InService" -> "In service" for the tooltip; suppress the glyph if it's out of service or unknown. */
function toiletLabel(toilet: string | undefined): string | undefined {
  if (!toilet) return undefined;
  if (/notinservice|out\s*of\s*order|unknown/i.test(toilet)) return undefined;
  return "In service";
}

/** Coach formation diagram: one box per carriage, loading shown as a fill. */
function Formation({ coaches, length }: { coaches: ServiceCoach[]; length?: number }) {
  if (coaches.length === 0) {
    if (!length) return null;
    return (
      <div className="formation">
        <p className="formation-head">Formation</p>
        <p className="board-operator">{length} coaches</p>
      </div>
    );
  }
  return (
    <div className="formation">
      <p className="formation-head">
        Formation · {coaches.length} coaches{" "}
        <span aria-hidden="true">(front → back)</span>
      </p>
      <div className="coaches">
        {coaches.map((c, i) => (
          <div
            key={`${c.number}-${i}`}
            className={`coach ${c.first ? "coach-first" : ""}`}
            title={`Coach ${c.number}${c.first ? " · First" : ""}${
              c.loading !== undefined ? ` · ${c.loading}% full` : ""
            }${toiletLabel(c.toilet) ? ` · Toilet: ${toiletLabel(c.toilet)}` : ""}`}
          >
            {c.loading !== undefined && (
              <span className="coach-fill" style={{ height: `${c.loading}%` }} />
            )}
            <span className="coach-num">{c.number}</span>
            {c.first && <span className="coach-load">1st</span>}
            {toiletLabel(c.toilet) && <span className="coach-toilet">WC</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TrainIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5V21h2l2-2h4l2 2h2v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4Zm-6 6h5v4H6V8Zm7 0h5v4h-5V8Zm-4.5 9A1.5 1.5 0 1 1 10 15.5 1.5 1.5 0 0 1 8.5 17Zm7 0A1.5 1.5 0 1 1 17 15.5 1.5 1.5 0 0 1 15.5 17Z" />
    </svg>
  );
}

/** Render a per-stop expected time: highlight delays, strike cancellations. */
function CallStatus({ call }: { call: ServiceCall }) {
  if (call.cancelled) return <span className="call-status status-cancelled">Cancelled</span>;
  const exp = (call.expected ?? "").trim();
  if (!exp || /^on time$/i.test(exp)) {
    return <span className="call-status status-ontime">On time</span>;
  }
  if (/^\d{2}:\d{2}$/.test(exp)) {
    const late = exp !== (call.scheduled ?? "").trim();
    return (
      <span className={`call-status ${late ? "status-delayed" : "status-ontime"}`}>
        {late ? `Exp. ${exp}` : "On time"}
      </span>
    );
  }
  return <span className="call-status status-delayed">{exp}</span>;
}

/**
 * Wording for the top-of-page status banner — the one place the page states
 * "where is the train," as a last confirmed report rather than an implied
 * live position. Prefers the Network Rail location when it's finer-grained
 * than Darwin's last stop; otherwise falls back to the Darwin-level
 * lastStopName.
 */
function positionStatusText(progress: ServiceProgress): string | null {
  if (progress.arrived) return null; // every call already reads "Departed" — nothing to add

  if (!progress.lastStopName && progress.nextStopName) {
    return "Not yet departed";
  }
  if (!progress.lastStopName) return null;

  const useNr = progress.networkRail && progress.nrLastLocation;
  const where = useNr ? progress.nrLastLocation : progress.lastStopName;
  const verb = useNr
    ? progress.nrLastEvent === "PASS"
      ? "Passed"
      : progress.nrLastEvent === "ARRIVAL"
        ? "Arrived"
        : "Departed"
    : "Last confirmed at";

  const parts = [`${verb} ${where}`];

  const agoMin =
    useNr && progress.nrReportedAgoSeconds !== undefined && progress.nrReportedAgoSeconds < 3600
      ? Math.max(0, Math.round(progress.nrReportedAgoSeconds / 60))
      : undefined;
  if (agoMin !== undefined) parts.push(`${agoMin} min ago`);

  const lateness = useNr ? progress.nrLatenessMinutes : progress.delayMinutes;
  if (lateness) {
    parts.push(lateness > 0 ? `running ${lateness} late` : `running ${-lateness} early`);
  } else if (!useNr) {
    parts.push("on time");
  }

  return parts.join(" · ");
}

export default async function ServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;

  if (!serviceDetailsConfigured()) {
    return (
      <main>
        <div className="results-head">
          <h1>Service details</h1>
        </div>
        <div className="notice notice-danger">
          <h2>Service details aren’t available</h2>
          <p>The Service Details data feed isn’t configured.</p>
        </div>
      </main>
    );
  }

  const service = await fetchServiceDetails(id);
  if (!service) notFound();

  const backHref = from ? `/boards/${from}` : "/boards";

  const statusText =
    service.progress.tracking && !service.progress.arrived && !service.cancelled
      ? positionStatusText(service.progress)
      : null;

  // Where the train icon sits: on the "current" call's node if the last report
  // was an arrival there (the train is physically at that station), or
  // hovering on the rail between "current" and the next call otherwise — a
  // departure/pass report, or a Darwin-only "last confirmed here" position,
  // both mean the train is somewhere between the two, not sitting at either.
  // No live GPS exists for GB rail, so "between" is a fixed midpoint, not a
  // proportional estimate — honest about the precision we actually have.
  const currentIndex = service.progress.tracking
    ? service.calls.findIndex((c) => c.progress === "current")
    : -1;
  const atStation = service.progress.networkRail && service.progress.nrLastEvent === "ARRIVAL";

  // Operator's overall service status ("Good service" / a disruption headline).
  let indicator: ServiceIndicator | undefined;
  if (service.operatorCode) {
    const map = await serviceIndicatorsByToc().catch(() => null);
    indicator = map?.get(service.operatorCode) ?? undefined;
  }

  return (
    <main>
      <div className="results-head">
        <h1>
          {service.calls[service.calls.length - 1]?.name ?? "Service"}
          <span className="board-crs">{service.operator}</span>
        </h1>
        <span className="when">
          {indicator && (
            <span
              className={`service-indicator ${indicator.good ? "service-indicator-good" : "service-indicator-bad"}`}
            >
              {indicator.good ? "Good service" : indicator.statusDescription || "Disruption"}
            </span>
          )}
          {" · "}
          {service.progress.tracking && !service.progress.arrived && (
            <>
              <BoardRefresher intervalMs={30_000} />
              {" · "}
            </>
          )}
          <Link href={backHref}>← back to board</Link>
        </span>
      </div>

      {statusText && (
        <div className="track-banner" role="status">
          <span className="track-dot" aria-hidden="true" />
          <span className="track-text">{statusText}</span>
        </div>
      )}

      {service.progress.networkRail && service.rid && (
        <>
          <ServicePositionMap rid={service.rid} />
          <AdvancedViewToggle serviceId={id} rid={service.rid} />
        </>
      )}

      <Formation coaches={service.coaches} length={service.length} />

      {service.cancelled && (
        <div className="board-messages board-messages-danger" role="note">
          <p>
            This service is cancelled{service.cancelReason ? `: ${service.cancelReason}` : "."}
          </p>
        </div>
      )}
      {!service.cancelled && service.delayReason && (
        <div className="board-messages" role="note">
          <p>{service.delayReason}</p>
        </div>
      )}

      <ol className={`calls ${currentIndex >= 0 ? "calls-tracked" : ""}`}>
        {service.calls.map((call, i) => {
          const state = call.progress ?? "upcoming";
          // Show the train icon on this call's node if it's the current stop
          // and the train has been confirmed as arrived there; otherwise show
          // it hovering on the rail after this call if this is the current
          // stop but the train has since departed/passed it (or we only know
          // it's "last confirmed here" from Darwin, not a fresh arrival).
          const showIconHere = i === currentIndex && atStation;
          const showIconAfter = i === currentIndex && !atStation;
          return (
            <li
              key={`${call.crs ?? call.name}-${i}`}
              className={`call call-${state} ${call.isThisStop ? "call-here" : ""} ${
                call.cancelled ? "call-cancelled" : ""
              }`}
            >
              {currentIndex >= 0 && (
                <span className="call-marker" aria-hidden="true">
                  {showIconHere && (
                    <span className="call-train call-train-at" role="img" aria-label="Train here">
                      <TrainIcon />
                    </span>
                  )}
                  {showIconAfter && (
                    <span
                      className="call-train call-train-between"
                      role="img"
                      aria-label="Train between stations"
                    >
                      <TrainIcon />
                    </span>
                  )}
                  <span className="call-node" />
                </span>
              )}
              <span className="call-time">
                {call.actual ?? call.scheduled ?? "—"}
                {call.actual && call.actual !== call.scheduled && (
                  <span className="call-sched-was">{call.scheduled}</span>
                )}
              </span>
              <span className="call-name">
                {call.name}
                {call.isThisStop && <span className="call-here-tag">boarding here</span>}
              </span>
              <span className="call-plat">
                {call.platform ? (
                  <>
                    <span className="call-plat-label">Plat</span> {call.platform}
                  </>
                ) : (
                  ""
                )}
              </span>
              <span className="call-status-col">
                {state === "departed" ? (
                  <span className="call-status status-departed">Departed</span>
                ) : call.estimatedArrivalIso && !call.cancelled ? (
                  <LiveCountdown iso={call.estimatedArrivalIso} />
                ) : (
                  <CallStatus call={call} />
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </main>
  );
}
