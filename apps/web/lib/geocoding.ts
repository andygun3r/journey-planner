/**
 * Client for postcodes.io — free, no API key, UK-postcode-only geocoding.
 * Resolves a full postcode ("SW1A 1AA") or an outcode ("SW1A") to a lat/lon.
 *
 * This is NOT a free-text address/place-name geocoder — "The Shard" or
 * "14 Baker Street" won't resolve. That's a deliberate v1 scope choice (see
 * PRODUCT.md/the journey-search plan): postcode coverage handles most
 * "get me near this place" needs without an API key or usage limits. Full
 * address-level search would need OS Places API (an OS Data Hub key) later.
 *
 * Same defensive pattern as tfl.ts/ldbws.ts: any failure (network, timeout,
 * malformed response, not-found) degrades to null, never throws into a 500.
 *
 * A real "no such postcode" (postcodes.io 404) and a transient failure
 * (network blip, timeout, a 5xx) both used to collapse to the same silent
 * null, which read to a user as "check the postcode and try again" even
 * when the postcode was fine and the app just couldn't reach the geocoder —
 * see the "Couldn't find that postcode" report for SE27 9QT, a postcode that
 * resolves fine directly against the API. A 404 is left alone (retrying a
 * real not-found wastes a round trip); anything else gets one retry and,
 * if that also fails, a logged reason so a report like that one is
 * diagnosable from the server logs instead of a dead end.
 */

export interface GeocodeResult {
  lat: number;
  lon: number;
  /** The postcode as postcodes.io normalised it, e.g. "SW1A 1AA". */
  label: string;
}

function baseUrl(): string {
  return process.env.POSTCODES_IO_BASE_URL ?? "https://api.postcodes.io";
}

async function attempt(url: string, timeoutMs: number): Promise<{ ok: true; data: unknown } | { ok: false; reason: string; retryable: boolean }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return { ok: false, reason: "404 not found", retryable: false };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, retryable: true };
    return { ok: true, data: await res.json() };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason, retryable: true };
  }
}

async function get(path: string, timeoutMs = 5000): Promise<unknown | null> {
  const url = `${baseUrl()}${path}`;
  const first = await attempt(url, timeoutMs);
  if (first.ok) return first.data;
  if (!first.retryable) return null;

  // One retry for anything that looks transient — a single dropped
  // connection or slow response shouldn't read to the user as "that
  // postcode doesn't exist."
  const second = await attempt(url, timeoutMs);
  if (second.ok) return second.data;

  console.error(`[geocoding] ${path} failed twice: ${first.reason}, then ${second.reason}`);
  return null;
}

interface PostcodeResult {
  latitude?: number;
  longitude?: number;
  postcode?: string;
}

interface OutcodeResult {
  latitude?: number;
  longitude?: number;
  outcode?: string;
}

/** Loose UK postcode/outcode shape check — used by the UI to decide whether to offer a postcode search. */
export function looksLikePostcode(query: string): boolean {
  const q = query.trim().toUpperCase();
  // Full postcode: e.g. "SW1A 1AA" (space optional). Outcode: e.g. "SW1A", "EC1".
  return /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/.test(q) || /^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(q);
}

function isFullPostcode(q: string): boolean {
  return /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/.test(q);
}

/** Resolve a postcode or outcode string to a lat/lon. Full postcodes are tried first, falling back to the outcode centroid. */
export async function geocodePostcode(query: string): Promise<GeocodeResult | null> {
  const q = query.trim().toUpperCase();
  if (!looksLikePostcode(q)) return null;

  if (isFullPostcode(q)) {
    const data = (await get(`/postcodes/${encodeURIComponent(q)}`)) as { result?: PostcodeResult } | null;
    const result = data?.result;
    if (result?.latitude !== undefined && result?.longitude !== undefined) {
      return { lat: result.latitude, lon: result.longitude, label: result.postcode ?? q };
    }
    // Fall through to outcode lookup below — e.g. a mistyped final part, or postcodes.io
    // has the outcode but not this specific full postcode.
  }

  const outcode = q.split(/\s+/)[0] ?? q;
  const data = (await get(`/outcodes/${encodeURIComponent(outcode)}`)) as { result?: OutcodeResult } | null;
  const result = data?.result;
  if (result?.latitude === undefined || result?.longitude === undefined) return null;
  return { lat: result.latitude, lon: result.longitude, label: result.outcode ?? outcode };
}
