import type { JourneyView } from "@/lib/journeys";

/**
 * Shared journey-status chip — used by the results/board pages (journeys,
 * status) that still list multiple journey options side by side. The
 * commute dashboard itself no longer shows a departures list (see
 * commute-leg-cards.tsx); this file just keeps the chip available for those
 * other callers.
 */
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
