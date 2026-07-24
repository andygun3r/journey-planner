import { createDb, nrCorpus, nrSmart } from "@mainline/db";
import { gunzipSync } from "node:zlib";

/**
 * Loads Network Rail reference data (CORPUS + SMART) needed to make the live
 * movement/berth feeds meaningful. Both are gzipped JSON served from the NROD
 * site behind the same account auth.
 *
 * CORPUS: STANOX <-> TIPLOC <-> CRS <-> NLC. Movements report loc_stanox; we
 *   translate to CRS/TIPLOC to line up with Darwin.
 * SMART: TD berth steps -> STANOX + event type, so a "berth A->B" step becomes
 *   "train passed <location>".
 */

const NROD_BASE = process.env.NROD_BASE_URL ?? "https://publicdatafeeds.networkrail.co.uk";
const CORPUS_PATH = "/ntrod/SupportingFileAuthenticate?type=CORPUS";
const SMART_PATH = "/ntrod/SupportingFileAuthenticate?type=SMART";
const BATCH = 2000;

function authHeader(): string {
  const user = process.env.NETWORKRAIL_USERNAME;
  const pass = process.env.NETWORKRAIL_PASSWORD;
  if (!user || !pass) throw new Error("NETWORKRAIL_USERNAME / NETWORKRAIL_PASSWORD not set");
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function fetchGzJson(path: string): Promise<unknown> {
  const res = await fetch(`${NROD_BASE}${path}`, {
    headers: { Authorization: authHeader() },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`NROD ${path} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Files are gzipped; some mirrors serve plain JSON — try gunzip, fall back.
  let text: string;
  try {
    text = gunzipSync(buf).toString("utf8");
  } catch {
    text = buf.toString("utf8");
  }
  return JSON.parse(text);
}

interface CorpusRow {
  STANOX?: string;
  TIPLOC?: string;
  CRS?: string;
  NLC?: string;
  NLCDESC?: string;
  "3ALPHA"?: string;
}

export async function loadCorpus(): Promise<number> {
  const db = createDb();
  const json = (await fetchGzJson(CORPUS_PATH)) as { TIPLOCDATA?: CorpusRow[] };
  const rows = (json.TIPLOCDATA ?? [])
    .map((r) => ({
      stanox: blankToNull(r.STANOX),
      tiploc: blankToNull(r.TIPLOC),
      crs: blankToNull(r.CRS ?? r["3ALPHA"]),
      nlc: blankToNull(r.NLC),
      description: blankToNull(r.NLCDESC),
    }))
    .filter((r): r is typeof r & { stanox: string } => r.stanox !== null && r.stanox !== "00000");

  await db.delete(nrCorpus);
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(nrCorpus).values(rows.slice(i, i + BATCH)).onConflictDoNothing();
  }
  console.log(`[nr] loaded ${rows.length} CORPUS rows`);
  return rows.length;
}

interface SmartRow {
  TD?: string;
  FROMBERTH?: string;
  TOBERTH?: string;
  STANOX?: string;
  EVENT?: string;
  PLATFORM?: string;
  BERTHOFFSET?: string;
}

export async function loadSmart(): Promise<number> {
  const db = createDb();
  const json = (await fetchGzJson(SMART_PATH)) as { BERTHDATA?: SmartRow[] };
  const seen = new Set<string>();
  const rows = (json.BERTHDATA ?? [])
    .map((r) => ({
      tdArea: blankToNull(r.TD),
      fromBerth: blankToNull(r.FROMBERTH) ?? "",
      toBerth: blankToNull(r.TOBERTH) ?? "",
      stanox: blankToNull(r.STANOX),
      eventType: blankToNull(r.EVENT),
      platform: blankToNull(r.PLATFORM),
      berthOffset: blankToNull(r.BERTHOFFSET),
    }))
    .filter((r): r is typeof r & { tdArea: string } => r.tdArea !== null)
    .filter((r) => {
      const key = `${r.tdArea}|${r.fromBerth}|${r.toBerth}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  await db.delete(nrSmart);
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(nrSmart).values(rows.slice(i, i + BATCH)).onConflictDoNothing();
  }
  console.log(`[nr] loaded ${rows.length} SMART rows`);
  return rows.length;
}

function blankToNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t : null;
}
