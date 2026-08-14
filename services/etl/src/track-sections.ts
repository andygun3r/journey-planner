import { corridorTrackSection, trackModelLine } from "@signaller/db";
import { deriveSections, type TrackSection, type TrackSpan } from "@signaller/shared";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Work out how many running lines exist along each stretch of railway, and
 * which they are, into corridor_track_section.
 *
 * Why: the signalling blueprint drew a fixed four running lines from Waterloo
 * to Weymouth. The real South West Main Line is four-track as far as Worting
 * Junction and two-track after it, so most of that diagram was decoration. The
 * Track Model already knows the true shape — this reads it out.
 *
 * The derivation itself lives in @signaller/shared (track-sections.ts) because
 * the web app needs the same logic and thresholds to interpret what it reads
 * back. This file is just the batch job around it.
 *
 * Reads track_model_line rather than the shapefiles directly, so `etl
 * track-model` must have run first. That keeps one parser for the Track Model
 * and makes this cheap to re-run while tuning.
 */
export async function trackSections(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  try {
    const rows = await db
      .select({
        elr: trackModelLine.elr,
        trackId: trackModelLine.trackId,
        startMileage: trackModelLine.startMileage,
        endMileage: trackModelLine.endMileage,
      })
      .from(trackModelLine);

    if (rows.length === 0) {
      throw new Error("track_model_line is empty — run `etl track-model` first");
    }

    const byElr = new Map<string, TrackSpan[]>();
    for (const row of rows) {
      if (!row.trackId || row.startMileage === null || row.endMileage === null) continue;
      const list = byElr.get(row.elr) ?? [];
      list.push({ trackId: row.trackId, start: row.startMileage, end: row.endMileage });
      byElr.set(row.elr, list);
    }

    const sections: TrackSection[] = [];
    for (const [elr, spans] of byElr) sections.push(...deriveSections(elr, spans));

    await db.delete(corridorTrackSection);
    const values = sections.map((s) => ({
      id: `${s.elr}:${s.startMileage.toFixed(3)}`,
      elr: s.elr,
      startMileage: s.startMileage,
      endMileage: s.endMileage,
      trackIds: s.trackIds,
      trackCount: s.trackIds.length,
    }));
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500);
      if (chunk.length) await db.insert(corridorTrackSection).values(chunk);
    }

    console.log(`track-sections: ${byElr.size} ELRs → ${sections.length} sections`);
    const swml = sections
      .filter((s) => s.elr === "MLN1")
      .sort((a, b) => a.startMileage - b.startMileage);
    for (const s of swml.slice(0, 8)) {
      console.log(
        `  MLN1 ${s.startMileage.toFixed(2)}–${s.endMileage.toFixed(2)}  ` +
          `${s.trackIds.length} tracks  ${s.trackIds.join(", ")}`,
      );
    }
  } finally {
    await client.end();
  }
}
