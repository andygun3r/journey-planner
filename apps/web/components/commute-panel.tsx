"use client";

import { useState } from "react";
import type { ActiveLeg } from "@signaller/shared";
import { BackupRoutes } from "@/components/backup-routes";
import { CommuteLegCards } from "@/components/commute-leg-cards";
import type { LiveJourneyView } from "@/lib/journey-live";
import type { JourneyView } from "@/lib/journeys";

interface Props {
  leg: ActiveLeg;
  journeys: JourneyView[];
}

/**
 * Owns "which journey the leg cards are following right now" — the primary
 * live plan by default, or an alternative the user one-click switched to via
 * BackupRoutes. Re-fetching the page (BoardRefresher) resets back to the
 * fresh primary journey, matching the "always live" re-route intent.
 *
 * Only the walkthrough (as live leg cards) and the backup action show here —
 * the old flat "next departures" list is gone; each card already carries the
 * one train the user needs, live.
 */
export function CommutePanel({ leg, journeys }: Props) {
  const [active, setActive] = useState<LiveJourneyView | null>(null);
  // journeys[0] is enriched with live data server-side (see
  // commute-dashboard.ts); a switched-to backup is enriched by the
  // /api/journeys route BackupRoutes calls, so both are LiveJourneyView-shaped.
  const primary = journeys[0] as LiveJourneyView | undefined;
  const shown = active ?? primary;

  return (
    <>
      {shown && <CommuteLegCards journey={shown} leg={leg} />}

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
          onSwitch={(j) => setActive(j as LiveJourneyView | null)}
          activeJourneyId={active?.id}
        />
      </section>
    </>
  );
}
