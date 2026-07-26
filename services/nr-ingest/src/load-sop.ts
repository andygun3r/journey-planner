import { createDb, sopMapping } from "@mainline/db";
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads SOP / ECS bit-map reference data into sop_mapping. Each TD area's file
 * says which signalling item every (address, bit) represents, so live S-class
 * bytes (nr_signalling_state) can be decoded into per-signal aspects.
 *
 * These files are sourced manually per area (Open Rail Data SOP tables / ECS
 * specs / FOI releases) — Network Rail publishes no single download, and not
 * every area is documented. Drop files into data/sop/ (or $SOP_DIR) and re-run.
 *
 * Format is pluggable; JSON is the default. A file is either an array of rows,
 * or `{ tdArea, rows: [...] }` where per-row tdArea may be omitted. Each row:
 *   { tdArea?, address, bit, itemType, itemId?, aspect?, description? }
 * `address` is hex (case-insensitive); `bit` is 0-7. Extend parseFile() to add
 * CSV or other formats without touching the rest of the pipeline.
 */

const db = createDb();
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

/** Parse one SOP file into normalized rows. Default format: JSON. */
async function parseFile(file: string): Promise<SopRow[]> {
  const ext = path.extname(file).toLowerCase();
  const raw = await readFile(file, "utf-8");
  if (ext !== ".json") {
    throw new Error(`unsupported SOP format ${ext} (${path.basename(file)}) — only .json for now`);
  }
  const parsed = JSON.parse(raw) as
    | Array<Record<string, unknown>>
    | { tdArea?: string; rows: Array<Record<string, unknown>> };
  const fileArea =
    Array.isArray(parsed) ? undefined : (parsed.tdArea as string | undefined);
  const list = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(list)) throw new Error(`${path.basename(file)}: no rows`);

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

export async function loadSop(): Promise<void> {
  const dir = sopDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json"));
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
