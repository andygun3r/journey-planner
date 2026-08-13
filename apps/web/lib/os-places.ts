/**
 * Client for the Ordnance Survey Places API — authoritative UK address search,
 * down to individual property level (AddressBase Premium behind it).
 *
 * This is the free-text search postcodes.io can't do: "The Shard",
 * "14 Baker Street" and similar resolve here, where lib/geocoding.ts (postcode
 * and outcode only) returns null. The two are complements, not rivals —
 * geocoding.ts stays the postcode path because it needs no key and no quota.
 *
 * Same defensive posture as tfl.ts and ldbws.ts: unconfigured or failing means
 * empty results, never a thrown 500. Place search is an enhancement to station
 * search, so when it's unavailable the box must still find stations.
 *
 * Requires an OS Data Hub key (https://osdatahub.os.uk) in OS_PLACES_API_KEY.
 * Without it every function here no-ops and osPlacesConfigured() is false.
 */

export interface PlaceResult {
  /** Stable OS identifier (UPRN where present) — safe to round-trip in a URL. */
  id: string;
  /** Single-line address as OS formats it, e.g. "THE SHARD, 32 LONDON BRIDGE STREET, LONDON, SE1 9SG". */
  label: string;
  /** Shorter leading portion, for a typeahead row that must not wrap. */
  shortLabel: string;
  lat: number;
  lon: number;
  postcode?: string;
}

const BASE_URL = "https://api.os.uk/search/places/v1";

export function osPlacesConfigured(): boolean {
  return Boolean(process.env.OS_PLACES_API_KEY?.trim());
}

/**
 * OS returns coordinates in British National Grid by default. Asking for
 * EPSG:4326 up front gives WGS84 lat/lon directly, so we never have to
 * reproject — packages/shared/src/bng.ts exists for data that arrives as BNG
 * with no such option (the Track Model), which is not the case here.
 */
const OUTPUT_SRS = "EPSG:4326";

interface RawDpa {
  UPRN?: string;
  ADDRESS?: string;
  POSTCODE?: string;
  LAT?: number;
  LNG?: number;
  BUILDING_NAME?: string;
  THOROUGHFARE_NAME?: string;
  POST_TOWN?: string;
}

/**
 * OS wraps each hit as `{ DPA: {...} }` (Delivery Point Address) or
 * `{ LPI: {...} }` (Local Property Identifier) depending on the dataset. We
 * request DPA only, so anything else is skipped rather than half-parsed.
 */
function toPlace(raw: { DPA?: RawDpa }): PlaceResult | null {
  const dpa = raw.DPA;
  if (!dpa?.ADDRESS || typeof dpa.LAT !== "number" || typeof dpa.LNG !== "number") return null;

  // OS addresses are shouty uppercase; title-case them so they sit alongside
  // station names without looking like an error message.
  const label = titleCase(dpa.ADDRESS);
  const shortLabel = label.split(",").slice(0, 2).join(",").trim();

  return {
    id: dpa.UPRN ?? `${dpa.LAT},${dpa.LNG}`,
    label,
    shortLabel: shortLabel || label,
    lat: dpa.LAT,
    lon: dpa.LNG,
    postcode: dpa.POSTCODE,
  };
}

/** "THE SHARD, 32 LONDON BRIDGE STREET" → "The Shard, 32 London Bridge Street". */
function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    // Postcodes must stay fully capitalised — "Se1 9sg" reads as a typo.
    .replace(/\b([a-z]{1,2}\d[a-z\d]?)\s*(\d[a-z]{2})\b/gi, (_m, a: string, b: string) =>
      `${a.toUpperCase()} ${b.toUpperCase()}`,
    );
}

async function get(path: string, params: Record<string, string>): Promise<unknown | null> {
  const key = process.env.OS_PLACES_API_KEY?.trim();
  if (!key) return null;

  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", key);
  url.searchParams.set("output_srs", OUTPUT_SRS);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      // 401/403 means a bad or unentitled key — worth a log, since it looks
      // identical to "no matches" from the UI otherwise.
      if (res.status === 401 || res.status === 403) {
        console.error(`[os-places] ${path} auth failed: HTTP ${res.status} — check OS_PLACES_API_KEY`);
      }
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[os-places] ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Free-text place/address search, for the destination typeahead.
 *
 * `maxresults` is deliberately small: these rows sit *below* station results
 * (rail-first, per the search design), so a long tail of addresses would just
 * push the map's own content off screen.
 */
export async function searchPlaces(query: string, limit = 5): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!osPlacesConfigured() || q.length < 3) return [];

  const data = (await get("/find", {
    query: q,
    maxresults: String(Math.min(limit, 10)),
    dataset: "DPA",
  })) as { results?: Array<{ DPA?: RawDpa }> } | null;

  if (!data?.results) return [];
  return data.results.map(toPlace).filter((p): p is PlaceResult => p !== null);
}

/**
 * Resolve a single place id (UPRN) back to coordinates — used at plan time,
 * so a `place:` endpoint in a shared/bookmarked URL still works days later
 * without the original search results in hand.
 */
export async function placeByUprn(uprn: string): Promise<PlaceResult | null> {
  if (!osPlacesConfigured() || !/^\d+$/.test(uprn)) return null;

  const data = (await get("/uprn", { uprn, dataset: "DPA" })) as {
    results?: Array<{ DPA?: RawDpa }>;
  } | null;

  const first = data?.results?.[0];
  return first ? toPlace(first) : null;
}
