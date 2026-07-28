/**
 * Unified journey-level status for stitched (rail + TfL) itineraries.
 *
 * A stitched journey has two live-status sources that don't share a vocabulary:
 * Darwin/NR delay minutes on the rail leg, and TfL's own line-severity scale on
 * the TfL leg. This turns both into one JourneyView-shaped status/delay, so the
 * UI shows one verdict per itinerary rather than two independently-read ones —
 * in particular, flagging when a rail delay eats the scheduled interchange
 * buffer and is likely to cost the TfL connection, not just "rail leg is late".
 *
 * Deliberately a small ordered set of threshold checks — same complexity as the
 * rail-only status logic in journeys.ts — not a scored/weighted model.
 */
import { minutesLate } from "./uk-time";

export type CombinedStatus = "on-time" | "delayed" | "disrupted" | "cancelled";

/** TfL's statusSeverity is 0-10, 10 = Good Service. Lower is worse. */
const SEVERITY_SEVERE_OR_WORSE = 4; // Severe Delays / Part Closure / Closed and below
const SEVERITY_MINOR_OR_WORSE = 7; // Minor Delays / Reduced Service and below

const MIN_SAFE_BUFFER_MINUTES = 5;

export interface StitchedStatusInput {
  railCancelled: boolean;
  tflCancelled: boolean;
  /** Scheduled rail arrival vs. live/estimated rail arrival. */
  railScheduledArrival: string;
  railLiveArrival?: string;
  /** Scheduled gap between rail arrival and TfL departure, from the plan. */
  scheduledBufferMinutes: number;
  /** Worst statusSeverity (0-10) across lines used by the TfL leg; 10 if unknown. */
  tflLineSeverity: number;
}

export interface StitchedStatusResult {
  status: CombinedStatus;
  /** Worse of rail delay and connection shortfall; undefined when on-time. */
  delayMinutes?: number;
}

export function computeStitchedStatus(input: StitchedStatusInput): StitchedStatusResult {
  if (input.railCancelled || input.tflCancelled) {
    return { status: "cancelled" };
  }

  const railDelayMinutes = minutesLate(input.railScheduledArrival, input.railLiveArrival) ?? 0;
  const effectiveBuffer = input.scheduledBufferMinutes - railDelayMinutes;
  const connectionShortfall = Math.max(-effectiveBuffer, 0);
  const delayMinutes = Math.max(railDelayMinutes, connectionShortfall);

  let status: CombinedStatus;
  if (effectiveBuffer < 0 || input.tflLineSeverity <= SEVERITY_SEVERE_OR_WORSE) {
    status = "disrupted";
  } else if (
    effectiveBuffer < MIN_SAFE_BUFFER_MINUTES ||
    input.tflLineSeverity <= SEVERITY_MINOR_OR_WORSE ||
    railDelayMinutes > 1
  ) {
    status = "delayed";
  } else {
    status = "on-time";
  }

  return { status, delayMinutes: delayMinutes > 0 ? delayMinutes : undefined };
}
