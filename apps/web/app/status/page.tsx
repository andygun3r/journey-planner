import { BoardRefresher } from "@/components/board-refresher";
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

function OperatorRow({ op }: { op: OperatorPunctuality }) {
  return (
    <div className="ppm-row" role="row">
      <span className="ppm-op" role="cell">
        {op.name}
      </span>
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

  return (
    <main>
      <div className="results-head">
        <h1>Network status</h1>
        <span className="when">
          {data.updatedAt ? <BoardRefresher intervalMs={60_000} /> : "no data yet"}
        </span>
      </div>

      {!data.national && data.operators.length === 0 ? (
        <div className="notice">
          <h2>No punctuality data yet</h2>
          <p>
            The Network Rail RTPPM feed hasn&rsquo;t reported yet. Make sure{" "}
            <code>services/nr-ingest</code> is running, then refresh.
          </p>
        </div>
      ) : (
        <>
          {data.national && (
            <section className="ppm-hero" aria-label="National punctuality">
              <div className="ppm-hero-fig">
                <span className="ppm-hero-num">{pct(data.national.ppm)}</span>
                <span className="ppm-hero-label">of trains on time nationally</span>
              </div>
              <div className="ppm-hero-meta">
                <StatusChip status={data.national.status} />
                <p className="ppm-hero-sub">
                  {data.national.onTime.toLocaleString()} of{" "}
                  {data.national.total.toLocaleString()} on time ·{" "}
                  {data.national.cancelVeryLate.toLocaleString()} cancelled/very late · last hour{" "}
                  {pct(data.national.rollingPpm)}
                </p>
              </div>
            </section>
          )}

          {data.vstpToday > 0 && (
            <p className="ppm-vstp">
              {data.vstpToday} short-notice service{data.vstpToday === 1 ? "" : "s"} added today.
            </p>
          )}

          {data.operators.length > 0 && (
            <section className="ppm-table" role="table" aria-label="Operator punctuality">
              <div className="ppm-row ppm-head" role="row">
                <span role="columnheader">Operator</span>
                <span role="columnheader">Today</span>
                <span role="columnheader">Last hr</span>
                <span role="columnheader">Detail</span>
                <span role="columnheader">Status</span>
              </div>
              {data.operators.map((op) => (
                <OperatorRow key={op.code} op={op} />
              ))}
            </section>
          )}

          <p className="ppm-note">
            PPM (Public Performance Measure): the share of trains arriving on time. Source: Network
            Rail Real Time PPM.
          </p>
        </>
      )}

      {tflLines.length > 0 && (
        <>
          <h2 className="tfl-heading">London status</h2>
          <section className="ppm-table tfl-table" role="table" aria-label="TfL line status">
            {tflLines.map((line) => (
              <TflLineRow key={line.lineId} line={line} />
            ))}
          </section>
          <p className="ppm-note">Tube, Overground, Elizabeth line and DLR. Source: TfL.</p>
        </>
      )}
    </main>
  );
}
