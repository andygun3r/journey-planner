/**
 * Bulk TfL stop/station backdrop for the live map — distinct from
 * tfl-stop-cache.ts's per-destination lookup used at journey-plan time.
 * ~19k bus stops + ~270 tube/DLR/Overground/Elizabeth-line/tram stations is
 * too much to fetch per map load, so this refreshes the whole set into
 * tfl_stop_point_cache on a slow schedule and serves reads straight from
 * Postgres.
 */
import { tflStopPointCache } from "@mainline/db";
import { and, between, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDb } from "./db";
import { stopPointsByMode, type TflStopPoint } from "./tfl";

const REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // weekly, matches tfl-stop-cache.ts

export interface MapStop {
  naptanId: string;
  commonName: string;
  lat: number;
  lon: number;
  modes: string[];
}

async function bulkUpsert(points: TflStopPoint[]): Promise<void> {
  if (points.length === 0) return;
  const db = getDb();
  const CHUNK = 500;
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    await db
      .insert(tflStopPointCache)
      .values(
        chunk.map((p) => ({
          naptanId: p.naptanId,
          commonName: p.commonName,
          crs: p.crs ?? null,
          lat: p.lat ?? null,
          lon: p.lon ?? null,
          modes: p.modes,
          fetchedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: tflStopPointCache.naptanId,
        set: {
          commonName: sql`excluded.common_name`,
          crs: sql`excluded.crs`,
          lat: sql`excluded.lat`,
          lon: sql`excluded.lon`,
          modes: sql`excluded.modes`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }
}

/**
 * Bulk-fetch and cache every stop for each mode. Call from a cron/cli, not
 * per-request. One mode's page walk exhausting its retries (bus is ~33 pages
 * and the slowest/flakiest — see getStopPointPage) must not sink the other
 * modes in the same refresh, so failures are caught per-mode and logged
 * rather than propagated.
 */
export async function refreshAllTflStops(modes: readonly string[]): Promise<number> {
  let total = 0;
  for (const mode of modes) {
    try {
      const points = await stopPointsByMode(mode);
      await bulkUpsert(points);
      total += points.length;
    } catch (err) {
      console.error(`[tfl-stops] refresh failed for mode "${mode}":`, err);
    }
  }
  return total;
}

let staleCheckAt = 0;
const STALE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // don't hammer Postgres with a MIN() every request

/**
 * Read the cached stop backdrop for the map. Triggers a background refresh
 * (fire-and-forget) if the cache looks stale or empty, but always serves
 * whatever's in Postgres immediately rather than blocking on TfL.
 */
export async function getMapStops(modes: readonly string[]): Promise<MapStop[]> {
  const db = getDb();
  // Postgres' array-overlap operator needs an explicit ARRAY[...] literal on
  // the right-hand side — passing the JS array as a single bound parameter
  // makes the driver stringify it and Postgres reject it as malformed.
  const modesArray: SQL = sql`ARRAY[${sql.join(
    modes.map((m) => sql`${m}`),
    sql`, `,
  )}]::text[]`;
  const rows = await db
    .select({
      naptanId: tflStopPointCache.naptanId,
      commonName: tflStopPointCache.commonName,
      lat: tflStopPointCache.lat,
      lon: tflStopPointCache.lon,
      modes: tflStopPointCache.modes,
      fetchedAt: tflStopPointCache.fetchedAt,
    })
    .from(tflStopPointCache)
    .where(sql`${tflStopPointCache.modes} && ${modesArray}`);

  const now = Date.now();
  const oldestFetch = rows.reduce(
    (min, r) => Math.min(min, r.fetchedAt.getTime()),
    now,
  );
  const looksStale = rows.length === 0 || now - oldestFetch > REFRESH_MS;
  if (looksStale && now - staleCheckAt > STALE_CHECK_INTERVAL_MS) {
    staleCheckAt = now;
    void refreshAllTflStops(modes);
  }

  return rows
    .filter((r): r is typeof r & { lat: number; lon: number } => r.lat != null && r.lon != null)
    .map((r) => ({
      naptanId: r.naptanId,
      commonName: r.commonName,
      lat: r.lat,
      lon: r.lon,
      modes: r.modes,
    }));
}

export interface MapBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Same cached backdrop as getMapStops, but filtered to a viewport in SQL —
 * used by the approximate-bus layer, which polls Arrivals per visible stop
 * and must not pull all ~19k bus stops into memory just to filter in JS.
 */
export async function getMapStopsInBounds(
  modes: readonly string[],
  bounds: MapBounds,
): Promise<MapStop[]> {
  const db = getDb();
  const modesArray: SQL = sql`ARRAY[${sql.join(
    modes.map((m) => sql`${m}`),
    sql`, `,
  )}]::text[]`;
  const rows = await db
    .select({
      naptanId: tflStopPointCache.naptanId,
      commonName: tflStopPointCache.commonName,
      lat: tflStopPointCache.lat,
      lon: tflStopPointCache.lon,
      modes: tflStopPointCache.modes,
    })
    .from(tflStopPointCache)
    .where(
      and(
        sql`${tflStopPointCache.modes} && ${modesArray}`,
        between(tflStopPointCache.lat, bounds.minLat, bounds.maxLat),
        between(tflStopPointCache.lon, bounds.minLon, bounds.maxLon),
      ),
    );

  return rows
    .filter((r): r is typeof r & { lat: number; lon: number } => r.lat != null && r.lon != null)
    .map((r) => ({
      naptanId: r.naptanId,
      commonName: r.commonName,
      lat: r.lat,
      lon: r.lon,
      modes: r.modes,
    }));
}
