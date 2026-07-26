import { nrRtppm } from "@mainline/db";
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

/** Keyed by normalised operator display name (e.g. "gwr", "lner"). */
export async function getRtppmByOperatorName(): Promise<Map<string, RtppmSummary>> {
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
    return new Map();
  }

  const byName = new Map<string, RtppmSummary>();
  for (const r of rows) {
    if (!r.operatorName) continue;
    byName.set(normalise(r.operatorName), { ppm: r.ppm, rollingPpm: r.rollingPpm });
  }
  return byName;
}
