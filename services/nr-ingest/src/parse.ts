/**
 * Parsers for the Network Rail STOMP feeds. Messages arrive as JSON arrays.
 * Verified shapes: movements are {header:{msg_type}, body:{...}}; TD messages
 * are {CA_MSG:{...}} | {CC_MSG:{...}} | {SF_MSG:{...}} etc.
 */

export interface MovementReport {
  kind: "movement";
  trainId: string;
  eventType: "ARRIVAL" | "DEPARTURE";
  stanox: string;
  actualTimestampMs: number;
  platform?: string;
  /** Seconds late (positive) / early (negative). */
  latenessSeconds?: number;
  nextStanox?: string;
  terminated: boolean;
}

export interface Activation {
  kind: "activation";
  trainId: string;
  /** train_uid + schedule origin, used to correlate to Darwin. */
  trainUid?: string;
  scheduleStartDate?: string;
  originStanox?: string;
}

export interface Cancellation {
  kind: "cancellation";
  trainId: string;
}

/** A train describer berth step (between-signal position). */
export interface BerthStep {
  kind: "berth";
  headcode: string;
  tdArea: string;
  fromBerth?: string;
  toBerth?: string;
  timestampMs: number;
}

export type NrEvent = MovementReport | Activation | Cancellation | BerthStep;

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * TRUST `actual_timestamp` is epoch-ms but expressed in UK LOCAL wall-clock,
 * not true UTC — so during BST every timestamp reads one hour ahead (verified
 * live: a report made at 06:45 UTC carries 07:46). Correct it to a true UTC
 * instant by subtracting London's offset for that moment.
 */
function londonOffsetMs(utcApprox: number): number {
  const d = new Date(utcApprox);
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - d.getTime();
}

/** Correct a TRUST local-wall-clock epoch-ms to a true UTC instant. */
function trustTsToUtcMs(localMs: number): number {
  // The stored value IS local-as-if-UTC; subtract the London offset at that
  // wall time to recover the real instant. One iteration is exact except in the
  // hour around a DST switch, which we accept.
  return localMs - londonOffsetMs(localMs);
}

/** timetable_variation is minutes; variation_status gives the sign. */
function lateness(body: Record<string, unknown>): number | undefined {
  const variation = num(body.timetable_variation);
  if (variation === undefined) return undefined;
  const status = String(body.variation_status ?? "").toUpperCase();
  const mins = status === "EARLY" ? -variation : variation;
  return mins * 60;
}

export function parseMovements(value: string): NrEvent[] {
  let arr: Array<{ header?: { msg_type?: string }; body?: Record<string, unknown> }>;
  try {
    arr = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const events: NrEvent[] = [];
  for (const msg of arr) {
    const type = msg.header?.msg_type;
    const body = msg.body ?? {};
    const trainId = body.train_id as string | undefined;
    if (!trainId) continue;

    if (type === "0003") {
      const eventType = String(body.event_type ?? "").toUpperCase();
      const stanox = (body.loc_stanox ?? body.reporting_stanox) as string | undefined;
      const ts = num(body.actual_timestamp);
      if ((eventType === "ARRIVAL" || eventType === "DEPARTURE") && stanox && ts) {
        events.push({
          kind: "movement",
          trainId,
          eventType,
          stanox: String(stanox).trim(),
          actualTimestampMs: trustTsToUtcMs(ts),
          platform: (body.platform as string | undefined)?.trim() || undefined,
          latenessSeconds: lateness(body),
          nextStanox: (body.next_report_stanox as string | undefined)?.trim() || undefined,
          terminated: String(body.train_terminated) === "true",
        });
      }
    } else if (type === "0001") {
      events.push({
        kind: "activation",
        trainId,
        trainUid: (body.train_uid as string | undefined)?.trim(),
        scheduleStartDate: body.schedule_start_date as string | undefined,
        originStanox: (body.sched_origin_stanox as string | undefined)?.trim(),
      });
    } else if (type === "0002") {
      events.push({ kind: "cancellation", trainId });
    }
  }
  return events;
}

export function parseTd(value: string): BerthStep[] {
  let arr: Array<Record<string, { area_id?: string; from?: string; to?: string; descr?: string; time?: string }>>;
  try {
    arr = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const steps: BerthStep[] = [];
  for (const msg of arr) {
    // CA = berth step, CC = interpose (train enters a berth). Both position a headcode.
    const m = msg.CA_MSG ?? msg.CC_MSG;
    if (!m || !m.descr || !m.area_id) continue;
    const ts = Number(m.time);
    steps.push({
      kind: "berth",
      headcode: m.descr.trim(),
      tdArea: m.area_id.trim(),
      fromBerth: m.from?.trim(),
      toBerth: m.to?.trim(),
      // TD `time` is the same UK-local-as-epoch as TRUST — correct to true UTC.
      timestampMs: Number.isFinite(ts) ? trustTsToUtcMs(ts) : Date.now(),
    });
  }
  return steps;
}
