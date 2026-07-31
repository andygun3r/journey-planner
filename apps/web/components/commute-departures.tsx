import type { JourneyView } from "@/lib/journeys";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});
const t = (iso: string) => timeFmt.format(new Date(iso));

export function StatusChip({ j }: { j: JourneyView }) {
  switch (j.status) {
    case "cancelled":
      return <span className="chip chip-danger">Cancelled</span>;
    case "delayed":
      return <span className="chip chip-warn">+{j.delayMinutes} min</span>;
    case "on-time":
      return <span className="chip chip-ok">On time</span>;
    default:
      return <span className="chip chip-muted">Scheduled</span>;
  }
}

/** The trains to catch for one journey option — inline, with change notes. */
function JourneyLegs({ journey }: { journey: JourneyView }) {
  // Drop same-station walk "legs" (pure transfer time; the change note covers it).
  const legs = journey.legs.filter(
    (leg) => !(leg.mode === "walk" && leg.originCrs === leg.destCrs),
  );
  return (
    <div className="commute-legs">
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
              <p className="leg-operator">
                {leg.mode === "walk"
                  ? "Walk"
                  : (leg.operator ?? "Rail service") +
                    (leg.callCount > 0
                      ? ` · ${leg.callCount} stop${leg.callCount === 1 ? "" : "s"}`
                      : " · non-stop")}
              </p>
              <p className="leg-station">{leg.destName}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The next real departures along the active leg, first one highlighted. Each
 * row expands in place to show the exact trains to catch for that option
 * (including any changes) — the services needed to follow the commute.
 */
export function Departures({ journeys }: { journeys: JourneyView[] }) {
  if (journeys.length === 0) {
    return (
      <p className="editor-hint">
        No upcoming trains found for this leg right now. Try the full planner.
      </p>
    );
  }
  return (
    <ol className="commute-departures">
      {journeys.map((j, i) => {
        const disrupted = j.status === "cancelled";
        return (
          <li
            key={j.id}
            className={`commute-dep ${i === 0 && !disrupted ? "commute-dep-next" : ""} ${
              disrupted ? "commute-dep-cancelled" : ""
            }`}
          >
            <details open={i === 0}>
              <summary className="commute-dep-link">
                <span className="commute-dep-time">
                  {t(j.departs)}
                  {j.liveDeparts && j.status === "delayed" && (
                    <span className="live-late"> → {t(j.liveDeparts)}</span>
                  )}
                </span>
                <span className="commute-dep-arrive">arr {t(j.arrives)}</span>
                <span className="commute-dep-meta">
                  {j.changes === 0 ? "direct" : `${j.changes} change${j.changes === 1 ? "" : "s"}`}{" "}
                  · {j.durationMinutes}m
                </span>
                {i === 0 && !disrupted && <span className="commute-dep-catch">catch this</span>}
                <StatusChip j={j} />
                <span className="commute-dep-chevron" aria-hidden="true">▸</span>
              </summary>
              <JourneyLegs journey={j} />
            </details>
          </li>
        );
      })}
    </ol>
  );
}
