import type { ActiveLeg } from "@signaller/shared";
import type { JourneyLegView, JourneyView } from "./journeys";

/**
 * A step-by-step walkthrough of a single commute journey, built purely from
 * an already-fetched JourneyView — no extra routing calls. "Go to platform 9
 * for the 08:19 to Basingstoke", "Travel to Weybridge, arrival in 10 mins",
 * "Change at Clapham Junction", "Arrive Waterloo around 08:52".
 */
export interface WalkthroughStep {
  kind: "board" | "ride" | "change" | "arrive";
  text: string;
  /** ISO instant this step is anchored to (departure, or arrival for the last step). */
  at: string;
  status: "upcoming" | "current" | "done";
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});

function t(iso: string): string {
  return timeFmt.format(new Date(iso));
}

function minutesUntil(iso: string, now: Date): number {
  return Math.round((Date.parse(iso) - now.getTime()) / 60_000);
}

function stepStatus(departs: string, arrives: string, now: Date): WalkthroughStep["status"] {
  const nowMs = now.getTime();
  if (nowMs >= Date.parse(arrives)) return "done";
  if (nowMs >= Date.parse(departs)) return "current";
  return "upcoming";
}

/**
 * Same-station walk "legs" are just transfer time, matching the filter
 * already used by the /journeys detail view (LegRows in app/journeys/page.tsx).
 */
function meaningfulLegs(journey: JourneyView): JourneyLegView[] {
  return journey.legs.filter((leg) => !(leg.mode === "walk" && leg.originCrs === leg.destCrs));
}

/**
 * Builds the ordered walkthrough for a journey. `leg` supplies the commute's
 * human labels for the very first/last step (home/work labels read better
 * than raw station names picked up from the routing engine).
 */
export function buildWalkthrough(journey: JourneyView, leg: ActiveLeg, now: Date = new Date()): WalkthroughStep[] {
  const legs = meaningfulLegs(journey);
  if (legs.length === 0) return [];

  const steps: WalkthroughStep[] = [];

  legs.forEach((railLeg, i) => {
    const isFirst = i === 0;
    const departs = railLeg.departs;
    const arrives = railLeg.arrives;

    if (railLeg.mode === "rail" && (isFirst || !railLeg.staySeated)) {
      if (!isFirst) {
        steps.push({
          kind: "change",
          text: `Change at ${railLeg.originName}.`,
          at: departs,
          status: stepStatus(departs, departs, now),
        });
      }
      const boardText = isFirst
        ? `Go to ${leg.originLabel} for the ${t(departs)} service to ${legs[legs.length - 1]!.destName}.`
        : `Board the ${t(departs)} service to ${legs[legs.length - 1]!.destName}.`;
      steps.push({ kind: "board", text: boardText, at: departs, status: stepStatus(departs, departs, now) });
    } else if (railLeg.staySeated) {
      steps.push({
        kind: "ride",
        text: "Stay seated — the train continues as one service.",
        at: departs,
        status: stepStatus(departs, departs, now),
      });
    }

    if (railLeg.mode === "rail") {
      const status = stepStatus(departs, arrives, now);
      const mins = minutesUntil(arrives, now);
      const arrivalPhrase =
        status === "done"
          ? `Arrived ${t(arrives)}.`
          : status === "current" && mins > 0
            ? `Arrival in ${mins} min${mins === 1 ? "" : "s"}.`
            : `Arrives ${t(arrives)}.`;
      const nextStop = railLeg.nextCallName ? ` Next stop: ${railLeg.nextCallName}.` : "";
      steps.push({
        kind: "ride",
        text: `Travel to ${railLeg.destName}. ${arrivalPhrase}${nextStop}`,
        at: arrives,
        status,
      });
    }
  });

  const last = legs[legs.length - 1]!;
  steps.push({
    kind: "arrive",
    text: `Arrive ${leg.destLabel} around ${t(last.arrives)}.`,
    at: last.arrives,
    status: stepStatus(last.arrives, last.arrives, now),
  });

  return steps;
}
