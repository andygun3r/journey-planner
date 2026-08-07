import { BoardRefresher } from "@/components/board-refresher";
import {
  disruptionsConfigured,
  fetchNetworkDisruptions,
  serviceIndicatorsByToc,
  type Disruption,
  type ServiceIndicator,
} from "@/lib/disruptions";
import { getPlannedEngineeringWorks, type KbIncident } from "@/lib/kb-incidents";
import { getNetworkPunctuality, type OperatorPunctuality, type PpmStatus } from "@/lib/punctuality";
import { lineStatus, tflConfigured, type TflLineStatus } from "@/lib/tfl";

export const dynamic = "force-dynamic";

/** Core TfL rail modes; excludes bus/tram to keep this list board-sized. */
const TFL_RAIL_MODES = ["tube", "overground", "elizabeth-line", "dlr"] as const;

/** TfL's severity is 0-10 (10 = Good Service, lower is worse); map onto our chip classes. */
function tflChipClass(severity: number): string {
  if (severity >= 10) return "chip-ok";
  if (severity >= 8) return "chip-warn";
  return "chip-danger";
}

/**
 * RTPPM (Network Rail) and the Disruptions API (RDG) don't share an operator
 * code space — RTPPM's operator_code is a Network Rail numeric id, not the
 * ATOC 2-letter code — so operators are joined by name. Most names match
 * exactly, but a handful diverge between the two feeds; this maps RTPPM's
 * operator name to the Disruptions API's tocName for those.
 */
const RTPPM_TO_DISRUPTIONS_NAME: Record<string, string> = {
  Chiltern: "Chiltern Railways",
  "Caledonian Sleeper Limited": "Caledonian Sleeper",
  "Greater Thameslink Railway": "Thameslink",
  "London North Eastern Railway": "LNER",
  "Lumo East Coast": "Lumo",
  "Lumo West Coast": "Lumo",
  "Northern Trains": "Northern",
  "TransPennine Trains": "TransPennine Express",
  "West Midlands Trains": "West Midlands Railway",
};

function disruptionsFor(op: OperatorPunctuality, networkDisruptions: Disruption[]): Disruption[] {
  const name = RTPPM_TO_DISRUPTIONS_NAME[op.name] ?? op.name;
  return networkDisruptions.filter((d) => d.operators.includes(name));
}

const STATUS_LABEL: Record<PpmStatus, string> = {
  good: "Good service",
  marginal: "Some delays",
  poor: "Poor",
  unknown: "No data",
};

function StatusChip({ status }: { status: PpmStatus }) {
  const cls =
    status === "good"
      ? "chip-ok"
      : status === "marginal"
        ? "chip-warn"
        : status === "poor"
          ? "chip-danger"
          : "chip-muted";
  return <span className={`chip ${cls}`}>{STATUS_LABEL[status]}</span>;
}

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)}%`;
}

const worksDateFmt = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "Europe/London",
});

/** "12 Jul – 15 Jul" when both ends are known, else just whichever end is. */
function worksDateRange(work: KbIncident): string {
  if (work.startsAt && work.endsAt) {
    return `${worksDateFmt.format(work.startsAt)} – ${worksDateFmt.format(work.endsAt)}`;
  }
  if (work.startsAt) return `From ${worksDateFmt.format(work.startsAt)}`;
  if (work.endsAt) return `Until ${worksDateFmt.format(work.endsAt)}`;
  return "";
}

function EngineeringWorkRow({ work }: { work: KbIncident }) {
  return (
    <details className="disruption">
      <summary className="disruption-summary">
        <span className="disruption-icon" aria-hidden="true">
          🛠
        </span>
        <span className="disruption-head">
          <span className="disruption-title">{work.summary}</span>
          {work.affectedOperators.length > 0 && (
            <span className="disruption-ops">{work.affectedOperators.join(", ")}</span>
          )}
        </span>
      </summary>
      <div className="disruption-body">
        {worksDateRange(work) && <p className="disruption-block-heading">{worksDateRange(work)}</p>}
        {work.description && <p className="disruption-block">{work.description}</p>}
        {work.affectedRoutesText && (
          <p className="disruption-block">{work.affectedRoutesText}</p>
        )}
      </div>
    </details>
  );
}

function TflLineRow({ line }: { line: TflLineStatus }) {
  return (
    <div className="ppm-row tfl-row" role="row">
      <span className="ppm-op" role="cell">
        {line.lineName}
      </span>
      <span className="ppm-status" role="cell">
        <span className={`chip ${tflChipClass(line.statusSeverity)}`}>
          {line.statusSeverityDescription}
        </span>
      </span>
    </div>
  );
}

function OperatorRow({
  op,
  indicator,
  disruptions,
}: {
  op: OperatorPunctuality;
  indicator?: ServiceIndicator;
  disruptions: Disruption[];
}) {
  const disrupted = Boolean(indicator && !indicator.good);
  return (
    <div className={`ppm-row ${disrupted ? "ppm-row-disrupted" : ""}`} role="row">
      {disrupted ? (
        <details className="ppm-op-disruption" role="cell">
          <summary>
            <span className="ppm-op">{op.name}</span>
            <span className="ppm-op-disruption-icon" aria-hidden="true">
              ⚠
            </span>
          </summary>
          {disruptions.length > 0 ? (
            disruptions.map((d) => (
              <div key={d.id} className="ppm-op-disruption-item">
                <p className="ppm-op-disruption-summary">
                  {d.planned ? "Planned: " : ""}
                  {d.summary}
                </p>
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
            ))
          ) : (
            <p className="ppm-op-disruption-body">
              {indicator?.statusDescription || indicator?.status || "Disruption"}
            </p>
          )}
        </details>
      ) : (
        <span className="ppm-op" role="cell">
          {op.name}
        </span>
      )}
      <span className="ppm-figure" role="cell">
        {pct(op.ppm)}
      </span>
      <span className="ppm-figure ppm-muted" role="cell">
        {pct(op.rollingPpm)}
      </span>
      <span className="ppm-counts" role="cell">
        {op.onTime}/{op.total} on time · {op.cancelVeryLate} cancelled
      </span>
      <span className="ppm-status" role="cell">
        <StatusChip status={op.status} />
      </span>
    </div>
  );
}

export default async function StatusPage() {
  const data = await getNetworkPunctuality();
  const tflLines = tflConfigured() ? await lineStatus(TFL_RAIL_MODES) : [];
  const indicatorsByName = disruptionsConfigured()
    ? await serviceIndicatorsByToc().catch(() => new Map<string, ServiceIndicator>())
    : new Map<string, ServiceIndicator>();
  const networkDisruptions = disruptionsConfigured()
    ? await fetchNetworkDisruptions().catch(() => [] as Disruption[])
    : [];
  const engineeringWorks = await getPlannedEngineeringWorks();

  const hasPunctuality = Boolean(data.national) || data.operators.length > 0;
  const hasAnything = hasPunctuality || tflLines.length > 0 || engineeringWorks.length > 0;

  return (
    <main>
      <div className="results-head">
        <h1>Network status</h1>
        <span className="when">
          {data.updatedAt ? <BoardRefresher intervalMs={60_000} /> : "no data yet"}
        </span>
      </div>

      {!hasAnything ? (
        <div className="notice">
          <h2>No status data yet</h2>
          <p>
            The Network Rail RTPPM feed hasn&rsquo;t reported yet. Make sure{" "}
            <code>services/nr-ingest</code> is running, then refresh.
          </p>
        </div>
      ) : (
        <div className="status-panel">
          {hasPunctuality && (
            <section className="status-section" aria-label="National punctuality">
              <div className="status-section-head">
                <span className="status-section-title">National punctuality</span>
                <span className="status-section-note">
                  Network Rail RTPPM
                  {disruptionsConfigured() && " · National Rail Disruptions"}
                </span>
              </div>

              {data.national && (
                <div className="ppm-hero">
                  <div className="ppm-hero-fig">
                    <span className="ppm-hero-num">{pct(data.national.ppm)}</span>
                    <span className="ppm-hero-label">of trains on time nationally</span>
                  </div>
                  <div className="ppm-hero-meta">
                    <StatusChip status={data.national.status} />
                    <p className="ppm-hero-sub">
                      {data.national.onTime.toLocaleString()} of{" "}
                      {data.national.total.toLocaleString()} on time ·{" "}
                      {data.national.cancelVeryLate.toLocaleString()} cancelled/very late · last
                      hour {pct(data.national.rollingPpm)}
                    </p>
                  </div>
                </div>
              )}

              {data.operators.length > 0 && (
                <div role="table" aria-label="Operator punctuality">
                  {data.operators.map((op) => {
                    const name = RTPPM_TO_DISRUPTIONS_NAME[op.name] ?? op.name;
                    return (
                      <OperatorRow
                        key={op.code}
                        op={op}
                        indicator={indicatorsByName.get(name)}
                        disruptions={disruptionsFor(op, networkDisruptions)}
                      />
                    );
                  })}
                </div>
              )}

              {data.vstpToday > 0 && (
                <p className="ppm-vstp">
                  {data.vstpToday} short-notice service{data.vstpToday === 1 ? "" : "s"} added
                  today.
                </p>
              )}
            </section>
          )}

          {tflLines.length > 0 && (
            <section className="status-section" aria-label="London status">
              <div className="status-section-head">
                <span className="status-section-title">London status</span>
                <span className="status-section-note">Tube, Overground, Elizabeth line, DLR</span>
              </div>
              <div role="table">
                {tflLines.map((line) => (
                  <TflLineRow key={line.lineId} line={line} />
                ))}
              </div>
            </section>
          )}

          {engineeringWorks.length > 0 && (
            <section className="status-section" aria-label="Planned engineering works">
              <div className="status-section-head">
                <span className="status-section-title">Planned engineering works</span>
                <span className="status-section-note">National Rail Knowledgebase</span>
              </div>
              <div className="disruptions">
                {engineeringWorks.map((work) => (
                  <EngineeringWorkRow key={work.id} work={work} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
