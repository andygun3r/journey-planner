import Link from "next/link";
import { notFound } from "next/navigation";
import { AdvancedViewToggle } from "@/components/advanced-view-toggle";
import { BoardRefresher } from "@/components/board-refresher";
import { LiveCountdown } from "@/components/live-countdown";
import { ServicePositionMap } from "@/components/service-position-map";
import { callLiveStatus, deltaChip, type CallLiveStatus } from "@/lib/call-status";
import { serviceIndicatorsByToc, type ServiceIndicator } from "@/lib/disruptions";
import {
  fetchServiceDetails,
  serviceDetailsConfigured,
  type ServiceCall,
  type ServiceCoach,
  type ServicePortion,
  type ServiceProgress,
} from "@/lib/service-details";
import { parseHhmm } from "@/lib/uk-time";

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
        Formation · {coaches.length} coaches <span aria-hidden="true">(front → back)</span>
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

/**
 * A calling point's live state as a chip.
 *
 * All the parsing lives in `callLiveStatus` so this and the map's train panel
 * agree, and so every case is unit-tested. Note "No report" — this used to
 * print a confident "On time" whenever the feed said nothing at all, which is
 * the opposite of what the board client does and of what PRODUCT.md asks for.
 * Every chip carries its condition in words, never colour alone.
 */
function CallStatus({ status }: { status: CallLiveStatus }) {
  const chip = deltaChip(status);
  return (
    <span className={`call-status status-${status.kind}`}>
      {status.label}
      {chip && (
        <span className="call-delta" aria-label={`${status.deltaMinutes} minutes against schedule`}>
          {chip}
        </span>
      )}
    </span>
  );
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

/** One stop on the progress rail. */
function CallRow({
  call,
  showIconHere,
  showIconAfter,
  tracked,
}: {
  call: ServiceCall;
  showIconHere: boolean;
  showIconAfter: boolean;
  tracked: boolean;
}) {
  const state = call.progress ?? "upcoming";
  const status = callLiveStatus(call);
  // The booked time always stays visible in its own column, so the row can be
  // read as a timetable. A separate live time appears beside it only when the
  // two differ — the old single cell overwrote the booked time with the actual
  // one and struck the original through, which read as a correction rather
  // than as scheduled-vs-actual. An actual report outranks an estimate.
  const estimate = parseHhmm(call.expected) !== null ? call.expected!.trim() : undefined;
  const live = call.actual ?? estimate;
  // Only show (and strike through the booked time for) a genuine deviation —
  // an on-time report shouldn't read as a correction.
  const showLive = Boolean(live && live !== call.scheduled && status.kind !== "on-time");

  return (
    <li
      className={`call call-${state} ${call.isThisStop ? "call-here" : ""} ${
        call.cancelled ? "call-cancelled" : ""
      }`}
    >
      {tracked && (
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
        <span className="call-time-sched">{call.scheduled ?? "—"}</span>
        {showLive && <span className="call-time-live">{live}</span>}
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
          <span className="call-plat-unknown" title="No platform assigned yet">
            —
          </span>
        )}
      </span>
      <span className="call-status-col">
        {state === "departed" ? (
          <span className="call-status status-departed">Departed</span>
        ) : call.estimatedArrivalIso && !call.cancelled ? (
          <LiveCountdown iso={call.estimatedArrivalIso} />
        ) : (
          <CallStatus status={status} />
        )}
      </span>
    </li>
  );
}

/**
 * An associated portion of a service that divides or joins.
 *
 * These stops used to be appended onto the main calling pattern, producing a
 * single linear route the train never runs — the reported "passed a station
 * that's not on the route". Shown separately, and clearly labelled, they're
 * genuinely useful: they tell you which half of the train to be in.
 */
function Portion({ portion }: { portion: ServicePortion }) {
  const heading =
    portion.kind === "divides"
      ? `This train divides — rear portion for ${portion.terminusName ?? "another destination"}`
      : `Joined here by a portion from ${portion.terminusName ?? "another origin"}`;

  return (
    <section className="portion" aria-label={heading}>
      <h2 className="portion-head">
        <span className="portion-tag">{portion.kind === "divides" ? "Divides" : "Joins"}</span>
        {heading}
      </h2>
      {portion.changeRequired && (
        <p className="portion-note">
          You must be in the correct portion — passengers cannot move between them once the train
          divides.
        </p>
      )}
      {portion.cancelled && (
        <p className="portion-note portion-note-danger">This portion is cancelled.</p>
      )}
      <ol className="calls portion-calls">
        {portion.calls.map((call, i) => (
          <CallRow
            key={`${call.crs ?? call.name}-${call.scheduled ?? i}`}
            call={call}
            showIconHere={false}
            showIconAfter={false}
            tracked={false}
          />
        ))}
      </ol>
    </section>
  );
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

  // Correlation is strict (see lib/service-progress.ts): we would rather show
  // nothing than another train's position. That makes "no position yet" a
  // routine outcome, so it has to be stated rather than left as an absence the
  // reader has to interpret.
  // ...but only when there is nothing better to say. When we already know the
  // train hasn't left yet, that's the more useful sentence and this would just
  // repeat it.
  const awaitingPosition =
    service.progress.positionState === "awaiting-report" && !service.cancelled && !statusText;

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

  const boarding = service.calls.find((c) => c.isThisStop);
  const boardingStatus = boarding ? callLiveStatus(boarding) : undefined;
  const destination = service.calls[service.calls.length - 1]?.name ?? "Service";

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
          {destination}
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

      {/* The five-second answer: which platform, and when does it actually go. */}
      <div className="service-summary">
        <div className="service-summary-cell">
          <span className="service-summary-label">From</span>
          <span className="service-summary-value">{service.stationName}</span>
        </div>
        <div className="service-summary-cell">
          <span className="service-summary-label">Platform</span>
          <span className="service-summary-value service-summary-plat">
            {service.platform ?? <span className="service-summary-unknown">Not yet known</span>}
          </span>
        </div>
        <div className="service-summary-cell">
          <span className="service-summary-label">Departs</span>
          <span className="service-summary-value">
            {service.scheduledDeparture ?? "—"}
            {boardingStatus && boardingStatus.kind !== "on-time" && (
              <span className={`service-summary-status status-${boardingStatus.kind}`}>
                {boardingStatus.label}
              </span>
            )}
          </span>
        </div>
        {boarding?.estimatedArrivalIso && !service.cancelled && (
          <div className="service-summary-cell">
            <span className="service-summary-label">In</span>
            <span className="service-summary-value">
              <LiveCountdown iso={boarding.estimatedArrivalIso} />
            </span>
          </div>
        )}
      </div>

      {statusText && (
        <div className="track-banner" role="status">
          <span className="track-dot" aria-hidden="true" />
          <span className="track-text">{statusText}</span>
        </div>
      )}

      {awaitingPosition && (
        <div className="track-banner track-banner-muted" role="status">
          <span className="track-text">
            Awaiting a position report — this service hasn’t been matched to a live train yet, so
            the times below are scheduled rather than tracked.
          </span>
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
          <p>This service is cancelled{service.cancelReason ? `: ${service.cancelReason}` : "."}</p>
        </div>
      )}
      {!service.cancelled && service.delayReason && (
        <div className="board-messages" role="note">
          <p>{service.delayReason}</p>
        </div>
      )}

      <ol className={`calls ${currentIndex >= 0 ? "calls-tracked" : ""}`}>
        {service.calls.map((call, i) => (
          <CallRow
            // Never the bare array index: a stop's identity is its station and
            // booked time, so a re-render can't shuffle live countdown state
            // between rows.
            key={`${call.crs ?? call.name}-${call.scheduled ?? i}`}
            call={call}
            showIconHere={i === currentIndex && atStation}
            showIconAfter={i === currentIndex && !atStation}
            tracked={currentIndex >= 0}
          />
        ))}
      </ol>

      {service.portions.map((portion, i) => (
        <Portion key={`${portion.kind}-${portion.terminusName ?? i}`} portion={portion} />
      ))}
    </main>
  );
}
