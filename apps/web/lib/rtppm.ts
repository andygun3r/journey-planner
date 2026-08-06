import { nrRtppm } from "@signaller/db";
import { getDb } from "./db";

/**
 * Real-Time Public Performance Measure, per operator. nr_rtppm.operatorCode is
 * Network Rail's own numeric TOC id, not a Darwin operator code — match by
 * normalised operator display name instead. Best-effort: if RTPPM's free-text
 * name doesn't line up with the display name we show elsewhere, that operator
 * just has no punctuality figure.
 */
export interface RtppmSummary {
  ppm: number | null;
  rollingPpm: number | null;
}

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Cached for a minute, because this reads the whole table and every departure
 * board asks for it.
 *
 * The RTPPM feed refreshes each operator about once a minute, so a fresher
 * answer than this does not exist. Without the cache every board request ran an
 * unfiltered scan of nr_rtppm — one per user, per refresh, per station.
 */
const CACHE_TTL_MS = 60_000;
let cached: Map<string, RtppmSummary> | null = null;
let cachedAt = 0;

/** Keyed by normalised operator display name (e.g. "gwr", "lner"). */
export async function getRtppmByOperatorName(): Promise<Map<string, RtppmSummary>> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;

  const db = getDb();
  let rows: Array<{ operatorName: string | null; ppm: number | null; rollingPpm: number | null }>;
  try {
    rows = await db
      .select({
        operatorName: nrRtppm.operatorName,
        ppm: nrRtppm.ppm,
        rollingPpm: nrRtppm.rollingPpm,
      })
      .from(nrRtppm);
  } catch {
    // Serve the last good answer if we have one; a transient database blip
    // shouldn't strip punctuality off every board.
    return cached ?? new Map();
  }

  const byName = new Map<string, RtppmSummary>();
  for (const r of rows) {
    if (!r.operatorName) continue;
    byName.set(normalise(r.operatorName), { ppm: r.ppm, rollingPpm: r.rollingPpm });
  }

  cached = byName;
  cachedAt = Date.now();
  return byName;
}
