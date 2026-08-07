"use client";

import Link from "next/link";
import type { ActiveLeg } from "@signaller/shared";
import { LiveCountdown } from "@/components/live-countdown";
import type { LiveJourneyLeg, LiveJourneyView } from "@/lib/journey-live";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});
const t = (iso: string) => timeFmt.format(new Date(iso));

/**
 * One card per train the user actually boards — a direct commute is one
 * card, a commute with a change is two. Each card is the live picture for
 * that specific service: platform, where it physically is, and whether it's
 * running. This replaces the old text-only walkthrough plus a separate
 * "next departures" list — the cards ARE the departures now, just live and
 * one train at a time instead of a flat list of options.
 */

function railLegs(journey: LiveJourneyView): LiveJourneyLeg[] {
  return journey.legs.filter((leg) => !(leg.mode === "walk" && leg.originCrs === leg.destCrs));
}

/** True once this leg has arrived — used to grey the card out. */
function isPast(leg: LiveJourneyLeg, now: number): boolean {
  return Date.parse(leg.arrives) <= now;
}

/** True while this leg is the one currently being ridden. */
function isCurrent(leg: LiveJourneyLeg, now: number): boolean {
  return Date.parse(leg.departs) <= now && now < Date.parse(leg.arrives);
}

function LegCard({
  leg,
  index,
  isFirst,
  isLast,
  homeLabel,
  workLabel,
  now,
}: {
  leg: LiveJourneyLeg;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  homeLabel: string;
  workLabel: string;
  now: number;
}) {
  const live = leg.live;
  const disrupted = leg.cancelled || live?.status === "cancelled";
  const delayed = !disrupted && live?.status === "delayed";
  const past = isPast(leg, now);
  const current = isCurrent(leg, now);
  const origin = isFirst ? homeLabel : leg.originName;
  const dest = isLast ? workLabel : leg.destName;

  const stateClass = disrupted
    ? "leg-card-disrupted"
    : delayed
      ? "leg-card-delayed"
      : past
        ? "leg-card-past"
        : current
          ? "leg-card-current"
          : "";

  return (
    <li className={`leg-card ${stateClass}`} aria-current={current ? "step" : undefined}>
      <div className="leg-card-head">
        <span className="leg-card-kind">{leg.staySeated ? "Stay seated" : isFirst ? "Board" : "Change"}</span>
        {live?.platform && (
          <span className="leg-card-plat">
            <span className="leg-card-plat-label">Plat</span> {live.platform}
          </span>
        )}
      </div>

      <div className="leg-card-route">
        <div className="leg-card-stop">
          <span className="leg-card-time">{t(leg.departs)}</span>
          <span className="leg-card-name">{origin}</span>
        </div>
        <span className="leg-card-arrow" aria-hidden="true">
          →
        </span>
        <div className="leg-card-stop leg-card-stop-end">
          <span className="leg-card-time">{t(leg.arrives)}</span>
          <span className="leg-card-name">{dest}</span>
        </div>
      </div>

      <p className="leg-card-meta">
        {leg.operator ?? "Rail service"}
        {leg.callCount > 0 ? ` · ${leg.callCount} stop${leg.callCount === 1 ? "" : "s"}` : " · non-stop"}
      </p>

      {disrupted ? (
        <p className="leg-card-status leg-card-status-danger">
          {leg.cancelled ? "This train is cancelled." : "Cancelled — check the alternatives below."}
        </p>
      ) : delayed ? (
        <p className="leg-card-status leg-card-status-warn">
          Running {live?.delayMinutes ? `${live.delayMinutes} min late` : "late"}
        </p>
      ) : live?.positionLabel ? (
        <p className="leg-card-status leg-card-status-live">{live.positionLabel}</p>
      ) : past ? (
        <p className="leg-card-status leg-card-status-done">Departed</p>
      ) : (
        <p className="leg-card-status">
          {index === 0 ? <LiveCountdown iso={leg.departs} /> : "Scheduled"}
        </p>
      )}

      {live?.serviceId && (
        <Link href={`/services/${live.serviceId}`} className="leg-card-service-link">
          View service →
        </Link>
      )}
    </li>
  );
}

export function CommuteLegCards({ journey, leg }: { journey: LiveJourneyView; leg: ActiveLeg }) {
  const legs = railLegs(journey).filter((l) => l.mode === "rail" || l.staySeated);
  if (legs.length === 0) return null;
  const now = Date.now();

  return (
    <ol className="leg-cards" aria-label="Journey walkthrough">
      {legs.map((l, i) => (
        <LegCard
          key={`${l.originCrs}-${l.departs}`}
          leg={l}
          index={i}
          isFirst={i === 0}
          isLast={i === legs.length - 1}
          homeLabel={leg.originLabel}
          workLabel={leg.destLabel}
          now={now}
        />
      ))}
    </ol>
  );
}
