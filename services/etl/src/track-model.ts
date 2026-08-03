import { readFileSync } from "node:fs";
import { join } from "node:path";
import { station, stationTrackModelPosition, trackModelLine } from "@mainline/db";
import { bngToWgs84, haversineMeters, readDbf, readShpPolyLines } from "@mainline/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Precompute a station's position on Network Rail's Track Model, into
 * station_track_model_position, plus the reprojected national track network
 * into track_model_line.
 *
 * Why: no STANOX/TIPLOC/CRS feed — official or community — joins to ELR +
 * mileage (checked NROD's supporting files, the RDG Rail Data Marketplace
 * catalogue, and known community projects; none carry it). Track Model
 * itself has no STANOX, only ELR+mileage+shape. The only way to connect the
 * two is geometric: snap each station's already-known coordinate onto the
 * nearest Track Model centreline, then read off that point's ELR and
 * interpolated mileage.
 *
 * This is a manual, occasional re-run — like snap-stations/rail-corridors,
 * not a scheduled feed. Track Model is a one-off shapefile drop under
 * data/NWR_TrackModel (override with TRACK_MODEL_DIR), not something
 * services/nr-ingest fetches live.
 *
 * Entirely in-process: no orm-db/PostGIS involved, unlike rail-corridors.
 * Track Model is a few shapefiles (~50k line segments nationally), small
 * enough to parse and index in memory for a one-shot batch job.
 */

/**
 * Ground distance beyond which a station<->centreline match is treated as
 * bogus rather than a real platform/throat offset.
 *
 * Not copied from snap-stations.ts's 150m: that tolerance absorbs noise in
 * OSM community-mapped track data. Track Model is official Network Rail
 * survey data, so a large miss here more likely means "matched the wrong
 * nearby parallel line" (a real risk in a busy multi-track throat) than
 * "sparse source data". 40m is a first estimate, generous enough for
 * realistic throat geometry, tight enough to make a wrong-line match
 * unlikely — treat the first real run's distance histogram (printed below)
 * as the actual calibration, not this number.
 */
const MAX_SNAP_METERS = 40;

/** ~0.01deg grid (roughly 1.1km lat, 0.7km lon at GB latitudes) — same idea as rail-corridors.ts's buildNodeIndex. */
function bucketKey(lat: number, lon: number): string {
  return `${Math.floor(lat * 100)},${Math.floor(lon * 100)}`;
}

interface Segment {
  assetId: string;
  elr: string;
  /** [lon, lat] endpoints of this one segment. */
  a: [number, number];
  b: [number, number];
  /** Cumulative arc length (metres) from the record's start to `a`, and to `b`. */
  arcAtA: number;
  arcAtB: number;
  /** The full record's mileage span and total arc length, to interpolate within. */
  recordStartMileage: number;
  recordEndMileage: number;
  recordTotalLengthM: number;
}

interface LoadedLines {
  segments: Segment[];
  lineRows: { assetId: string; elr: string; trackId: string | null; startMileage: number | null; endMileage: number | null; geometry: number[] }[];
}

function loadTrackCentreLines(dir: string): LoadedLines {
  const shpBuf = readFileSync(join(dir, "NWR_TrackCentreLines.shp"));
  const dbfBuf = readFileSync(join(dir, "NWR_TrackCentreLines.dbf"));
  const shapes = readShpPolyLines(shpBuf);
  const rows = readDbf(dbfBuf);
  if (shapes.length !== rows.length) {
    throw new Error(`NWR_TrackCentreLines .shp/.dbf record count mismatch: ${shapes.length} vs ${rows.length}`);
  }

  const segments: Segment[] = [];
  const lineRows: LoadedLines["lineRows"] = [];

  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i]!;
    const row = rows[i]!;
    const assetId = String(row.ASSET_ID);
    const elr = String(row.ELR);
    const trackId = row.TRACK_ID != null ? String(row.TRACK_ID) : null;
    const startMileage = typeof row.START === "number" ? row.START : null;
    const endMileage = typeof row.END === "number" ? row.END : null;

    // Real Track Model data confirmed single-part per record (verified by
    // scanning all 49,681 records before writing this) — still handle
    // multiple parts defensively, one line_row per part.
    for (let partIndex = 0; partIndex < shape.parts.length; partIndex++) {
      const part = shape.parts[partIndex]!;
      if (part.length < 2) continue;
      const partAssetId = shape.parts.length > 1 ? `${assetId}-${partIndex}` : assetId;

      const wgsPoints = part.map(([e, n]) => bngToWgs84(e, n)).map((p) => [p.lon, p.lat] as [number, number]);
      const geometry: number[] = [];
      for (const [lon, lat] of wgsPoints) geometry.push(lon, lat);
      lineRows.push({ assetId: partAssetId, elr, trackId, startMileage, endMileage, geometry });

      if (startMileage === null || endMileage === null) continue;

      let arc = 0;
      const arcs = [0];
      for (let j = 1; j < wgsPoints.length; j++) {
        arc += haversineMeters(wgsPoints[j - 1]!, wgsPoints[j]!);
        arcs.push(arc);
      }
      const totalLength = arc;
      if (totalLength <= 0) continue;

      for (let j = 1; j < wgsPoints.length; j++) {
        segments.push({
          assetId: partAssetId,
          elr,
          a: wgsPoints[j - 1]!,
          b: wgsPoints[j]!,
          arcAtA: arcs[j - 1]!,
          arcAtB: arcs[j]!,
          recordStartMileage: startMileage,
          recordEndMileage: endMileage,
          recordTotalLengthM: totalLength,
        });
      }
    }
  }

  return { segments, lineRows };
}

function buildSegmentIndex(segments: Segment[]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    for (const [lon, lat] of [seg.a, seg.b]) {
      const k = bucketKey(lat, lon);
      const list = buckets.get(k);
      if (list) list.push(i);
      else buckets.set(k, [i]);
    }
  }
  return buckets;
}

interface Match {
  segment: Segment;
  point: [number, number];
  distanceM: number;
  /** Interpolated mileage at the matched point. */
  mileage: number;
}

/** Clamped parametric projection of a point onto a segment, in WGS84 degrees (fine at this scale — matched distance is computed via haversine, not degree distance). */
function nearestOnSegment(p: [number, number], a: [number, number], b: [number, number]): { point: [number, number]; t: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const abLenSq = abx * abx + aby * aby;
  const t = abLenSq === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  return { point: [a[0] + abx * t, a[1] + aby * t], t };
}

function findNearestSegment(
  lon: number,
  lat: number,
  segments: Segment[],
  buckets: Map<string, number[]>,
): Match | null {
  let best: Match | null = null;
  const cy = Math.floor(lat * 100);
  const cx = Math.floor(lon * 100);
  const span = 2;
  const seen = new Set<number>();
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      for (const i of buckets.get(`${cy + dy},${cx + dx}`) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const seg = segments[i]!;
        const { point, t } = nearestOnSegment([lon, lat], seg.a, seg.b);
        const distanceM = haversineMeters([lon, lat], point);
        if (best === null || distanceM < best.distanceM) {
          const arcAtPoint = seg.arcAtA + t * (seg.arcAtB - seg.arcAtA);
          const mileage =
            seg.recordStartMileage +
            (arcAtPoint / seg.recordTotalLengthM) * (seg.recordEndMileage - seg.recordStartMileage);
          best = { segment: seg, point, distanceM, mileage };
        }
      }
    }
  }
  return best;
}

export async function trackModel(dirOverride?: string): Promise<void> {
  const dir = dirOverride ?? process.env.TRACK_MODEL_DIR ?? join(process.cwd(), "../../data/NWR_TrackModel");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const mainClient = postgres(url);
  const db = drizzle(mainClient);

  try {
    console.log(`[track-model] loading Track Model shapefiles from ${dir}…`);
    const { segments, lineRows } = loadTrackCentreLines(dir);
    console.log(`[track-model] ${lineRows.length} line records, ${segments.length} segments`);

    console.log("[track-model] writing track_model_line…");
    await db.transaction(async (tx) => {
      await tx.execute(sql`truncate table ${trackModelLine}`);
      const BATCH = 2000;
      for (let i = 0; i < lineRows.length; i += BATCH) {
        await tx.insert(trackModelLine).values(lineRows.slice(i, i + BATCH));
      }
    });
    console.log(`[track-model] wrote ${lineRows.length} track_model_line rows`);

    const buckets = buildSegmentIndex(segments);

    const stations = await db
      .select({
        crs: station.crs,
        lat: sql<number | null>`coalesce(${station.trackLat}, ${station.lat})`,
        lon: sql<number | null>`coalesce(${station.trackLon}, ${station.lon})`,
      })
      .from(station);

    const rows: (typeof stationTrackModelPosition.$inferInsert)[] = [];
    const histogram = { "0-10m": 0, "10-40m": 0, "40-100m": 0, "100m+": 0 };
    let noCoords = 0;
    let noMatch = 0;

    for (const s of stations) {
      if (s.lat == null || s.lon == null) {
        noCoords += 1;
        continue;
      }
      const match = findNearestSegment(s.lon, s.lat, segments, buckets);
      if (!match) {
        noMatch += 1;
        continue;
      }

      if (match.distanceM <= 10) histogram["0-10m"] += 1;
      else if (match.distanceM <= 40) histogram["10-40m"] += 1;
      else if (match.distanceM <= 100) histogram["40-100m"] += 1;
      else histogram["100m+"] += 1;

      if (match.distanceM > MAX_SNAP_METERS) continue;

      rows.push({
        crs: s.crs,
        elr: match.segment.elr,
        mileage: match.mileage,
        assetId: match.segment.assetId,
        matchedLat: match.point[1],
        matchedLon: match.point[0],
        snapDistanceM: match.distanceM,
      });
    }

    console.log(
      `[track-model] snap distance histogram: ` +
        `0-10m=${histogram["0-10m"]} 10-40m=${histogram["10-40m"]} ` +
        `40-100m=${histogram["40-100m"]} 100m+=${histogram["100m+"]}`,
    );
    console.log(
      `[track-model] matched ${rows.length}/${stations.length} stations within ${MAX_SNAP_METERS}m; ` +
        `${noCoords} had no coordinates, ${noMatch} had no nearby segment at all`,
    );

    if (rows.length > 0) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`truncate table ${stationTrackModelPosition}`);
        await tx.insert(stationTrackModelPosition).values(rows);
      });
      console.log(`[track-model] wrote ${rows.length} station_track_model_position rows`);
    }
  } finally {
    await mainClient.end();
  }
}
