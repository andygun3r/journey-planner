import { eq } from "drizzle-orm";
import { station, stationFacility } from "@signaller/db";
import { haversineMeters } from "@signaller/shared";
import { getDb } from "./db";

export interface StationEntry {
  crs: string;
  name: string;
}

let cache: { list: StationEntry[]; byCrs: Map<string, string>; at: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

async function load() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const rows = await getDb()
    .select({ crs: station.crs, name: station.name })
    .from(station);
  const list = rows
    .map((r) => ({ crs: r.crs, name: cleanName(r.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  cache = { list, byCrs: new Map(list.map((s) => [s.crs, s.name])), at: Date.now() };
  return cache;
}

/** .MSN names are ALL CAPS; title-case them for display. */
function cleanName(raw: string): string {
  if (raw !== raw.toUpperCase()) return raw;
  return raw
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(On|Of|The|Upon|And|In|Under|Le|By)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\(([a-z])/g, (_, c: string) => `(${c.toUpperCase()})`.slice(0, 2))
    .replace(/\bHl\b/g, "High Level")
    .replace(/\bLl\b/g, "Low Level");
}

export async function getStations(): Promise<StationEntry[]> {
  return (await load()).list;
}

export async function stationName(crs: string): Promise<string> {
  return (await load()).byCrs.get(crs.toUpperCase()) ?? crs.toUpperCase();
}

/**
 * All station coordinates, for the live map's static backdrop. Cached
 * separately from the name list; returns [] if the table isn't ready.
 */
let coordCache: { pts: Array<[number, number]>; at: number } | null = null;

export async function getStationCoords(): Promise<Array<[number, number]>> {
  if (coordCache && Date.now() - coordCache.at < TTL_MS) return coordCache.pts;
  try {
    const rows = await getDb()
      .select({ lat: station.lat, lon: station.lon })
      .from(station);
    const pts = rows
      .filter((r): r is { lat: number; lon: number } => r.lat != null && r.lon != null)
      .map((r) => [Number(r.lat.toFixed(4)), Number(r.lon.toFixed(4))] as [number, number]);
    coordCache = { pts, at: Date.now() };
    return pts;
  } catch {
    return [];
  }
}

export interface NearbyStation {
  crs: string;
  name: string;
  distanceMeters: number;
}

/** All stations with known coordinates, cached separately (crs + name + lat/lon, for nearest-station lookups). */
let geoCache: { rows: Array<{ crs: string; name: string; lat: number; lon: number }>; at: number } | null = null;

async function loadGeo() {
  if (geoCache && Date.now() - geoCache.at < TTL_MS) return geoCache.rows;
  const rows = await getDb()
    .select({ crs: station.crs, name: station.name, lat: station.lat, lon: station.lon })
    .from(station);
  const filtered = rows
    .filter((r): r is { crs: string; name: string; lat: number; lon: number } => r.lat != null && r.lon != null)
    .map((r) => ({ ...r, name: cleanName(r.name) }));
  geoCache = { rows: filtered, at: Date.now() };
  return filtered;
}

/** Nearest stations to a lat/lon, closest first. Returns [] if station data isn't loaded. */
export async function nearestStations(lat: number, lon: number, limit = 1): Promise<NearbyStation[]> {
  let rows: Array<{ crs: string; name: string; lat: number; lon: number }>;
  try {
    rows = await loadGeo();
  } catch {
    return [];
  }
  return rows
    .map((r) => ({
      crs: r.crs,
      name: r.name,
      distanceMeters: haversineMeters([lon, lat], [r.lon, r.lat]),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);
}

export type StationFacility = typeof stationFacility.$inferSelect;

/**
 * Facilities/accessibility for one station, from the RDG Knowledgebase feed
 * (services/etl's nightly kb-facilities sync). Not cached like the station
 * list above — it's a distinct, less-frequently-needed dataset, and board
 * pages only ever need one station's row at a time. Returns null if KB isn't
 * configured (empty table) or this CRS isn't in the feed yet.
 */
export async function stationFacilities(crs: string): Promise<StationFacility | null> {
  try {
    const rows = await getDb()
      .select()
      .from(stationFacility)
      .where(eq(stationFacility.crs, crs.toUpperCase()));
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
