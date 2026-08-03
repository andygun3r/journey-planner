/**
 * Client for the RDG "National Rail Disruptions" REST API.
 * Two views used by Mainline:
 *   - station incidents: active disruptions affecting a given CRS
 *   - TOC service indicators: per-operator "good service / disruption" status
 * Auth: consumer key in the x-apikey header.
 */

import { tocRegion } from "@mainline/shared";

/** An inline run of a disruption paragraph: plain text or a link. */
export type Inline = { text: string } | { text: string; href: string };

/** A paragraph of a disruption, optionally a bold sub-heading. */
export interface DisruptionBlock {
  heading: boolean;
  content: Inline[];
}

export interface Disruption {
  id: string;
  summary: string;
  /** Structured, readable description (paragraphs, headings, links preserved). */
  blocks: DisruptionBlock[];
  planned: boolean;
  operators: string[];
  startsAt?: string;
  link?: string;
}

export interface ServiceIndicator {
  tocCode: string;
  tocName: string;
  status: string;
  statusDescription: string;
  /** True when the operator is running a normal service. */
  good: boolean;
}

function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** Strip HTML but keep one leading/trailing space so link boundaries read right. */
function plainRun(html: string): string {
  const stripped = decodeEntities(stripHtml(html));
  if (!stripped) return "";
  const leadSpace = /^(\s|&nbsp;)/.test(html) ? " " : "";
  const trailSpace = /(\s|&nbsp;)$/.test(html) ? " " : "";
  return `${leadSpace}${stripped}${trailSpace}`;
}

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

/**
 * Parse the disruption description HTML into readable blocks: one per <p>,
 * flagged as a heading when it's a bold-only line (e.g. "Customer advice:"),
 * with <a> links preserved as inline runs. Falls back to a single plain
 * paragraph if there are no <p> tags.
 */
function parseDescription(html: string | undefined): DisruptionBlock[] {
  if (!html) return [];
  const paras = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi);
  const rawParas = paras ?? [`<p>${html}</p>`];
  const blocks: DisruptionBlock[] = [];

  for (const p of rawParas) {
    const inner = p.replace(/^<p\b[^>]*>/i, "").replace(/<\/p>$/i, "");
    // A whole-paragraph <strong> is a section heading.
    const headingMatch = /^\s*<strong>([\s\S]*?)<\/strong>\s*$/i.exec(inner);
    if (headingMatch) {
      const text = decodeEntities(stripHtml(headingMatch[1]));
      if (text) blocks.push({ heading: true, content: [{ text }] });
      continue;
    }

    const content: Inline[] = [];
    const linkRe = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(inner)) !== null) {
      const before = plainRun(inner.slice(last, m.index));
      if (before) content.push({ text: before });
      const label = decodeEntities(stripHtml(m[2]!));
      if (label) content.push({ text: label, href: m[1]! });
      last = m.index + m[0].length;
    }
    const tail = plainRun(inner.slice(last));
    if (tail) content.push({ text: tail });
    if (content.length > 0) blocks.push({ heading: false, content });
  }

  return blocks;
}

export function disruptionsConfigured(): boolean {
  return Boolean(process.env.DISRUPTIONS_API_KEY && process.env.DISRUPTIONS_BASE_URL);
}

async function get(path: string): Promise<unknown | null> {
  const key = process.env.DISRUPTIONS_API_KEY;
  const base = process.env.DISRUPTIONS_BASE_URL;
  if (!key || !base) return null;
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "x-apikey": key },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

interface RawIncidentGroup {
  crsCode?: string;
  disruptions?: Array<{
    id: string;
    summary?: string;
    description?: string;
    isPlanned?: boolean;
    status?: string;
    affectedOperators?: Array<{ tocName?: string }>;
    startDateTime?: string;
    disruptionLinks?: Array<{ uri?: string }>;
  }>;
}

export async function fetchStationDisruptions(crs: string): Promise<Disruption[]> {
  const data = (await get(`/stations/disruptions/incidents?crsCode=${crs}`)) as
    | RawIncidentGroup[]
    | null;
  if (!Array.isArray(data)) return [];
  const disruptions = data.flatMap((g) => g.disruptions ?? []);
  return disruptions
    .filter((d) => d.status !== "Cleared")
    .map((d) => ({
      id: d.id,
      summary: stripHtml(d.summary) || "Disruption",
      blocks: parseDescription(d.description),
      planned: d.isPlanned === true,
      operators: (d.affectedOperators ?? []).map((o) => o.tocName ?? "").filter(Boolean),
      startsAt: d.startDateTime,
      link: d.disruptionLinks?.[0]?.uri,
    }));
}

interface RawServiceIndicator {
  tocCode?: string;
  tocName?: string;
  tocStatus?: string;
  tocStatusDescription?: string;
}

export async function fetchServiceIndicators(): Promise<ServiceIndicator[]> {
  const data = (await get(`/tocs/serviceIndicators`)) as RawServiceIndicator[] | null;
  if (!Array.isArray(data)) return [];
  return data.map((t) => {
    const status = t.tocStatus ?? "";
    return {
      tocCode: t.tocCode ?? "",
      tocName: t.tocName ?? t.tocCode ?? "",
      status,
      statusDescription: stripHtml(t.tocStatusDescription),
      good: /good service|normal/i.test(status) || status === "",
    };
  });
}

/** Indicators keyed by TOC name, for quick per-operator lookup on a board. */
export async function serviceIndicatorsByToc(): Promise<Map<string, ServiceIndicator>> {
  const list = await fetchServiceIndicators();
  const map = new Map<string, ServiceIndicator>();
  for (const ind of list) {
    map.set(ind.tocName, ind);
    if (ind.tocCode) map.set(ind.tocCode, ind);
  }
  return map;
}

/** Indicators grouped by Network Rail operating region, for a regional dashboard panel. */
export async function serviceIndicatorsByRegion(): Promise<Map<string, ServiceIndicator[]>> {
  const list = await fetchServiceIndicators();
  const map = new Map<string, ServiceIndicator[]>();
  for (const ind of list) {
    const region = tocRegion(ind.tocCode) ?? "Other";
    const group = map.get(region);
    if (group) group.push(ind);
    else map.set(region, [ind]);
  }
  return map;
}

/**
 * There is no network-wide "list all active incidents" endpoint on this API —
 * only per-station lookup. One well-connected interchange station per Network
 * Rail region reliably surfaces that region's active incidents (an incident
 * affecting a TOC shows up at every station on its affected routes), so this
 * sweeps a fixed set of 8 hub stations — one call per region, not one per
 * operator or per station — and dedupes by incident id.
 */
const REGION_HUB_CRS: Record<string, string> = {
  Anglia: "LST",
  "East Midlands": "STP",
  "London North Eastern": "KGX",
  "London North Western": "EUS",
  "Scotland's Railway": "GLC",
  Southern: "CLJ",
  "Wales & Western": "PAD",
  Wessex: "WAT",
};

/** All currently active disruptions network-wide, deduped, via a fixed sweep of regional hub stations. */
export async function fetchNetworkDisruptions(): Promise<Disruption[]> {
  const groups = await Promise.all(Object.values(REGION_HUB_CRS).map((crs) => fetchStationDisruptions(crs)));
  const byId = new Map<string, Disruption>();
  for (const group of groups) {
    for (const d of group) byId.set(d.id, d);
  }
  return Array.from(byId.values());
}
