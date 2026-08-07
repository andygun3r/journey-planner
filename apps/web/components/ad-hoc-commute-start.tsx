"use client";

import { useState } from "react";
import type { ActiveLeg } from "@signaller/shared";
import { CommutePanel } from "@/components/commute-panel";
import type { JourneyView } from "@/lib/journeys";

interface QuickStart {
  homeCrs: string;
  homeLabel: string;
  workCrs: string;
  workLabel: string;
}

/** Builds a synthetic ActiveLeg good enough for CommutePanel — this is an
 *  ad-hoc journey, not a scheduled one, so window/backup/pin fields don't apply. */
function adHocLeg(direction: "am" | "pm", quickStart: QuickStart): ActiveLeg {
  const { homeCrs, homeLabel, workCrs, workLabel } = quickStart;
  const [originCrs, originLabel, destCrs, destLabel] =
    direction === "am" ? [homeCrs, homeLabel, workCrs, workLabel] : [workCrs, workLabel, homeCrs, homeLabel];
  return {
    legId: `ad-hoc-${direction}`,
    dayOfWeek: new Date().getDay(),
    direction,
    originCrs,
    originLabel,
    destCrs,
    destLabel,
    windowStart: "00:00",
    windowEnd: "23:59",
    upcoming: false,
  };
}

/**
 * Quick "go to work" / "go home" actions for when nothing is scheduled right
 * now (rest of day / day off / holiday) — plans live from right now between
 * the commute's usual stations and drops straight into the same leg-cards/
 * backup-routes panel a scheduled leg would show.
 *
 * Renders inline, not as its own card — the caller (the dashboard's "Nothing
 * right now" commute-focus section) owns the single surrounding card so the
 * buttons and whatever they produce read as one place, not a stray second
 * card sitting under the first.
 */
export function AdHocCommuteStart({ quickStart }: { quickStart: QuickStart }) {
  const [direction, setDirection] = useState<"am" | "pm" | null>(null);
  const [journeys, setJourneys] = useState<JourneyView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(dir: "am" | "pm") {
    const leg = adHocLeg(dir, quickStart);
    setDirection(dir);
    setLoading(true);
    setError(null);
    setJourneys(null);
    try {
      const res = await fetch(
        `/api/journeys?from=${encodeURIComponent(leg.originCrs)}&to=${encodeURIComponent(leg.destCrs)}`,
      );
      const data = await res.json();
      if (data.ok) {
        setJourneys(data.journeys);
      } else {
        setError(
          data.reason === "engine-offline"
            ? "Routing engine is offline right now."
            : "No journeys found right now.",
        );
      }
    } catch {
      setError("Couldn't load journeys. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (direction) {
    const leg = adHocLeg(direction, quickStart);
    return (
      <div className="ad-hoc-active">
        <div className="commute-focus-head">
          <span className="chip chip-muted">{direction === "am" ? "To work" : "Home"}</span>
          <h2>
            {leg.originLabel} <span className="commute-arrow">→</span> {leg.destLabel}
          </h2>
          <button type="button" className="btn-link" onClick={() => setDirection(null)}>
            Cancel
          </button>
        </div>
        {loading && <p className="editor-hint">Finding trains…</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {journeys && <CommutePanel leg={leg} journeys={journeys} />}
      </div>
    );
  }

  return (
    <div className="ad-hoc-start">
      <button type="button" className="btn btn-secondary" onClick={() => start("am")}>
        Go to {quickStart.workLabel}
      </button>
      <button type="button" className="btn btn-secondary" onClick={() => start("pm")}>
        Go to {quickStart.homeLabel}
      </button>
    </div>
  );
}
