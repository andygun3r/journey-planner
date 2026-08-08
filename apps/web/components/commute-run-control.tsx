"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActiveLeg } from "@signaller/shared";
import { endCommuteAction, startCommuteAction } from "@/app/commute/actions";
import type { JourneyView } from "@/lib/journeys";

interface Props {
  commuteId: string;
  leg: ActiveLeg;
  /** The journey the user is about to travel on — stored with the run. */
  journey?: JourneyView;
  /** Set when a run is already in play, so we offer "end" instead of "start". */
  activeRun?: { id: string; startedAt: string };
}

/**
 * Start / end the commute.
 *
 * Starting locks the dashboard to this direction and this train. Without it
 * the page re-resolves the schedule every refresh and flips to the evening leg
 * the moment the morning window ends — mid-journey, which is when it's least
 * welcome. The run ends by itself on arrival, so the usual case needs no
 * second tap; "End now" is for getting out early or changing plans.
 */
export function CommuteRunControl({ commuteId, leg, journey, activeRun }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else router.refresh();
    });
  }

  if (activeRun) {
    return (
      <div className="commute-run commute-run-active">
        <p className="commute-run-state">
          <span className="commute-run-dot" aria-hidden="true" />
          Commute started — following this train until you arrive.
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending}
          onClick={() => run(() => endCommuteAction(commuteId))}
        >
          {pending ? "Ending…" : "End now"}
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="commute-run">
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        onClick={() =>
          run(() =>
            startCommuteAction({
              commuteId,
              commuteLegId: leg.legId,
              direction: leg.direction,
              originCrs: leg.originCrs,
              originLabel: leg.originLabel,
              destCrs: leg.destCrs,
              destLabel: leg.destLabel,
              journey: journey ?? null,
            }),
          )
        }
      >
        {pending ? "Starting…" : "Start commute"}
      </button>
      <p className="editor-hint">
        Locks this train in so the page doesn&rsquo;t move on while you&rsquo;re travelling.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
