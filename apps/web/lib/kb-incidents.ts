/**
 * Reads the RDG Knowledgebase "planned engineering works" table populated by
 * services/etl's 5-min kb-incidents poll (see services/etl/src/kb-incidents.ts).
 * DB-only — no HTTP call here, the poller already did the fetching. Kept
 * deliberately separate from apps/web/lib/disruptions.ts (the primary live
 * status source): this is a secondary, forward-looking layer, not merged or
 * deduped with live disruptions.
 */

import { asc, eq } from "drizzle-orm";
import { kbIncident } from "@signaller/db";
import { getDb } from "./db";

export type KbIncident = typeof kbIncident.$inferSelect;

/** Active/upcoming KB incidents (mostly planned engineering work), soonest first. */
export async function getPlannedEngineeringWorks(): Promise<KbIncident[]> {
  try {
    return await getDb()
      .select()
      .from(kbIncident)
      .where(eq(kbIncident.cleared, false))
      .orderBy(asc(kbIncident.startsAt));
  } catch {
    return [];
  }
}
