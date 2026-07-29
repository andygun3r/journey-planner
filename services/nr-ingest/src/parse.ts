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
  /**
   * TRUST's own BOOKED time for this event at this location (`planned_timestamp`).
   *
   * The single most useful field for correlation, and previously discarded.
   * Comparing a report's *actual* time to a candidate's booked time needs a wide
   * tolerance because trains run late — measured over 1,686 live movements,
   * |actual - planned| is p50 1.0min but p90 11.5min and p99 38min. Comparing
   * BOOKED to BOOKED needs no such slack, so it discriminates between two
   * candidates that a +/-90min actual-time window cannot separate.
   * Present on 98.5% of movements.
   */
  plannedTimestampMs?: number;
  /** Public (GBTT) booked time; present on ~67% — only public calls have one. */
  gbttTimestampMs?: number;
  /** Whether the booked event was an arrival/departure/destination. */
  plannedEventType?: string;
  /**
   * Stable per-service code shared with the CIF timetable. Far more selective
   * than a 4-char headcode. Present on 100% of movements.
   */
  trainServiceCode?: string;
  /** Operator code (numeric, e.g. "20"); present on 100% of movements. */
  tocId?: string;
  platform?: string;
  /** Seconds late (positive) / early (negative). */
  latenessSeconds?: number;
  nextStanox?: string;
  /** Booked minutes from here to next_report_stanox. */
  nextReportRunTimeMins?: number;
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

/**
 * A train describer S-class report: the state of one signalling address (a byte)
 * within a TD area. Individual bits are signals/points/track circuits, decoded
 * later against the SOP bit-map. SF = full byte value; SG/SH = refresh/scan.
 */
export interface SClassReport {
  kind: "sclass";
  tdArea: string;
  /** Hex address within the area. */
  address: string;
  /** Hex byte value at that address. */
  data: string;
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
        // planned/gbtt are TRUST timestamps like actual_timestamp: UK-local
        // wall-clock expressed as epoch-ms (CLAUDE.md), so they need the same
        // trustTsToUtcMs correction. Comparing a raw one against a real instant
        // would be an hour out during BST.
        const plannedTs = num(body.planned_timestamp);
        const gbttTs = num(body.gbtt_timestamp);
        const runTime = num(body.next_report_run_time);
        events.push({
          kind: "movement",
          trainId,
          eventType,
          stanox: String(stanox).trim(),
          actualTimestampMs: trustTsToUtcMs(ts),
          plannedTimestampMs: plannedTs ? trustTsToUtcMs(plannedTs) : undefined,
          gbttTimestampMs: gbttTs ? trustTsToUtcMs(gbttTs) : undefined,
          plannedEventType: (body.planned_event_type as string | undefined)?.trim() || undefined,
          trainServiceCode: (body.train_service_code as string | undefined)?.trim() || undefined,
          tocId: (body.toc_id as string | undefined)?.trim() || undefined,
          platform: (body.platform as string | undefined)?.trim() || undefined,
          latenessSeconds: lateness(body),
          nextStanox: (body.next_report_stanox as string | undefined)?.trim() || undefined,
          nextReportRunTimeMins: runTime ?? undefined,
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
      // TD `time` is already a true UTC epoch-ms (unlike TRUST's local-as-UTC
      // quirk); use it as-is. Applying the TRUST correction here pushed every
      // berth step one hour into the past during BST.
      timestampMs: Number.isFinite(ts) ? ts : Date.now(),
    });
  }
  return steps;
}

/**
 * Parse S-class signalling messages off the same TD stream. SF_MSG carries one
 * address/data byte pair; SG_MSG/SH_MSG are refresh scans whose `data` is a run
 * of consecutive bytes starting at `address` — we expand those into one report
 * per byte so downstream storage is uniform (one row per address).
 */
export function parseSClass(value: string): SClassReport[] {
  let arr: Array<
    Record<string, { area_id?: string; address?: string; data?: string; time?: string }>
  >;
  try {
    arr = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const reports: SClassReport[] = [];
  for (const msg of arr) {
    const sf = msg.SF_MSG;
    const refresh = msg.SG_MSG ?? msg.SH_MSG;
    const m = sf ?? refresh;
    if (!m || !m.area_id || m.address === undefined || m.data === undefined) continue;
    const tdArea = m.area_id.trim();
    const ts = Number(m.time);
    // S-class rides the same TD stream as berth steps: `time` is already true
    // UTC epoch-ms, so use it as-is (the TRUST local-as-UTC correction would
    // wrongly shift it an hour during BST — see parseTd).
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();
    const startAddr = parseInt(m.address, 16);
    const hex = m.data.trim();

    if (sf) {
      // Single address, single byte.
      reports.push({ kind: "sclass", tdArea, address: normAddr(startAddr), data: normByte(hex), timestampMs });
    } else if (Number.isFinite(startAddr)) {
      // Refresh scan: split `data` into bytes across consecutive addresses.
      for (let i = 0; i * 2 + 2 <= hex.length; i++) {
        const byte = hex.slice(i * 2, i * 2 + 2);
        reports.push({
          kind: "sclass",
          tdArea,
          address: normAddr(startAddr + i),
          data: normByte(byte),
          timestampMs,
        });
      }
    }
  }
  return reports;
}

/** Two-digit lowercase hex address, so lookups are stable across messages. */
function normAddr(n: number): string {
  return n.toString(16).toLowerCase().padStart(2, "0");
}
function normByte(hex: string): string {
  return hex.toLowerCase().padStart(2, "0").slice(-2);
}
