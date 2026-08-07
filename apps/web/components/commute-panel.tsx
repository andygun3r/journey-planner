"use client";

import { useState } from "react";
import type { ActiveLeg } from "@signaller/shared";
import { BackupRoutes } from "@/components/backup-routes";
import { Departures } from "@/components/commute-departures";
import { CommuteWalkthrough } from "@/components/commute-walkthrough";
import type { JourneyView } from "@/lib/journeys";

interface Props {
  leg: ActiveLeg;
  journeys: JourneyView[];
}

/**
 * Owns "which journey is the walkthrough following right now" — the primary
 * live plan by default, or an alternative the user one-click switched to via
 * BackupRoutes. Re-fetching the page (BoardRefresher) resets back to the
 * fresh primary journey, matching the "always live" re-route intent.
 */
export function CommutePanel({ leg, journeys }: Props) {
  const [active, setActive] = useState<JourneyView | null>(null);
  const primary = journeys[0];
  const shown = active ?? primary;

  return (
    <>
      {shown && <CommuteWalkthrough journey={shown} leg={leg} />}
      <Departures journeys={journeys} />

      <section className="commute-backup">
        <p className="editor-hint">Train cancelled or delayed? See other ways to get there.</p>
        <BackupRoutes
          originCrs={leg.originCrs}
          destCrs={leg.destCrs}
          originLabel={leg.originLabel}
          destLabel={leg.destLabel}
          backupOriginCrs={leg.backupOriginCrs}
          backupDestCrs={leg.backupDestCrs}
          backupNote={leg.backupNote}
          onSwitch={setActive}
          activeJourneyId={active?.id}
        />
      </section>
    </>
  );
}
