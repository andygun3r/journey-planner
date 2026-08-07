/**
 * Poll sync of the RDG Knowledgebase "Incidents" product (XML 5.0) into
 * kb_incident — mainly planned engineering work with date ranges. Kept
 * deliberately separate from the National Rail Disruptions API already
 * wired in apps/web/lib/disruptions.ts, which stays the primary live-status
 * source; this is a secondary "planned engineering works" layer, not merged
 * with it.
 *
 * RDG recommends polling incidents every ~5 minutes — see
 * services/etl/src/server.ts's startKbIncidentPollIfConfigured for the
 * in-process interval that calls this.
 *
 * The exact XML element/attribute names are unconfirmed until subscribed;
 * RawIncident below is a best guess at the shape fast-xml-parser would
 * produce, all fields optional so an unexpected/renamed field degrades to a
 * null column rather than throwing. The full parsed record is kept in `raw`.
 */

import { createDb, kbIncident } from "@signaller/db";
import { asArray, kbGetXml, kbProductConfigured, stripHtml } from "./kb-client.js";

interface RawIncident {
  IncidentId?: string;
  Id?: string;
  Summary?: string;
  Description?: string;
  Category?: string;
  Severity?: string;
  AffectedOperators?: { Operator?: string | string[] };
  AffectedRoutesText?: string;
  StartDateTime?: string;
  EndDateTime?: string;
  LastUpdated?: string;
  Deleted?: boolean | string;
  Cleared?: boolean | string;
}

function isTrue(v: boolean | string | undefined): boolean {
  return v === true || v === "true" || v === "1";
}

function toRow(i: RawIncident): (typeof kbIncident.$inferInsert) | null {
  const id = i.IncidentId ?? i.Id;
  if (!id) return null;
  return {
    id,
    summary: stripHtml(i.Summary) || "Engineering work",
    description: i.Description ? stripHtml(i.Description) : null,
    category: i.Category ?? null,
    severity: i.Severity ?? null,
    affectedOperators: asArray(i.AffectedOperators?.Operator),
    affectedRoutesText: i.AffectedRoutesText ?? null,
    startsAt: i.StartDateTime ? new Date(i.StartDateTime) : null,
    endsAt: i.EndDateTime ? new Date(i.EndDateTime) : null,
    lastUpdated: i.LastUpdated ? new Date(i.LastUpdated) : new Date(),
    cleared: isTrue(i.Deleted) || isTrue(i.Cleared),
    raw: i,
  };
}

export async function syncKbIncidents(): Promise<void> {
  if (!kbProductConfigured("incidents")) {
    console.log("[etl] KB_INCIDENTS_API_KEY/KB_INCIDENTS_BASE_URL not set — skipping KB incidents poll.");
    return;
  }

  const data = await kbGetXml("incidents", "/incidents");
  if (!data || typeof data !== "object") {
    console.error("[etl] Knowledgebase incidents feed returned no usable data — skipping this poll.");
    return;
  }

  // XML root element name is unconfirmed — check the couple of shapes RDG's
  // other XML feeds tend to use before giving up.
  const root = data as Record<string, unknown>;
  const container = (root.Incidents ?? root.IncidentList ?? root) as Record<string, unknown>;
  const rawIncidents = asArray(container.Incident as RawIncident | RawIncident[] | undefined);

  const rows = rawIncidents.map(toRow).filter((r): r is NonNullable<typeof r> => r !== null);
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
