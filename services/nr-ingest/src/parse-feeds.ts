/**
 * Parsers for the non-positioning Network Rail feeds: VSTP (short-notice
 * schedules), TSR (temporary speed restrictions) and RTPPM (per-operator
 * punctuality). Wire shapes follow the NROD wiki; every accessor is defensive
 * because these feeds are less rigorously versioned than movements.
 */

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function arr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return v === undefined || v === null ? [] : [v];
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function num(v: unknown): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Epoch ms arrive as numbers or numeric strings; some fields are ISO dates. */
function when(v: unknown): Date | undefined {
  const n = num(v);
  if (n !== undefined && n > 1_000_000_000) return new Date(n < 1e12 ? n * 1000 : n);
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : undefined;
}

// ---------------------------------------------------------------------------
// VSTP
// ---------------------------------------------------------------------------

export interface VstpSchedule {
  id: string;
  trainUid: string;
  startDate?: string;
  endDate?: string;
  stpIndicator?: string;
  transactionType?: string;
  headcode?: string;
  originTiploc?: string;
  destTiploc?: string;
  /** The full schedule_location list, kept verbatim for later use. */
  schedule: unknown[];
}

export function parseVstp(value: string): VstpSchedule[] {
  let root: unknown;
  try {
    root = JSON.parse(value);
  } catch {
    return [];
  }
  const out: VstpSchedule[] = [];
  for (const msg of arr(root)) {
    const sched = obj(obj(obj(msg).VSTPCIFMsgV1).schedule);
    const trainUid = str(sched.CIF_train_uid);
    if (!trainUid) continue;
    const startDate = str(sched.schedule_start_date);
    const stp = str(sched.CIF_stp_indicator);
    const segments: Json[] = arr(sched.schedule_segment).map(obj);
    const locations: Json[] = segments.flatMap((s) => arr(s.schedule_location).map(obj));
    const tiplocOf = (l: Json | undefined) => str(obj(obj(obj(l).location).tiploc).tiploc_id);
    out.push({
      id: `${trainUid}|${startDate ?? ""}|${stp ?? ""}`,
      trainUid,
      startDate,
      endDate: str(sched.schedule_end_date),
      stpIndicator: stp,
      transactionType: str(sched.transaction_type),
      headcode: segments.map((s) => str(s.signalling_id)).find(Boolean),
      originTiploc: locations.length ? tiplocOf(locations[0]) : undefined,
      destTiploc: locations.length ? tiplocOf(locations[locations.length - 1]) : undefined,
      schedule: locations,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// TSR
// ---------------------------------------------------------------------------

export interface Tsr {
  tsrId: string;
  routeGroup?: string;
  routeCode?: string;
  fromStanox?: string;
  toStanox?: string;
  lineName?: string;
  direction?: string;
  passengerSpeedMph?: number;
  freightSpeedMph?: number;
  validFrom?: Date;
  validTo?: Date;
  reason?: string;
  raw: Json;
}

export function parseTsr(value: string): Tsr[] {
  let root: unknown;
  try {
    root = JSON.parse(value);
  } catch {
    return [];
  }
  const out: Tsr[] = [];
  for (const msg of arr(root)) {
    const batch = obj(obj(msg).TSRBatchMsgV1);
    const routeGroup = str(batch.routeGroup) ?? str(batch.routeGroupCode);
    for (const t of arr(batch.tsr).map(obj)) {
      const tsrId = str(t.TSRID) ?? str(t.TSRReference);
      if (!tsrId) continue;
      out.push({
        tsrId,
        routeGroup: str(t.RouteGroupName) ?? routeGroup,
        routeCode: str(t.RouteCode),
        fromStanox: str(t.FromLocation),
        toStanox: str(t.ToLocation),
        lineName: str(t.LineName),
        direction: str(t.Direction),
        passengerSpeedMph: num(t.PassengerSpeed),
        freightSpeedMph: num(t.FreightSpeed),
        validFrom: when(t.ValidFromDate),
        validTo: when(t.ValidToDate),
        reason: str(t.Reason),
        raw: t,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RTPPM
// ---------------------------------------------------------------------------

export interface RtppmRow {
  operatorCode: string;
  operatorName?: string;
  total?: number;
  onTime?: number;
  late?: number;
  cancelVeryLate?: number;
  ppm?: number;
  rollingPpm?: number;
}

/** PPM values arrive as {text:"89", rag:"A"}; -1 means "not measured". */
function ppmValue(v: unknown): number | undefined {
  const n = num(obj(v).text ?? v);
  return n !== undefined && n >= 0 ? n : undefined;
}

function operatorRow(op: Json, fallbackCode: string): RtppmRow | null {
  const code = str(op.code) ?? fallbackCode;
  if (!code) return null;
  return {
    operatorCode: code,
    operatorName: str(op.name),
    total: num(op.Total),
    onTime: num(op.OnTime),
    late: num(op.Late),
    cancelVeryLate: num(op.CancelVeryLate),
    ppm: ppmValue(op.PPM),
    rollingPpm: ppmValue(op.RollingPPM),
  };
}

export function parseRtppm(value: string): RtppmRow[] {
  let root: unknown;
  try {
    root = JSON.parse(value);
  } catch {
    return [];
  }
  const out: RtppmRow[] = [];
  for (const msg of arr(root)) {
    const data = obj(obj(obj(msg).RTPPMDataMsgV1).RTPPMData);

    const national = operatorRow(obj(obj(data.NationalPage).NationalPPM), "NATIONAL");
    if (national) {
      national.operatorCode = "NATIONAL";
      national.operatorName ??= "National";
      out.push(national);
    }

    for (const page of arr(data.OperatorPage).map(obj)) {
      for (const op of arr(page.Operator).map(obj)) {
        const row = operatorRow(op, "");
        if (row) out.push(row);
      }
    }
  }
  return out;
}
