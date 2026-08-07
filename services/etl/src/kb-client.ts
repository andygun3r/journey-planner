/**
 * Shared fetch/parse helpers for the RDG Knowledgebase (KB) feed: station
 * facilities/accessibility (nightly, kb-facilities.ts) and the incidents
 * feed (5-min poll, kb-incidents.ts) — see CLAUDE.md §5.
 *
 * Auth shape and exact base path are unconfirmed until RDM registration.
 * This module is the one place that boundary lives — if the real API turns
 * out to need OAuth instead of an x-apikey header, or XML instead of JSON,
 * fix it here; kb-facilities.ts/kb-incidents.ts and everything downstream
 * shouldn't need to change.
 */

export function kbConfigured(): boolean {
  return Boolean(process.env.KB_API_KEY && process.env.KB_BASE_URL);
}

/** GET a KB endpoint as JSON. Returns null (never throws) if unconfigured, non-OK, or unreachable. */
export async function kbGetJson(path: string): Promise<unknown | null> {
  const key = process.env.KB_API_KEY;
  const base = process.env.KB_BASE_URL;
  if (!key || !base) return null;
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "x-apikey": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML-description parsing, duplicated from apps/web/lib/disruptions.ts.
// services/etl and apps/web are independently deployed with no shared
// runtime, so this is copied rather than cross-imported — KB incident
// descriptions are HTML the same way Disruptions API ones are.
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}
