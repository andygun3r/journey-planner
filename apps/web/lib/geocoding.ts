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

async function get(path: string, timeoutMs = 5000): Promise<unknown | null> {
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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
