/**
 * Poll sync of the RDG Knowledgebase incidents feed into kb_incident —
 * mainly planned engineering work with date ranges. Kept deliberately
 * separate from the National Rail Disruptions API already wired in
 * apps/web/lib/disruptions.ts, which stays the primary live-status source;
 * this is a secondary "planned engineering works" layer, not merged with it.
 *
 * RDG recommends polling incidents every ~5 minutes — see
 * services/etl/src/server.ts's startKbIncidentPollIfConfigured for the
 * in-process interval that calls this.
 *
 * Response shape is unconfirmed until RDM registration; RawIncident is a
 * best guess, all fields optional so an unexpected/renamed field degrades
 * to a null column rather than throwing. The full record is kept in `raw`.
 */

import { createDb, kbIncident } from "@signaller/db";
import { kbConfigured, kbGetJson, stripHtml } from "./kb-client.js";

interface RawIncident {
  id?: string;
  incidentId?: string;
  summary?: string;
  description?: string;
  category?: string;
  severity?: string;
  affectedOperators?: string[];
  affectedRoutesText?: string;
  startDateTime?: string;
  endDateTime?: string;
  lastUpdated?: string;
  deleted?: boolean;
  cleared?: boolean;
}

function toRow(i: RawIncident): (typeof kbIncident.$inferInsert) | null {
  const id = i.id ?? i.incidentId;
  if (!id) return null;
  return {
    id,
    summary: stripHtml(i.summary) || "Engineering work",
    description: i.description ? stripHtml(i.description) : null,
    category: i.category ?? null,
    severity: i.severity ?? null,
    affectedOperators: i.affectedOperators ?? [],
    affectedRoutesText: i.affectedRoutesText ?? null,
    startsAt: i.startDateTime ? new Date(i.startDateTime) : null,
    endsAt: i.endDateTime ? new Date(i.endDateTime) : null,
    lastUpdated: i.lastUpdated ? new Date(i.lastUpdated) : new Date(),
    cleared: Boolean(i.deleted ?? i.cleared),
    raw: i,
  };
}

export async function syncKbIncidents(): Promise<void> {
  if (!kbConfigured()) {
    console.log("[etl] KB_API_KEY/KB_BASE_URL not set — skipping KB incidents poll.");
    return;
  }

  const data = await kbGetJson("/incidents");
  if (!Array.isArray(data)) {
    console.error("[etl] Knowledgebase incidents feed returned no usable data — skipping this poll.");
    return;
  }

  const rows = (data as RawIncident[]).map(toRow).filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) return;

  const db = createDb();
  for (const values of rows) {
    await db
      .insert(kbIncident)
      .values(values)
      .onConflictDoUpdate({ target: kbIncident.id, set: values });
  }
  console.log(`[etl] Synced ${rows.length} KB incidents.`);
}
