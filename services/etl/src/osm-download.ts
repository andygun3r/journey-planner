import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Downloads an OpenStreetMap extract for MOTIS's street router.
 *
 * MOTIS needs OSM to route pedestrians. Without it, it plans transit only —
 * which is why journeys currently start and end at stations rather than at
 * the door, and why walking legs carry no geometry.
 *
 * Extracts come from Geofabrik, who publish daily-updated regional .osm.pbf
 * files. Default is Great Britain; `OSM_EXTRACT_URL` overrides it, which is
 * the staged-rollout path — start with a region (e.g. england/greater-london,
 * ~90MB) to prove the pipeline and measure import cost, then move to full GB
 * (~1.5GB) once the numbers are known.
 *
 * A national import is expensive in both time and memory. Nothing here forces
 * it to run: the OSM step is skipped entirely unless OSM_EXTRACT_URL is set or
 * `--with-osm` is passed, so the nightly timetable job is unchanged until
 * street routing is deliberately turned on.
 */

const DEFAULT_EXTRACT_URL =
  "https://download.geofabrik.de/europe/great-britain-latest.osm.pbf";

/** Where the pipeline keeps the extract between runs. */
export function osmCacheDir(): string {
  return process.env.OSM_CACHE_DIR ?? "/data/osm";
}

export function osmExtractUrl(): string {
  return process.env.OSM_EXTRACT_URL?.trim() || DEFAULT_EXTRACT_URL;
}

/** True when street routing has been deliberately enabled for this deployment. */
export function osmEnabled(): boolean {
  return process.env.OSM_ENABLED === "1" || Boolean(process.env.OSM_EXTRACT_URL?.trim());
}

/**
 * How old a cached extract may be before it's re-downloaded. OSM data changes
 * continuously but a footpath network is not a live feed — re-pulling ~1.5GB
 * nightly to gain a handful of new pavements would waste far more than it buys.
 */
const MAX_AGE_MS = Number(process.env.OSM_MAX_AGE_DAYS ?? 30) * 24 * 60 * 60 * 1000;

async function ageMs(file: string): Promise<number | null> {
  try {
    const s = await stat(file);
    // A zero-length file is a failed download, not a cache hit.
    return s.size > 0 ? Date.now() - s.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the extract, reusing the cached copy while it's fresh enough.
 * Returns the local path, or null when street routing isn't enabled.
 */
export async function downloadOsmExtract(force = false): Promise<string | null> {
  if (!osmEnabled()) {
    console.log("[etl] OSM street routing not enabled (set OSM_ENABLED=1 or OSM_EXTRACT_URL) — skipping.");
    return null;
  }

  const url = osmExtractUrl();
  const dir = osmCacheDir();
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(new URL(url).pathname) || "extract.osm.pbf");

  const age = await ageMs(dest);
  if (!force && age !== null && age < MAX_AGE_MS) {
    console.log(`[etl] using cached OSM extract (${Math.round(age / 86_400_000)}d old): ${dest}`);
    return dest;
  }

  console.log(`[etl] downloading OSM extract: ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    // A stale extract still routes; a missing one doesn't. Prefer stale.
    if (age !== null) {
      console.warn(`[etl] OSM download failed (${res.status}) — keeping cached copy at ${dest}`);
      return dest;
    }
    throw new Error(`OSM download failed: ${res.status} ${url}`);
  }

  // Write to a temp path and rename, so an interrupted download can never be
  // mistaken for a complete extract on the next run.
  const tmp = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dest);

  const size = (await stat(dest)).size;
  console.log(`[etl] OSM extract ready: ${dest} (${(size / 1_048_576).toFixed(0)} MB)`);
  return dest;
}
