import type { BoardDeparture } from "./board";

/**
 * Client for the RDG "Live Departure Board" REST API (LDBWS / OpenLDBWS
 * staff-style GetDepBoardWithDetails). This is the board's PRIMARY live
 * source: one call per station returns real platforms, live estimates,
 * cancellations, operator and disruption messages.
 *
 * Auth: consumer key in the `x-apikey` header.
 */

interface LdbwsLocation {
  locationName?: string;
  crs?: string;
}

interface LdbwsCoach {
  coachClass?: string;
  loading?: number;
  loadingSpecified?: boolean;
  number?: string;
}

interface LdbwsService {
  std?: string; // scheduled departure "HH:MM"
  etd?: string; // "On time" | "HH:MM" | "Delayed" | "Cancelled"
  platform?: string;
  operator?: string;
  operatorCode?: string;
  isCancelled?: boolean;
  cancelReason?: string;
  delayReason?: string;
  destination?: LdbwsLocation[];
  serviceID?: string;
  length?: number;
  formation?: { coaches?: LdbwsCoach[] };
}

interface LdbwsResponse {
  locationName?: string;
  crs?: string;
  generatedAt?: string;
  filterLocationName?: string;
  nrccMessages?: Array<{ value?: string } | string>;
  trainServices?: LdbwsService[] | null;
}

export interface LdbwsBoard {
  crs: string;
  stationName: string;
  generatedAt: string;
  /** Name of the "calling at" filter station, when one was applied. */
  filterName?: string;
  messages: string[];
  departures: BoardDeparture[];
}

export function ldbwsConfigured(): boolean {
  return Boolean(process.env.LDBWS_API_KEY && process.env.LDBWS_BASE_URL);
}

/**
 * Turn a "HH:MM" UK-local time into an ISO instant, anchored to the board's
 * generatedAt date. Times up to ~3h before "now" are assumed to be tomorrow
 * (a board can list services past midnight).
 */
function toIso(hhmm: string, reference: Date): string | undefined {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return undefined;
  const hours = Number(m[1]);
  const mins = Number(m[2]);

  // Build the candidate in Europe/London terms by comparing wall-clock minutes.
  const refParts = ukParts(reference);
  const candidateMinutes = hours * 60 + mins;
  const refMinutes = refParts.hour * 60 + refParts.minute;
  let dayShift = 0;
  if (candidateMinutes - refMinutes < -180) dayShift = 1; // crossed midnight

  const base = new Date(reference.getTime() + dayShift * 86_400_000);
  const parts = ukParts(base);
  // Compose an ISO with the London offset for that date.
  const offset = londonOffset(base);
  const yyyy = String(parts.year).padStart(4, "0");
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  const hh = String(hours).padStart(2, "0");
  const mi = String(mins).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00${offset}`;
}

const ukDtf = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function ukParts(d: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const p = Object.fromEntries(ukDtf.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour === "24" ? "00" : p.hour),
    minute: Number(p.minute),
  };
}

/** London UTC offset ("+00:00" or "+01:00") for the given instant. */
function londonOffset(d: Date): string {
  const p = ukParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const diffMin = Math.round((asUtc - d.getTime()) / 60000);
  const sign = diffMin >= 0 ? "+" : "-";
  const abs = Math.abs(diffMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function parseService(svc: LdbwsService, reference: Date): BoardDeparture | null {
  if (!svc.std) return null;
  const scheduled = toIso(svc.std, reference);
  if (!scheduled) return null;

  const dest = svc.destination?.[0];
  const etd = (svc.etd ?? "").trim();
  const cancelled = svc.isCancelled === true || /cancel/i.test(etd);

  let status: BoardDeparture["status"];
  let live: string | undefined;
  let delayMinutes: number | undefined;

  if (cancelled) {
    status = "cancelled";
  } else if (/^on time$/i.test(etd)) {
    status = "on-time";
  } else if (/^\d{2}:\d{2}$/.test(etd)) {
    live = toIso(etd, reference);
    if (live && scheduled) {
      delayMinutes = Math.round((Date.parse(live) - Date.parse(scheduled)) / 60000);
    }
    status = delayMinutes && delayMinutes > 1 ? "delayed" : "on-time";
  } else if (/delay/i.test(etd)) {
    status = "delayed"; // "Delayed" with no estimate yet
  } else {
    // No etd, or unrecognised LDBWS text ("No report", "Bus", "Starts here")
    // — not a confirmed on-time status, so don't claim one.
    status = "scheduled";
  }

  const coachCount = svc.formation?.coaches?.length || svc.length || undefined;
  // LDBWS gives a full human sentence for cancellations and delays, available
  // for every operator (unlike coach formation). Prefer the relevant one.
  const reason =
    cancelled ? svc.cancelReason
    : status === "delayed" ? svc.delayReason
    : status === "scheduled" && etd ? etd
    : undefined;

  return {
    tripId: svc.serviceID,
    destinationName: dest?.locationName ?? "",
    destinationCrs: dest?.crs,
    operator: svc.operator,
    scheduled,
    live,
    platform: svc.platform,
    platformChanged: false,
    status,
    delayMinutes,
    reason: reason || undefined,
    coachCount: coachCount && coachCount > 0 ? coachCount : undefined,
    hasLive: true,
  };
}

export async function fetchLdbwsBoard(
  crs: string,
  limit = 20,
  callingAt?: string,
): Promise<LdbwsBoard | null> {
  const key = process.env.LDBWS_API_KEY;
  const base = process.env.LDBWS_BASE_URL;
  if (!key || !base) return null;

  // filterCrs asks LDBWS for only the trains calling at that station (LDBWS
  // knows the full pattern, so this is more accurate than a client filter).
  const params = new URLSearchParams({ numRows: String(limit) });
  if (callingAt) {
    params.set("filterCrs", callingAt);
    params.set("filterType", "to");
  }

  let res: Response;
  try {
    res = await fetch(`${base}/GetDepBoardWithDetails/${crs}?${params}`, {
      headers: { "x-apikey": key },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return null; // network/timeout — caller falls back
  }
  if (!res.ok) return null;

  const data = (await res.json()) as LdbwsResponse;
  const reference = data.generatedAt ? new Date(data.generatedAt) : new Date();

  const departures = (data.trainServices ?? [])
    .map((svc) => parseService(svc, reference))
    .filter((d): d is BoardDeparture => d !== null);

  const messages = (data.nrccMessages ?? [])
    .map((m) => (typeof m === "string" ? m : (m.value ?? "")))
    .map((html) => html.replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);

  return {
    crs: (data.crs ?? crs).toUpperCase(),
    stationName: data.locationName ?? crs,
    generatedAt: reference.toISOString(),
    filterName: data.filterLocationName,
    messages,
    departures,
  };
}
