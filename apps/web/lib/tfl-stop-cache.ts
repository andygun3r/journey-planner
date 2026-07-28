/**
 * Write-through Postgres cache of TfL StopPoint lookups. StopPoint data (name,
 * location, whether it's also a rail interchange) is near-static, so once
 * resolved it's worth persisting rather than re-fetching every plan — unlike
 * line status/arrivals, which stay in-memory (see tfl.ts) because they're
 * genuinely live. Rows are populated lazily as lookups happen; never hand-seeded.
 */
import { tflStopPointCache } from "@mainline/db";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { nearbyStopPoints, stopPoint, type TflStopPoint } from "./tfl";

const REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // weekly

async function readCached(naptanId: string): Promise<TflStopPoint | null> {
  const [row] = await getDb()
    .select()
    .from(tflStopPointCache)
    .where(eq(tflStopPointCache.naptanId, naptanId))
    .limit(1);
  if (!row) return null;
  if (Date.now() - row.fetchedAt.getTime() > REFRESH_MS) return null;
  return {
    naptanId: row.naptanId,
    commonName: row.commonName,
    crs: row.crs ?? undefined,
    lat: row.lat ?? undefined,
    lon: row.lon ?? undefined,
    modes: row.modes,
  };
}

async function writeCache(point: TflStopPoint): Promise<void> {
  await getDb()
    .insert(tflStopPointCache)
    .values({
      naptanId: point.naptanId,
      commonName: point.commonName,
      crs: point.crs ?? null,
      lat: point.lat ?? null,
      lon: point.lon ?? null,
      modes: point.modes,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: tflStopPointCache.naptanId,
      set: {
        commonName: point.commonName,
        crs: point.crs ?? null,
        lat: point.lat ?? null,
        lon: point.lon ?? null,
        modes: point.modes,
        fetchedAt: new Date(),
      },
    });
}

/** Resolve a StopPoint by NaPTAN id, checking the cache before calling TfL. */
export async function cachedStopPoint(naptanId: string): Promise<TflStopPoint | null> {
  const cached = await readCached(naptanId);
  if (cached) return cached;

  const fresh = await stopPoint(naptanId);
  if (fresh) await writeCache(fresh);
  return fresh;
}

/**
 * Find the nearest StopPoint to a lat/lon that also carries a CRS — i.e. a
 * National Rail interchange usable as the MOTIS/TfL stitch point. Caches
 * every candidate seen along the way, not just the winning one.
 */
export async function nearestRailInterchange(
  lat: number,
  lon: number,
): Promise<TflStopPoint | null> {
  const candidates = await nearbyStopPoints(lat, lon, 1000);
  await Promise.all(candidates.map(writeCache));
  return candidates.find((c) => c.crs !== undefined) ?? null;
}
