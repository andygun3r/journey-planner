import type { BoardDeparture } from "./board";
import { hhmmToIso, minutesLate } from "./uk-time";

/**
 * Client for the RDG "Live Arrival and Departure Boards" REST API (LDBWS /
 * OpenLDBWS staff-style GetArrDepBoardWithDetails). This is the board's
 * PRIMARY live source: one call per station returns real platforms, live
 * estimates, cancellations, operator and disruption messages.
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
  sta?: string; // scheduled arrival "HH:MM"
  eta?: string; // "On time" | "HH:MM" | "Delayed" | "Cancelled"
  std?: string; // scheduled departure "HH:MM"
  etd?: string; // "On time" | "HH:MM" | "Delayed" | "Cancelled"
  platform?: string;
  operator?: string;
  operatorCode?: string;
  isCancelled?: boolean;
  cancelReason?: string;
  delayReason?: string;
  origin?: LdbwsLocation[];
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
  arrivals: BoardDeparture[];
}

export function ldbwsConfigured(): boolean {
  return Boolean(process.env.LDBWS_API_KEY && process.env.LDBWS_BASE_URL);
}

/**
 * Turn a "HH:MM" UK-local time into an ISO instant, anchored to the board's
 * generatedAt date.
 *
 * This used to have its own forward-only rollover rule, which dated a 23:59
 * departure still listed on a 00:03 board as 23:59 TONIGHT — roughly 24 hours
 * in the future — and poisoned that row's delay figure and countdown. The
 * shared helper picks the nearest of yesterday/today/tomorrow instead.
 */
function toIso(hhmm: string, reference: Date): string | undefined {
  return hhmmToIso(hhmm, reference);
}

/**
 * Coerce a feed collection that may arrive as a bare object.
 *
 * LDBWS is XML underneath and gateways routinely collapse a single-element list
 * into the element itself. `trainServices.map(...)` on such a payload threw
 * `.map is not a function` out of a parse that had no try/catch around it,
 * taking the whole board down with a 500.
 */
function normaliseList<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type LdbwsBoardKind = "departure" | "arrival";

function parseService(
  svc: LdbwsService,
  reference: Date,
  kind: LdbwsBoardKind,
): BoardDeparture | null {
  const publicTime = kind === "departure" ? svc.std : svc.sta;
  if (!publicTime) return null;
  const scheduled = toIso(publicTime, reference);
  if (!scheduled) return null;

  const origin = normaliseList(svc.origin)[0];
  const dest = normaliseList(svc.destination)[0];
  const estimateText = ((kind === "departure" ? svc.etd : svc.eta) ?? "").trim();
  const cancelled = svc.isCancelled === true || /cancel/i.test(estimateText);

  let status: BoardDeparture["status"];
  let live: string | undefined;
  let delayMinutes: number | undefined;

  if (cancelled) {
    status = "cancelled";
  } else if (/^on time$/i.test(estimateText)) {
    status = "on-time";
  } else if (/^\d{2}:\d{2}$/.test(estimateText)) {
    // Anchor the estimate on the SCHEDULED instant, not the board's generatedAt:
    // for a service departing just after midnight the two sit on opposite sides
    // of the date boundary, and anchoring on generatedAt put the estimate a day
    // away from its own scheduled time.
    live = toIso(estimateText, new Date(scheduled));
    delayMinutes = minutesLate(scheduled, live);
    status = delayMinutes !== undefined && delayMinutes > 1 ? "delayed" : "on-time";
  } else if (/delay/i.test(estimateText)) {
    status = "delayed"; // "Delayed" with no estimate yet
  } else {
    // No etd, or unrecognised LDBWS text ("No report", "Bus", "Starts here")
    // — not a confirmed on-time status, so don't claim one.
    status = "scheduled";
  }

  const coachCount = normaliseList(svc.formation?.coaches).length || svc.length || undefined;
  // LDBWS gives a full human sentence for cancellations and delays, available
  // for every operator (unlike coach formation). Prefer the relevant one.
  const reason =
    cancelled ? svc.cancelReason
    : status === "delayed" ? svc.delayReason
    : status === "scheduled" && estimateText ? estimateText
    : undefined;

  return {
    tripId: svc.serviceID,
    originName: origin?.locationName,
    originCrs: origin?.crs,
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
  filterType: "to" | "from" = "to",
): Promise<LdbwsBoard | null> {
  const key = process.env.LDBWS_API_KEY;
  const base = process.env.LDBWS_BASE_URL;
  if (!key || !base) return null;

  // filterCrs asks LDBWS for only the departures calling at that station (LDBWS
  // knows the full pattern, so this is more accurate than a client filter).
  const params = new URLSearchParams({ numRows: String(limit) });
  if (callingAt) {
    params.set("filterCrs", callingAt);
    params.set("filterType", filterType);
  }

  const operation = process.env.LDBWS_BOARD_OPERATION || "GetArrDepBoardWithDetails";

  let res: Response;
  try {
    res = await fetch(`${base}/${operation}/${crs}?${params}`, {
      headers: { "x-apikey": key },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return null; // network/timeout — caller falls back
  }
  if (!res.ok) return null;

  // Everything past this point is parsing a payload we don't control. A shape
  // surprise must degrade to "no live board" (the caller falls back to MOTIS),
  // never propagate as a 500.
  try {
    const data = (await res.json()) as LdbwsResponse;
    const rawRef = data.generatedAt ? new Date(data.generatedAt) : new Date();
    const reference = Number.isNaN(rawRef.getTime()) ? new Date() : rawRef;

    const departures = normaliseList(data.trainServices)
      .map((svc) => parseService(svc, reference, "departure"))
      .filter((d): d is BoardDeparture => d !== null);
    const arrivals = normaliseList(data.trainServices)
      .map((svc) => parseService(svc, reference, "arrival"))
      .filter((d): d is BoardDeparture => d !== null);

    const messages = normaliseList(data.nrccMessages)
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
      arrivals,
    };
  } catch {
    return null;
  }
}
