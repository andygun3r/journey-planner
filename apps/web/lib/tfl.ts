/**
 * Client for the TfL Unified API (tube/bus/DLR/Overground/Elizabeth line/tram).
 * Free, no NRDP/RDM account needed — auth is a single `app_key` query param
 * from api-portal.tfl.gov.uk. Used strictly for the TfL-local portion of a
 * journey; MOTIS remains authoritative for all National Rail legs.
 *
 * Every request tolerates shape surprises the same way ldbws.ts/disruptions.ts
 * do: a bad/missing response degrades to null/[] so a stitched journey falls
 * back to rail-only, never a 500.
 */

export interface TflStopPoint {
  naptanId: string;
  commonName: string;
  lat?: number;
  lon?: number;
  modes: string[];
  /** CRS code, present only when this StopPoint is also a rail interchange. */
  crs?: string;
}

export interface TflLineStatus {
  lineId: string;
  lineName: string;
  /** 0-10; 10 = Good Service, lower is worse (TfL's own scale). */
  statusSeverity: number;
  statusSeverityDescription: string;
  reason?: string;
}

export interface TflArrivalPrediction {
  lineId?: string;
  lineName: string;
  platformName?: string;
  destinationName?: string;
  /** Seconds until arrival. */
  timeToStation: number;
  expectedArrival?: string;
  /** "inbound" | "outbound" — the branch this vehicle is running, needed to fetch its route sequence. */
  direction?: string;
  /** Compass degrees (0-359), when TfL has a live GPS fix on the vehicle. */
  bearing?: number;
  vehicleId?: string;
}

export interface TflJourneyLeg {
  mode: string;
  lineId?: string;
  lineName?: string;
  departurePoint: { naptanId?: string; name: string };
  arrivalPoint: { naptanId?: string; name: string };
  departureTime?: string;
  arrivalTime?: string;
  instruction?: string;
  isDisrupted: boolean;
}

export interface TflJourney {
  startDateTime?: string;
  arrivalDateTime?: string;
  durationMinutes?: number;
  legs: TflJourneyLeg[];
}

export function tflConfigured(): boolean {
  return Boolean(process.env.TFL_APP_KEY);
}

function baseUrl(): string {
  return process.env.TFL_BASE_URL ?? "https://api.tfl.gov.uk";
}

async function get(
  path: string,
  params?: Record<string, string>,
  timeoutMs = 6000,
): Promise<unknown | null> {
  const key = process.env.TFL_APP_KEY;
  if (!key) return null;

  const qs = new URLSearchParams({ ...params, app_key: key });
  try {
    const res = await fetch(`${baseUrl()}${path}?${qs}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface RawAdditionalProperty {
  category?: string;
  key?: string;
  value?: string;
}

interface RawStopPoint {
  naptanId?: string;
  commonName?: string;
  lat?: number;
  lon?: number;
  modes?: string[];
  additionalProperties?: RawAdditionalProperty[];
}

function crsFromAdditionalProperties(props: RawAdditionalProperty[] | undefined): string | undefined {
  const hit = props?.find((p) => p.key === "CRS" || p.category === "CRS");
  const value = hit?.value?.trim().toUpperCase();
  return value && /^[A-Z]{3}$/.test(value) ? value : undefined;
}

function toStopPoint(raw: RawStopPoint): TflStopPoint | null {
  if (!raw.naptanId || !raw.commonName) return null;
  return {
    naptanId: raw.naptanId,
    commonName: raw.commonName,
    lat: raw.lat,
    lon: raw.lon,
    modes: raw.modes ?? [],
    crs: crsFromAdditionalProperties(raw.additionalProperties),
  };
}

export async function searchStopPoints(query: string): Promise<TflStopPoint[]> {
  const data = (await get(`/StopPoint/Search/${encodeURIComponent(query)}`)) as {
    matches?: RawStopPoint[];
  } | null;
  const matches = data?.matches ?? [];
  return matches.map(toStopPoint).filter((s): s is TflStopPoint => s !== null);
}

export async function stopPoint(naptanId: string): Promise<TflStopPoint | null> {
  const data = (await get(`/StopPoint/${encodeURIComponent(naptanId)}`)) as RawStopPoint | null;
  if (!data) return null;
  return toStopPoint(data);
}

export async function nearbyStopPoints(
  lat: number,
  lon: number,
  radiusMeters = 500,
): Promise<TflStopPoint[]> {
  const data = (await get("/StopPoint", {
    lat: String(lat),
    lon: String(lon),
    radius: String(radiusMeters),
    stopTypes: "NaptanMetroStation,NaptanRailStation,NaptanPublicBusCoachTram",
  })) as { stopPoints?: RawStopPoint[] } | null;
  const points = data?.stopPoints ?? [];
  return points.map(toStopPoint).filter((s): s is TflStopPoint => s !== null);
}

interface RawStopPointPage {
  stopPoints?: RawStopPoint[];
  pageSize?: number;
  total?: number;
  page?: number;
}

/**
 * Every StopPoint for a single mode, e.g. all ~19k bus stops or all tube
 * stations. Used to bulk-populate the static map backdrop, not the
 * plan-time interchange lookup (which stays per-destination via
 * nearbyStopPoints/stopPoint above).
 *
 * Large modes (bus) reject an unpaginated call outright ("must be paginated
 * as data set is too large") — smaller modes return a flat array/stopPoints
 * list in one response. Always request page 1 first and keep paging while
 * the response says there's more, so both shapes are handled the same way.
 */
const MAX_STOP_POINT_PAGES = 100; // ~100k stops — comfortably above any real TfL mode
const PAGE_RETRIES = 3;

/**
 * `get()` collapses every failure mode (timeout, network error, non-200) to
 * `null` — indistinguishable from "this page legitimately has zero results".
 * Bus alone is ~33 pages of multi-MB responses (page fetches have measured
 * anywhere from ~150ms to 10+s), so across a full mode some page timing out
 * is the expected case, not the exception. Treating a failed page as "no
 * more data" silently truncated the bus cache to ~1k of the real ~32.5k
 * stops with no error anywhere — retry a failed page a few times before
 * giving up, and throw (rather than return a partial list) if it never comes
 * back, so a bad refresh can never look identical to a complete one.
 */
async function getStopPointPage(
  mode: string,
  page: number,
): Promise<RawStopPoint[] | RawStopPointPage> {
  for (let attempt = 1; attempt <= PAGE_RETRIES; attempt++) {
    const data = (await get(
      `/StopPoint/Mode/${encodeURIComponent(mode)}`,
      { page: String(page) },
      20_000,
    )) as RawStopPoint[] | RawStopPointPage | null;
    if (data !== null) return data;
    if (attempt < PAGE_RETRIES) await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  throw new Error(`TfL StopPoint/Mode/${mode} page ${page} failed after ${PAGE_RETRIES} attempts`);
}

export async function stopPointsByMode(mode: string): Promise<TflStopPoint[]> {
  const points: TflStopPoint[] = [];
  let page = 1;
  while (page <= MAX_STOP_POINT_PAGES) {
    const data = await getStopPointPage(mode, page);

    const raw = Array.isArray(data) ? data : (data?.stopPoints ?? []);
    points.push(...raw.map(toStopPoint).filter((s): s is TflStopPoint => s !== null));

    const page_ = !Array.isArray(data) ? data : null;
    const total = page_?.total;
    const pageSize = page_?.pageSize;
    if (!total || !pageSize || page * pageSize >= total || raw.length === 0) break;
    page++;
  }
  return points;
}

interface RawJourneyLeg {
  mode?: { id?: string; name?: string };
  routeOptions?: Array<{ lineIdentifier?: { id?: string; name?: string } }>;
  departurePoint?: { naptanId?: string; commonName?: string };
  arrivalPoint?: { naptanId?: string; commonName?: string };
  departureTime?: string;
  arrivalTime?: string;
  instruction?: { summary?: string };
  isDisrupted?: boolean;
}

interface RawJourney {
  startDateTime?: string;
  arrivalDateTime?: string;
  duration?: number;
  legs?: RawJourneyLeg[];
}

function toJourney(raw: RawJourney): TflJourney {
  const legs = (raw.legs ?? []).map((leg): TflJourneyLeg => {
    const lineOption = leg.routeOptions?.[0]?.lineIdentifier;
    return {
      mode: leg.mode?.id ?? "unknown",
      lineId: lineOption?.id,
      lineName: lineOption?.name ?? leg.mode?.name,
      departurePoint: {
        naptanId: leg.departurePoint?.naptanId,
        name: leg.departurePoint?.commonName ?? "",
      },
      arrivalPoint: {
        naptanId: leg.arrivalPoint?.naptanId,
        name: leg.arrivalPoint?.commonName ?? "",
      },
      departureTime: leg.departureTime,
      arrivalTime: leg.arrivalTime,
      instruction: leg.instruction?.summary,
      isDisrupted: leg.isDisrupted === true,
    };
  });

  return {
    startDateTime: raw.startDateTime,
    arrivalDateTime: raw.arrivalDateTime,
    durationMinutes: raw.duration,
    legs,
  };
}

export interface JourneyResultsOptions {
  when?: string;
  arriveBy?: boolean;
  modes?: string[];
}

export async function journeyResults(
  fromNaptanId: string,
  toNaptanId: string,
  opts: JourneyResultsOptions = {},
): Promise<TflJourney[]> {
  const params: Record<string, string> = {};
  if (opts.modes?.length) params.mode = opts.modes.join(",");
  if (opts.when) {
    const d = new Date(opts.when);
    if (!Number.isNaN(d.getTime())) {
      params.date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      params.time = `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
      params.timeIs = opts.arriveBy ? "Arriving" : "Departing";
    }
  }

  const data = (await get(
    `/Journey/JourneyResults/${encodeURIComponent(fromNaptanId)}/to/${encodeURIComponent(toNaptanId)}`,
    params,
  )) as { journeys?: RawJourney[] } | null;
  const journeys = data?.journeys ?? [];
  return journeys.map(toJourney);
}

const LINE_STATUS_TTL_MS = 45 * 1000;
let lineStatusCache: { key: string; data: TflLineStatus[]; at: number } | null = null;

interface RawLineStatus {
  id?: string;
  name?: string;
  lineStatuses?: Array<{
    statusSeverity?: number;
    statusSeverityDescription?: string;
    reason?: string;
  }>;
}

export async function lineStatus(modes: readonly string[]): Promise<TflLineStatus[]> {
  const key = [...modes].sort().join(",");
  if (lineStatusCache && lineStatusCache.key === key && Date.now() - lineStatusCache.at < LINE_STATUS_TTL_MS) {
    return lineStatusCache.data;
  }

  const data = (await get(`/Line/Mode/${key}/Status`)) as RawLineStatus[] | null;
  const lines = (data ?? []).flatMap((line): TflLineStatus[] => {
    const worst = (line.lineStatuses ?? []).reduce<TflLineStatus | null>((acc, s) => {
      const severity = s.statusSeverity ?? 10;
      if (acc && acc.statusSeverity <= severity) return acc;
      return {
        lineId: line.id ?? "",
        lineName: line.name ?? line.id ?? "",
        statusSeverity: severity,
        statusSeverityDescription: s.statusSeverityDescription ?? "Unknown",
        reason: s.reason,
      };
    }, null);
    return worst ? [worst] : [];
  });

  lineStatusCache = { key, data: lines, at: Date.now() };
  return lines;
}

const ARRIVALS_TTL_MS = 25 * 1000;
const arrivalsCache = new Map<string, { data: TflArrivalPrediction[]; at: number }>();

interface RawPrediction {
  lineId?: string;
  lineName?: string;
  platformName?: string;
  destinationName?: string;
  timeToStation?: number;
  expectedArrival?: string;
  direction?: string;
  bearing?: string;
  vehicleId?: string;
}

export async function arrivals(naptanId: string): Promise<TflArrivalPrediction[]> {
  const cached = arrivalsCache.get(naptanId);
  if (cached && Date.now() - cached.at < ARRIVALS_TTL_MS) return cached.data;

  const data = (await get(`/StopPoint/${encodeURIComponent(naptanId)}/Arrivals`)) as
    | RawPrediction[]
    | null;
  const predictions = (data ?? [])
    .filter((p): p is RawPrediction & { timeToStation: number } => typeof p.timeToStation === "number")
    .map((p) => {
      // TfL sends bearing as a numeric string; a handful of vehicles report
      // it as empty/non-numeric, so this must degrade to undefined rather
      // than NaN (which would silently poison any rotation math downstream).
      const bearing = p.bearing !== undefined ? Number(p.bearing) : undefined;
      return {
        lineId: p.lineId,
        lineName: p.lineName ?? "",
        platformName: p.platformName,
        destinationName: p.destinationName,
        timeToStation: p.timeToStation,
        expectedArrival: p.expectedArrival,
        direction: p.direction,
        bearing: bearing !== undefined && Number.isFinite(bearing) ? bearing : undefined,
        vehicleId: p.vehicleId,
      };
    })
    .sort((a, b) => a.timeToStation - b.timeToStation);

  arrivalsCache.set(naptanId, { data: predictions, at: Date.now() });
  return predictions;
}

export interface TflRouteStop {
  naptanId: string;
  name: string;
  lat: number;
  lon: number;
}

export interface TflRouteSequence {
  lineId: string;
  lineName: string;
  direction: string;
  /** One or more branch polylines, each an ordered list of [lon, lat] pairs. */
  polylines: [number, number][][];
  stops: TflRouteStop[];
}

interface RawMatchedStop {
  id?: string;
  naptanId?: string;
  name?: string;
  commonName?: string;
  lat?: number;
  lon?: number;
}

interface RawStopPointSequence {
  stopPoint?: RawMatchedStop[];
}

interface RawRouteSequence {
  lineId?: string;
  lineName?: string;
  direction?: string;
  lineStrings?: string[];
  stopPointSequences?: RawStopPointSequence[];
}

const ROUTE_SEQUENCE_TTL_MS = 5 * 60 * 1000; // route shape/stops change rarely — cache generously
const routeSequenceCache = new Map<string, { data: TflRouteSequence | null; at: number }>();

/**
 * Full route shape + stop list for one bus line/direction — draws the "show
 * this bus's route" map overlay. `direction` must be "inbound" or "outbound"
 * (what Arrivals predictions report per-vehicle); TfL's own route/line pages
 * use the same two branches for every London bus route.
 */
export async function lineRouteSequence(
  lineId: string,
  direction: string,
): Promise<TflRouteSequence | null> {
  const cacheKey = `${lineId}:${direction}`;
  const cached = routeSequenceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ROUTE_SEQUENCE_TTL_MS) return cached.data;

  const data = (await get(
    `/Line/${encodeURIComponent(lineId)}/Route/Sequence/${encodeURIComponent(direction)}`,
  )) as RawRouteSequence | null;

  let result: TflRouteSequence | null = null;
  if (data?.lineId) {
    const polylines: [number, number][][] = [];
    for (const raw of data.lineStrings ?? []) {
      try {
        const parsed = JSON.parse(raw) as [number, number][];
        if (Array.isArray(parsed) && parsed.length > 0) polylines.push(parsed);
      } catch {
        // Malformed lineString for this branch — skip it, keep the rest.
      }
    }

    const seen = new Set<string>();
    const stops: TflRouteStop[] = [];
    for (const seq of data.stopPointSequences ?? []) {
      for (const sp of seq.stopPoint ?? []) {
        const naptanId = sp.naptanId ?? sp.id;
        if (!naptanId || seen.has(naptanId)) continue;
        if (typeof sp.lat !== "number" || typeof sp.lon !== "number") continue;
        seen.add(naptanId);
        stops.push({
          naptanId,
          name: sp.name ?? sp.commonName ?? naptanId,
          lat: sp.lat,
          lon: sp.lon,
        });
      }
    }

    result = {
      lineId: data.lineId,
      lineName: data.lineName ?? data.lineId,
      direction: data.direction ?? direction,
      polylines,
      stops,
    };
  }

  routeSequenceCache.set(cacheKey, { data: result, at: Date.now() });
  return result;
}
