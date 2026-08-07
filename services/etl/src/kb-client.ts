/**
 * Shared fetch/parse helpers for the RDG Knowledgebase feeds — three separate
 * RDM data products, each with its own subscription/key like every other RDM
 * product in this repo (compare LDBWS vs Service Details vs Disruptions,
 * each with distinct *_API_KEY/*_BASE_URL pairs):
 *
 *   - Stations (JSON 5.0)  — station facilities/accessibility, nightly (kb-facilities.ts)
 *   - Incidents (XML 5.0)  — planned engineering work, 5-min poll (kb-incidents.ts)
 *   - TOCs (XML 4.0)       — operator reference data, nightly (kb-tocs.ts)
 *
 * Auth is assumed to be x-apikey (the pattern every other RDM REST feed in
 * this repo uses), and the exact response shape per product is unconfirmed
 * until subscribed — this module is the one place both boundaries live, so
 * fixes stay local to it rather than rippling into the three sync jobs.
 */

import { XMLParser } from "fast-xml-parser";

export type KbProduct = "stations" | "incidents" | "tocs";

function envPrefix(product: KbProduct): string {
  return `KB_${product.toUpperCase()}`;
}

export function kbProductConfigured(product: KbProduct): boolean {
  const prefix = envPrefix(product);
  return Boolean(process.env[`${prefix}_API_KEY`] && process.env[`${prefix}_BASE_URL`]);
}

async function kbFetch(product: KbProduct, path: string): Promise<Response | null> {
  const prefix = envPrefix(product);
  const key = process.env[`${prefix}_API_KEY`];
  const base = process.env[`${prefix}_BASE_URL`];
  if (!key || !base) return null;
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "x-apikey": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  }
}

/** GET a KB endpoint as JSON. Returns null (never throws) if unconfigured, non-OK, or unreachable. */
export async function kbGetJson(product: KbProduct, path: string): Promise<unknown | null> {
  const res = await kbFetch(product, path);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

/** GET a KB endpoint as XML, parsed to a plain object. Returns null (never throws) on any failure. */
export async function kbGetXml(product: KbProduct, path: string): Promise<unknown | null> {
  const res = await kbFetch(product, path);
  if (!res) return null;
  try {
    const text = await res.text();
    return xmlParser.parse(text);
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

/**
 * XML-parsed collections are inconsistent about arrays: fast-xml-parser
 * gives you a single object when there's one element, an array when there's
 * more than one. Every KB XML consumer needs this — normalise once here.
 */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
