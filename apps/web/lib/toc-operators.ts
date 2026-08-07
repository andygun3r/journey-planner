/**
 * Reads train operator reference data from the RDG Knowledgebase "TOCs"
 * product, nightly-synced into toc_operator by services/etl's kb-tocs job
 * (see services/etl/src/kb-tocs.ts). Supplements the hardcoded ATOC-code →
 * name/region lookups in packages/shared/src/toc.ts, which stay the source
 * for name/region joins — this is only for the extra detail (website,
 * contact) a hardcoded table has no room for.
 */

import { eq } from "drizzle-orm";
import { tocOperator } from "@signaller/db";
import { getDb } from "./db";

export type TocOperator = typeof tocOperator.$inferSelect;

/** Operator reference detail for one ATOC code. Null if KB isn't configured or the code isn't in the feed yet. */
export async function getTocOperator(code: string): Promise<TocOperator | null> {
  try {
    const rows = await getDb()
      .select()
      .from(tocOperator)
      .where(eq(tocOperator.code, code.toUpperCase()));
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
