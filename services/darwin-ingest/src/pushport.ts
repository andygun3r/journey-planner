/**
 * Parser for the RDM Darwin Push Port v18 JSON feed.
 *
 * Wire shape (verified against the live feed):
 *   Outer JMS envelope: { destination, messageID, bytes: "<json string>", ... }
 *   Inner (bytes parsed): { ts, version, uR: { updateOrigin?, TS?|schedule?|deactivated?|OW?, ... } }
 *
 * We model the update kinds we act on: TS (train status forecast),
 * schedule (new/updated schedule incl. cancellation), deactivated.
 * `plat` is either a string or an object whose "" key holds the number.
 */

export interface ParsedStopForecast {
  tiploc: string;
  seq: number;
  wta?: string;
  wtd?: string;
  pta?: string;
  ptd?: string;
  arrEt?: string;
  arrAt?: string;
  depEt?: string;
  depAt?: string;
  platform?: string;
  platformConfirmed: boolean;
  suppressed: boolean;
}

export interface ParsedTS {
  kind: "TS";
  rid: string;
  uid: string;
  ssd: string;
  lateReason?: string;
  stops: ParsedStopForecast[];
}

/** One stop in a schedule's ordered calling pattern (no live times — just the plan). */
export interface ParsedScheduleStop {
  tiploc: string;
  seq: number;
  wta?: string;
  wtd?: string;
}

export interface ParsedSchedule {
  kind: "schedule";
  rid: string;
  uid: string;
  ssd: string;
  toc?: string;
  cancelled: boolean;
  cancelReason?: string;
  /**
   * The full, stably-ordered calling pattern from the SC message. This is the
   * authoritative seq source: TS messages only carry a shifting subset of
   * stops near the train's current position, so an index into a TS message's
   * own location list is NOT a stable seq (see applyTS in store.ts).
   */
  stops: ParsedScheduleStop[];
}

export interface ParsedDeactivation {
  kind: "deactivated";
  rid: string;
}

export interface ParsedCoach {
  number: string;
  coachClass?: string;
  first: boolean;
  /** Live loading percentage 0-100, from formationLoading. */
  loading?: number;
}

/** scheduleFormations: the planned coach layout for a train run. */
export interface ParsedFormation {
  kind: "formation";
  rid: string;
  fid: string;
  coaches: ParsedCoach[];
}

/** formationLoading: live per-coach loading at a stop. */
export interface ParsedLoading {
  kind: "loading";
  rid: string;
  fid: string;
  loading: Array<{ number: string; percent: number }>;
}

export type ParsedUpdate =
  | ParsedTS
  | ParsedSchedule
  | ParsedDeactivation
  | ParsedFormation
  | ParsedLoading;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** plat is "5" or { platsup, platsrc, conf, "": "5" }. */
function readPlatform(plat: unknown): { platform?: string; confirmed: boolean; suppressed: boolean } {
  if (plat === undefined || plat === null) return { confirmed: false, suppressed: false };
  if (typeof plat === "string") return { platform: plat, confirmed: false, suppressed: false };
  if (typeof plat === "object") {
    const o = plat as Record<string, string>;
    return {
      platform: o[""] ?? undefined,
      confirmed: o.conf === "true",
      suppressed: o.platsup === "true",
    };
  }
  return { confirmed: false, suppressed: false };
}

interface RawTime {
  et?: string;
  at?: string;
  wet?: string;
}

interface RawLocation {
  tpl?: string;
  wta?: string;
  wtd?: string;
  pta?: string;
  ptd?: string;
  arr?: RawTime;
  dep?: RawTime;
  plat?: unknown;
}

function parseTS(ts: Record<string, unknown>): ParsedTS | null {
  const rid = ts.rid as string | undefined;
  const uid = ts.uid as string | undefined;
  const ssd = ts.ssd as string | undefined;
  if (!rid || !uid || !ssd) return null;

  const locations = asArray(ts.Location as RawLocation | RawLocation[] | undefined);
  const stops: ParsedStopForecast[] = locations
    .filter((loc) => loc.tpl)
    .map((loc, seq) => {
      const plat = readPlatform(loc.plat);
      return {
        tiploc: loc.tpl!,
        seq,
        wta: loc.wta,
        wtd: loc.wtd,
        pta: loc.pta,
        ptd: loc.ptd,
        arrEt: loc.arr?.et,
        arrAt: loc.arr?.at,
        depEt: loc.dep?.et,
        depAt: loc.dep?.at,
        platform: plat.platform,
        platformConfirmed: plat.confirmed,
        suppressed: plat.suppressed,
      };
    });

  return {
    kind: "TS",
    rid,
    uid,
    ssd,
    lateReason: ts.LateReason as string | undefined,
    stops,
  };
}

/**
 * The SC message's calling pattern arrives as separate OR/OPOR (origin),
 * IP/OPIP (intermediate), and DT/OPDT (destination) arrays, each holding
 * Location-shaped stops in schedule order. Concatenating OR -> IP -> DT gives
 * the full, stably-ordered pattern; the "OP" (operational, non-public)
 * variants are passenger-invisible stops we still want for seq stability.
 */
function scheduleLocations(sch: Record<string, unknown>): RawLocation[] {
  const keys = ["OR", "OPOR", "IP", "OPIP", "PP", "DT", "OPDT"];
  const locs: RawLocation[] = [];
  for (const key of keys) {
    locs.push(...asArray(sch[key] as RawLocation | RawLocation[] | undefined));
  }
  return locs;
}

function parseSchedule(sch: Record<string, unknown>): ParsedSchedule | null {
  const rid = sch.rid as string | undefined;
  const uid = sch.uid as string | undefined;
  const ssd = sch.ssd as string | undefined;
  if (!rid || !uid || !ssd) return null;
  // A <cancelReason> child (or isPassengerSvc + cancel) marks cancellation.
  const cancelReason = sch.cancelReason as
    | { "" ?: string; [k: string]: unknown }
    | string
    | undefined;
  const reasonCode =
    typeof cancelReason === "string" ? cancelReason : (cancelReason?.[""] as string | undefined);

  const stops: ParsedScheduleStop[] = scheduleLocations(sch)
    .filter((loc) => loc.tpl)
    .map((loc, seq) => ({
      tiploc: loc.tpl!,
      seq,
      wta: loc.wta,
      wtd: loc.wtd,
    }));

  return {
    kind: "schedule",
    rid,
    uid,
    ssd,
    toc: sch.toc as string | undefined,
    cancelled: cancelReason !== undefined,
    cancelReason: reasonCode,
    stops,
  };
}

function parseFormation(sf: Record<string, unknown>): ParsedFormation | null {
  const rid = sf.rid as string | undefined;
  const formation = sf.formation as Record<string, unknown> | undefined;
  if (!rid || !formation) return null;
  const fid = (formation.fid as string | undefined) ?? "";
  const coachContainer = formation.coaches as { coach?: unknown } | undefined;
  const coachList = asArray(coachContainer?.coach as Record<string, unknown> | Record<string, unknown>[]);
  const coaches: ParsedCoach[] = coachList
    .map((c): ParsedCoach | null => {
      const number = c.coachNumber as string | undefined;
      const coachClass = c.coachClass as string | undefined;
      if (!number) return null;
      return { number, coachClass, first: /first/i.test(coachClass ?? "") };
    })
    .filter((c): c is ParsedCoach => c !== null);
  if (coaches.length === 0) return null;
  return { kind: "formation", rid, fid, coaches };
}

function parseLoading(fl: Record<string, unknown>): ParsedLoading | null {
  const rid = fl.rid as string | undefined;
  const fid = (fl.fid as string | undefined) ?? "";
  if (!rid) return null;
  const rawLoading = asArray(fl.loading as Record<string, unknown> | Record<string, unknown>[]);
  const loading = rawLoading
    .map((l) => {
      const number = l.coachNumber as string | undefined;
      const pct = l[""] as string | undefined;
      if (!number || pct === undefined) return null;
      const percent = Number(pct);
      return Number.isFinite(percent) ? { number, percent } : null;
    })
    .filter((l): l is { number: string; percent: number } => l !== null);
  if (loading.length === 0) return null;
  return { kind: "loading", rid, fid, loading };
}

/** Parse one Kafka message value (the JMS envelope string) into updates. */
export function parseMessage(value: string): ParsedUpdate[] {
  let envelope: { bytes?: string; text?: string };
  try {
    envelope = JSON.parse(value);
  } catch {
    return [];
  }
  const inner = envelope.bytes ?? envelope.text;
  if (!inner) return [];

  let payload: { uR?: Record<string, unknown>; UR?: Record<string, unknown> };
  try {
    payload = JSON.parse(inner);
  } catch {
    return [];
  }
  const ur = payload.uR ?? payload.UR;
  if (!ur) return [];

  const updates: ParsedUpdate[] = [];
  for (const ts of asArray(ur.TS as Record<string, unknown> | Record<string, unknown>[])) {
    const parsed = parseTS(ts);
    if (parsed) updates.push(parsed);
  }
  for (const sch of asArray(ur.schedule as Record<string, unknown> | Record<string, unknown>[])) {
    const parsed = parseSchedule(sch);
    if (parsed) updates.push(parsed);
  }
  for (const d of asArray(ur.deactivated as Record<string, unknown> | Record<string, unknown>[])) {
    const rid = d.rid as string | undefined;
    if (rid) updates.push({ kind: "deactivated", rid });
  }
  for (const sf of asArray(
    ur.scheduleFormations as Record<string, unknown> | Record<string, unknown>[],
  )) {
    const parsed = parseFormation(sf);
    if (parsed) updates.push(parsed);
  }
  for (const fl of asArray(
    ur.formationLoading as Record<string, unknown> | Record<string, unknown>[],
  )) {
    const parsed = parseLoading(fl);
    if (parsed) updates.push(parsed);
  }
  return updates;
}
