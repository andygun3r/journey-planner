import { station } from "@mainline/db";
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
