import Link from "next/link";
import { notFound } from "next/navigation";
import { BoardRefresher } from "@/components/board-refresher";
import { LiveCountdown } from "@/components/live-countdown";
import { serviceIndicatorsByToc, type ServiceIndicator } from "@/lib/disruptions";
import {
  fetchServiceDetails,
  serviceDetailsConfigured,
  type ServiceCall,
  type ServiceCoach,
} from "@/lib/service-details";

export const dynamic = "force-dynamic";

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
            }`}
          >
            {c.loading !== undefined && (
              <span className="coach-fill" style={{ height: `${c.loading}%` }} />
            )}
            <span className="coach-num">{c.number}</span>
            {c.first && <span className="coach-load">1st</span>}
          </div>
        ))}
      </div>
    </div>
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

      {service.progress.tracking && !service.cancelled && (
        <div className="track-banner" role="status">
          <span className="track-dot" aria-hidden="true" />
          <span className="track-text">
            {service.progress.arrived ? (
              <>Arrived at {service.calls[service.calls.length - 1]?.name}.</>
            ) : service.progress.lastStopName && service.progress.nextStopName ? (
              <>
                Now between <strong>{service.progress.lastStopName}</strong> and{" "}
                <strong>{service.progress.nextStopName}</strong>
                {service.progress.delayMinutes
                  ? `, running ${service.progress.delayMinutes} min late`
                  : ", on time"}
                .
              </>
            ) : service.progress.nextStopName ? (
              <>
                Not yet departed — next stop <strong>{service.progress.nextStopName}</strong>.
              </>
            ) : (
              <>Tracking live.</>
            )}
            {service.progress.networkRail && service.progress.nrLastLocation && (
              <span className="track-nr">
                Network Rail: last seen{" "}
                {service.progress.nrLastEvent === "PASS"
                  ? "passing"
                  : service.progress.nrLastEvent === "ARRIVAL"
                    ? "arriving"
                    : "departing"}{" "}
                <strong>{service.progress.nrLastLocation}</strong>
                {service.progress.nrReportedAgoSeconds !== undefined &&
                service.progress.nrReportedAgoSeconds < 3600
                  ? ` ${Math.max(0, Math.round(service.progress.nrReportedAgoSeconds / 60))} min ago`
                  : ""}
                {service.progress.nrLatenessMinutes
                  ? ` · ${service.progress.nrLatenessMinutes > 0 ? `${service.progress.nrLatenessMinutes} late` : `${-service.progress.nrLatenessMinutes} early`}`
                  : ""}
                .
              </span>
            )}
          </span>
        </div>
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

      <ol className={`calls ${service.progress.tracking ? "calls-tracked" : ""}`}>
        {service.calls.map((call, i) => {
          const state = call.progress ?? "upcoming";
          return (
            <li
              key={`${call.crs ?? call.name}-${i}`}
              className={`call call-${state} ${call.isThisStop ? "call-here" : ""} ${
                call.cancelled ? "call-cancelled" : ""
              }`}
            >
              {service.progress.tracking && (
                <span className="call-marker" aria-hidden="true">
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
