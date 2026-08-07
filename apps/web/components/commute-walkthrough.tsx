"use client";

import type { ActiveLeg } from "@signaller/shared";
import { buildWalkthrough } from "@/lib/commute-walkthrough";
import type { JourneyView } from "@/lib/journeys";

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/London",
});
const t = (iso: string) => timeFmt.format(new Date(iso));

const KIND_LABEL: Record<string, string> = {
  board: "Board",
  ride: "Ride",
  change: "Change",
  arrive: "Arrive",
};

interface Props {
  journey: JourneyView;
  leg: ActiveLeg;
}

/**
 * Step-by-step walkthrough of the train(s) to catch right now, built from the
 * best matching live journey — "Go to Weybridge for the 08:19", "Travel to
 * Surbiton, arrival in 10 mins", "Arrive Waterloo around 08:52". The current
 * step is highlighted so it reads at a glance, departure-board style.
 */
export function CommuteWalkthrough({ journey, leg }: Props) {
  const steps = buildWalkthrough(journey, leg, new Date());
  if (steps.length === 0) return null;

  return (
    <ol className="commute-walkthrough" aria-label="Journey walkthrough">
      {steps.map((step, i) => (
        <li
          key={i}
          className={`walkthrough-step walkthrough-${step.status}`}
          aria-current={step.status === "current" ? "step" : undefined}
        >
          <span className="walkthrough-kind">{KIND_LABEL[step.kind]}</span>
          <span className="walkthrough-time">{t(step.at)}</span>
          <span className="walkthrough-text">{step.text}</span>
        </li>
      ))}
    </ol>
  );
}
