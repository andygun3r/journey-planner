import { createDb, nrCorpus, nrHeadcode, nrSmart } from "@signaller/db";
import { sql } from "drizzle-orm";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { createGunzip } from "node:zlib";

/**
 * Loads Network Rail reference data (CORPUS + SMART + the SCHEDULE feed's
 * uid->headcode map) needed to make the live movement/berth feeds meaningful.
 * All are served from the NROD site behind the same account auth.
 *
 * CORPUS: STANOX <-> TIPLOC <-> CRS <-> NLC. Movements report loc_stanox; we
 *   translate to CRS/TIPLOC to line up with Darwin.
 * SMART: TD berth steps -> STANOX + event type, so a "berth A->B" step becomes
 *   "train passed <location>".
 * SCHEDULE: uid -> headcode (see nr_headcode's schema comment) — the link
 *   between Darwin's uid-keyed trains and the TD feed's headcode-keyed live
 *   positions.
 */

const NROD_BASE = process.env.NROD_BASE_URL ?? "https://publicdatafeeds.networkrail.co.uk";
const CORPUS_PATH = "/ntrod/SupportingFileAuthenticate?type=CORPUS";
const SMART_PATH = "/ntrod/SupportingFileAuthenticate?type=SMART";
// Full daily all-TOC snapshot, JSON format (CIF_ALL_FULL_DAILY / day=toc-full
// per the SCHEDULE feed's documented request shape). ~127MB gzipped, ~3.2GB
// decompressed — streamed line-by-line below, never buffered whole.
const SCHEDULE_PATH = "/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full";
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

async function readMaybeGzText(file: string): Promise<string> {
  const buf = await readFile(file);
  try {
    return file.toLowerCase().endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  } catch {
    return buf.toString("utf8");
  }
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
  STEPTYPE?: string;
  TD?: string;
  FROMBERTH?: string;
  TOBERTH?: string;
  STANOX?: string;
  EVENT?: string;
  PLATFORM?: string;
  BERTHOFFSET?: string;
}

const SMART_CSV_COLUMNS = [
  "TD",
  "STEPTYPE",
  "FROMBERTH",
  "TOBERTH",
  "STANOX",
  "STANME",
  "EVENT",
  "PLATFORM",
  "TOLINE",
  "BERTHOFFSET",
  "ROUTE",
  "FROMLINE",
  "COMMENT",
];

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

export function parseSmartCsv(text: string): SmartRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const first = splitCsvLine(lines[0]!).map((h) => h.trim().toUpperCase());
  const hasHeader = first.includes("TD") && first.includes("FROMBERTH") && first.includes("TOBERTH");
  const headers = hasHeader ? first : SMART_CSV_COLUMNS;
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (cells[i] !== undefined) row[h] = cells[i]!;
    });
    return row as SmartRow;
  });
}

async function readSmartRowsFromFile(file: string): Promise<SmartRow[]> {
  const lower = file.toLowerCase();
  const ungzipped = lower.endsWith(".gz") ? lower.slice(0, -3) : lower;
  const ext = path.extname(ungzipped);
  const text = await readMaybeGzText(file);
  if (ext === ".json") {
    const parsed = JSON.parse(text) as SmartRow[] | { BERTHDATA?: SmartRow[] };
    return Array.isArray(parsed) ? parsed : parsed.BERTHDATA ?? [];
  }
  if (ext === ".csv") return parseSmartCsv(text);
  throw new Error(`Unsupported SMART extract format ${ext || "(none)"} (${path.basename(file)})`);
}

async function writeSmartRows(rowsIn: SmartRow[]): Promise<number> {
  const db = createDb();
  const seen = new Set<string>();
  const rows = rowsIn
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

export async function loadSmart(): Promise<number> {
  const json = (await fetchGzJson(SMART_PATH)) as { BERTHDATA?: SmartRow[] };
  return writeSmartRows(json.BERTHDATA ?? []);
}

export async function loadSmartFromFile(file: string): Promise<number> {
  const rows = await readSmartRowsFromFile(file);
  return writeSmartRows(rows);
}

interface ScheduleLine {
  JsonScheduleV1?: {
    CIF_train_uid?: string;
    schedule_segment?: { signalling_id?: string };
  };
}

/**
 * Streams the SCHEDULE feed's full daily JSON (newline-delimited, one record
 * per line) and extracts uid -> headcode. Never buffers the decompressed body
 * (it's ~3.2GB) — reads line-by-line straight off the gunzip stream and
 * batches DB writes as it goes.
 */
export async function loadHeadcodes(): Promise<number> {
  const db = createDb();
  const res = await fetch(`${NROD_BASE}${SCHEDULE_PATH}`, {
    headers: { Authorization: authHeader() },
    redirect: "follow",
  });
  if (!res.ok || !res.body) throw new Error(`NROD ${SCHEDULE_PATH} failed: ${res.status}`);

  const gunzip = createGunzip();
  Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  const seen = new Map<string, string>();
  let batch: Array<{ uid: string; headcode: string }> = [];
  let total = 0;

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    await db
      .insert(nrHeadcode)
      .values(batch.map((r) => ({ ...r, updatedAt: new Date() })))
      .onConflictDoUpdate({
        target: nrHeadcode.uid,
        set: { headcode: sql`excluded.headcode`, updatedAt: sql`excluded.updated_at` },
      });
    total += batch.length;
    batch = [];
  }

  await db.delete(nrHeadcode);
  for await (const line of rl) {
    if (!line) continue;
    let parsed: ScheduleLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const sched = parsed.JsonScheduleV1;
    const uid = sched?.CIF_train_uid;
    const headcode = sched?.schedule_segment?.signalling_id;
    if (!uid || !headcode) continue;
    // A uid's headcode is effectively constant across its schedule variants
    // (STP overlays etc.) — keep the first one seen per uid, cheaply, before
    // it ever reaches the DB batch.
    if (seen.has(uid)) continue;
    seen.set(uid, headcode);
    batch.push({ uid, headcode });
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  console.log(`[nr] loaded ${total} uid->headcode rows from SCHEDULE`);
  return total;
}

function blankToNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t : null;
}
