import { createDb, sopMapping } from "@signaller/db";
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

/**
 * Loads SOP / ECS bit-map reference data into sop_mapping. Each TD area's file
 * says which signalling item every (address, bit) represents, so live S-class
 * bytes (nr_signalling_state) can be decoded into per-signal aspects.
 *
 * These files are sourced manually per area (Open Rail Data SOP tables / ECS
 * specs / FOI releases) — Network Rail publishes no single download, and not
 * every area is documented. Drop files into data/sop/ (or $SOP_DIR) and re-run.
 *
 * Supported formats are JSON, CSV, TSV, TXT, and gzipped versions of those.
 * JSON is either an array of rows or `{ tdArea, rows: [...] }`; delimited files
 * use a header row with the same normalized column names.
 */

const BATCH = 1000;

export interface SopRow {
  tdArea: string;
  address: string;
  bit: number;
  itemType: string;
  itemId?: string;
  aspect?: string;
  description?: string;
}

function sopDir(): string {
  if (process.env.SOP_DIR) return process.env.SOP_DIR;
  // Find data/sop by walking up from this module's location (works regardless of
  // the cwd pnpm --filter runs us with) then from cwd as a fallback.
  const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "data", "sop");
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(process.cwd(), "data", "sop");
}

function normAddr(a: string | number): string {
  const n = typeof a === "number" ? a : parseInt(a, 16);
  if (!Number.isFinite(n)) throw new Error(`bad SOP address: ${a}`);
  return n.toString(16).toLowerCase().padStart(2, "0");
}

function formatOf(file: string): string {
  const lower = file.toLowerCase();
  const ungzipped = lower.endsWith(".gz") ? lower.slice(0, -3) : lower;
  return path.extname(ungzipped);
}

async function readText(file: string): Promise<string> {
  const buf = await readFile(file);
  return file.toLowerCase().endsWith(".gz") ? gunzipSync(buf).toString("utf-8") : buf.toString("utf-8");
}

function normalizeColumn(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function canonicalColumn(name: string): string | undefined {
  const n = normalizeColumn(name);
  if (["tdarea", "area", "describer", "td"].includes(n)) return "tdArea";
  if (["address", "addr", "byte", "sclassaddress"].includes(n)) return "address";
  if (["bit", "bitindex", "bitno", "bitnumber"].includes(n)) return "bit";
  if (["itemtype", "type", "function"].includes(n)) return "itemType";
  if (["itemid", "id", "item", "signal", "signalid", "signalnumber"].includes(n)) return "itemId";
  if (["aspect", "state", "indication"].includes(n)) return "aspect";
  if (["description", "desc", "name"].includes(n)) return "description";
  return undefined;
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
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
    } else if (ch === delimiter && !quoted) {
      out.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

function inferDelimiter(raw: string, ext: string): string {
  if (ext === ".tsv") return "\t";
  const firstDataLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  if (firstDataLine?.includes("\t")) return "\t";
  return ",";
}

function normalizeRows(
  list: Array<Record<string, unknown>>,
  fileArea?: string,
): SopRow[] {
  const rows: SopRow[] = [];
  for (const r of list) {
    const tdArea = ((r.tdArea as string) ?? fileArea)?.trim();
    const address = r.address;
    const bit = Number(r.bit);
    const itemType = (r.itemType as string)?.trim();
    if (!tdArea || address === undefined || !Number.isInteger(bit) || !itemType) continue;
    if (bit < 0 || bit > 7) continue;
    rows.push({
      tdArea,
      address: normAddr(address as string | number),
      bit,
      itemType,
      itemId: (r.itemId as string)?.trim() || undefined,
      aspect: (r.aspect as string)?.trim() || undefined,
      description: (r.description as string)?.trim() || undefined,
    });
  }
  return rows;
}

function parseJsonRows(file: string, raw: string): SopRow[] {
  const parsed = JSON.parse(raw) as
    | Array<Record<string, unknown>>
    | { tdArea?: string; rows: Array<Record<string, unknown>> };
  const fileArea =
    Array.isArray(parsed) ? undefined : (parsed.tdArea as string | undefined);
  const list = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(list)) throw new Error(`${path.basename(file)}: no rows`);
  return normalizeRows(list, fileArea);
}

function parseDelimitedRows(file: string, raw: string, ext: string): SopRow[] {
  const delimiter = inferDelimiter(raw, ext);
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) return [];

  const headers = splitDelimitedLine(lines[0]!, delimiter).map(canonicalColumn);
  const list = lines.slice(1).map((line) => {
    const cells = splitDelimitedLine(line, delimiter);
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      if (h && cells[i] !== undefined) row[h] = cells[i];
    });
    return row;
  });
  return normalizeRows(list);
}

/** Parse one SOP file into normalized rows. */
export async function parseSopFile(file: string): Promise<SopRow[]> {
  const ext = formatOf(file);
  const raw = await readText(file);
  if (ext === ".json") return parseJsonRows(file, raw);
  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") return parseDelimitedRows(file, raw, ext);
  throw new Error(
    `unsupported SOP format ${ext || "(none)"} (${path.basename(file)}) — use .json, .csv, .tsv, .txt or .gz`,
  );
}

function isSopFile(file: string): boolean {
  const ext = formatOf(file);
  return ext === ".json" || ext === ".csv" || ext === ".tsv" || ext === ".txt";
}

async function parseFile(file: string): Promise<SopRow[]> {
  try {
    return await parseSopFile(file);
  } catch (err) {
    throw new Error(`${path.basename(file)}: ${(err as Error).message}`);
  }
}

export async function loadSop(): Promise<void> {
  const db = createDb();
  const dir = sopDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter(isSopFile);
  } catch {
    console.warn(`[nr] SOP dir not found (${dir}) — no signalling maps loaded.`);
    return;
  }
  if (files.length === 0) {
    console.warn(`[nr] no SOP files in ${dir} — signals will render as "unknown".`);
    return;
  }

  const all: SopRow[] = [];
  const areas = new Set<string>();
  for (const f of files) {
    const rows = await parseFile(path.join(dir, f));
    for (const r of rows) areas.add(r.tdArea);
    all.push(...rows);
    console.log(`[nr] SOP ${f}: ${rows.length} rows`);
  }

  // Replace mappings for the areas present in these files (idempotent reload).
  for (const area of areas) {
    await db.delete(sopMapping).where(eqArea(area));
  }
  for (let i = 0; i < all.length; i += BATCH) {
    await db.insert(sopMapping).values(all.slice(i, i + BATCH));
  }
  console.log(`[nr] loaded ${all.length} SOP rows across ${areas.size} area(s).`);
}

function eqArea(area: string) {
  return eq(sopMapping.tdArea, area);
}
