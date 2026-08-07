/**
 * Nightly sync of train operator reference data from the RDG Knowledgebase
 * "TOCs" product (XML 4.0) into toc_operator. Static — refreshes at most
 * every 24h per RDG's docs — so a nightly run (see
 * services/etl/cron/run-and-reload-motis.sh) is enough.
 *
 * This supplements, not replaces, packages/shared/src/toc.ts's hardcoded
 * ATOC-code → name/region lookups (those stay the fast, dependency-free
 * source for name/region joins used throughout routing/live status); this
 * table is for the richer per-operator detail — website, contact,
 * description — that a hardcoded table isn't a good fit for.
 *
 * The exact XML element/attribute names are unconfirmed until subscribed;
 * RawToc below is a best guess, all fields optional so an unexpected/renamed
 * field degrades to a null column rather than throwing. The full parsed
 * record is kept in `raw`.
 */

import { createDb, tocOperator } from "@signaller/db";
import { asArray, kbGetXml, kbProductConfigured } from "./kb-client.js";

interface RawToc {
  AtocCode?: string;
  Code?: string;
  Name?: string;
  Description?: string;
  Website?: string;
  ContactPhone?: string;
  ContactEmail?: string;
}

function toRow(t: RawToc): (typeof tocOperator.$inferInsert) | null {
  const code = (t.AtocCode ?? t.Code)?.toUpperCase();
  if (!code || !t.Name) return null;
  return {
    code,
    name: t.Name,
    description: t.Description ?? null,
    website: t.Website ?? null,
    contactPhone: t.ContactPhone ?? null,
    contactEmail: t.ContactEmail ?? null,
    raw: t,
    updatedAt: new Date(),
  };
}

export async function syncTocOperators(): Promise<void> {
  if (!kbProductConfigured("tocs")) {
    console.log("[etl] KB_TOCS_API_KEY/KB_TOCS_BASE_URL not set — skipping TOC reference sync.");
    return;
  }

  const data = await kbGetXml("tocs", "/tocs");
  if (!data || typeof data !== "object") {
    console.error("[etl] Knowledgebase TOCs feed returned no usable data — skipping.");
    return;
  }

  // XML root element name is unconfirmed — check a couple of likely shapes.
  const root = data as Record<string, unknown>;
  const container = (root.Tocs ?? root.TocList ?? root) as Record<string, unknown>;
  const rawTocs = asArray(container.Toc as RawToc | RawToc[] | undefined);

  const rows = rawTocs.map(toRow).filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) {
    console.error("[etl] Knowledgebase TOCs feed returned zero mappable rows — skipping.");
    return;
  }

  const db = createDb();
  for (const values of rows) {
    await db
      .insert(tocOperator)
      .values(values)
      .onConflictDoUpdate({ target: tocOperator.code, set: values });
  }
  console.log(`[etl] Synced ${rows.length} TOC operator records.`);
}
