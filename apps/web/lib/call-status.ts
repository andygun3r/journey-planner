import { minutesLate, parseHhmm } from "./uk-time";

/**
 * Turning a calling point's raw feed values into something displayable.
 *
 * Deliberately pure and DB-free so client components (the map's train panel)
 * and server components (the service page) derive status the same way — they
 * used to each re-parse the LDBWS strings inline, and disagreed.
 *
 * The rules encode two product commitments from PRODUCT.md:
 *
 *  - "honest uncertainty, never vague reassurance": no estimate is NOT an
 *    on-time estimate. An empty `expected` reports "No report", where this page
 *    previously printed a confident "On time" for a train nothing was known
 *    about. The board client already got this right; the service page didn't.
 *  - "status is never colour-only": every result carries a `label` in words, so
 *    a caller cannot render the colour without the text.
 *
 * Anything the feed says that we don't recognise ("Bus", "Starts here",
 * "No report") is passed through as neutral `info` rather than being coloured
 * as a delay, which is what the old catch-all branch did.
 */

export type CallProgress = "departed" | "current" | "upcoming";

export type CallStatusKind =
  | "cancelled"
  | "delayed"
  | "early"
  | "on-time"
  | "no-report"
  | "info";

export interface CallLiveStatus {
  kind: CallStatusKind;
  /** Human words for the chip. Always present. */
  label: string;
  /** Signed minutes against schedule, when both times are known. */
  deltaMinutes?: number;
}

/** The subset of a calling point this needs — ServiceCall satisfies it structurally. */
export interface CallStatusInput {
  cancelled?: boolean;
  scheduled?: string;
  scheduledIso?: string;
  expected?: string;
  expectedIso?: string;
  actual?: string;
  actualIso?: string;
}

/** Below this many minutes either way, a train is "on time" in railway terms. */
const ON_TIME_TOLERANCE = 1;

/**
 * Minutes between two times, preferring real instants and falling back to
 * wall-clock arithmetic (with a midnight-wrap guard) when only "HH:MM" is
 * available.
 */
export function callDelta(call: CallStatusInput, liveHhmm?: string, liveIso?: string): number | undefined {
  const fromInstants = minutesLate(call.scheduledIso, liveIso);
  if (fromInstants !== undefined) return fromInstants;

  const scheduled = parseHhmm(call.scheduled);
  const live = parseHhmm(liveHhmm);
  if (scheduled === null || live === null) return undefined;
  let delta = live - scheduled;
  // A pattern only ever runs forward, so a large negative is a midnight wrap,
  // not a train arriving 20 hours early.
  if (delta < -720) delta += 1440;
  if (delta > 720) delta -= 1440;
  return delta;
}

function fromDelta(delta: number, timeLabel: string): CallLiveStatus {
  if (delta > ON_TIME_TOLERANCE) {
    return { kind: "delayed", label: timeLabel, deltaMinutes: delta };
  }
  if (delta < -ON_TIME_TOLERANCE) {
    return { kind: "early", label: timeLabel, deltaMinutes: delta };
  }
  return { kind: "on-time", label: "On time", deltaMinutes: delta };
}

export function callLiveStatus(call: CallStatusInput): CallLiveStatus {
  const expected = (call.expected ?? "").trim();

  // A calling point can be cancelled by flag or by the feed writing it into the
  // estimate field. The old code only honoured the flag, so the string form
  // rendered as a delay.
  if (call.cancelled || /^cancell?ed$/i.test(expected)) {
    return { kind: "cancelled", label: "Cancelled" };
  }

  // An actual report beats any estimate — this stop is a matter of record now.
  const actual = (call.actual ?? "").trim();
  if (parseHhmm(actual) !== null) {
    const delta = callDelta(call, actual, call.actualIso);
    if (delta === undefined) return { kind: "info", label: actual };
    return fromDelta(delta, actual);
  }

  // No estimate at all: say so. Do not claim "On time".
  if (!expected) return { kind: "no-report", label: "No report" };

  if (/^on time$/i.test(expected)) return { kind: "on-time", label: "On time" };

  if (parseHhmm(expected) !== null) {
    const delta = callDelta(call, expected, call.expectedIso);
    if (delta === undefined) return { kind: "info", label: expected };
    // Show the estimate itself when it differs from the booked time.
    return fromDelta(delta, `Exp. ${expected}`);
  }

  // "Delayed" with no estimate yet — genuinely a delay, just an unquantified one.
  if (/delay/i.test(expected)) return { kind: "delayed", label: "Delayed" };

  // "Starts here", "No report", "Bus", operator-specific text: neutral, verbatim.
  return { kind: "info", label: expected };
}

/** "+4" / "−2" for the delta chip. Undefined when the train is on time. */
export function deltaChip(status: CallLiveStatus): string | undefined {
  const d = status.deltaMinutes;
  if (d === undefined || Math.abs(d) <= ON_TIME_TOLERANCE) return undefined;
  // Real minus sign: it renders legibly at chip size where a hyphen doesn't.
  return d > 0 ? `+${d}` : `−${Math.abs(d)}`;
}
