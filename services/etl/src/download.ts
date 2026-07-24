import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Downloads DTD static feeds from the National Rail Data Portal (NRDP).
 * Flow: POST /authenticate (username/password) -> token -> GET staticfeed
 * with X-Auth-Token. Feed paths:
 *   timetable: /api/staticfeeds/3.0/timetable   (RJTTF zip)
 *   fares:     /api/staticfeeds/2.0/fares       (RJFAF zip)
 *   routeing:  /api/staticfeeds/2.0/routeing    (RJRG zip)
 * If the RDM file-feed is preferred later, add a second downloader here.
 */

const NRDP_BASE = process.env.NRDP_BASE_URL ?? "https://opendata.nationalrail.co.uk";

async function authenticate(): Promise<string> {
  const username = process.env.NRDP_USERNAME;
  const password = process.env.NRDP_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "NRDP_USERNAME / NRDP_PASSWORD are not set — add them to .env (register at opendata.nationalrail.co.uk)",
    );
  }
  const res = await fetch(`${NRDP_BASE}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
  });
  if (!res.ok) throw new Error(`NRDP authenticate failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error("NRDP authenticate response had no token");
  return json.token;
}

export type FeedName = "timetable" | "fares" | "routeing";

const FEED_PATHS: Record<FeedName, string> = {
  timetable: "/api/staticfeeds/3.0/timetable",
  fares: "/api/staticfeeds/2.0/fares",
  routeing: "/api/staticfeeds/2.0/routeing",
};

export async function downloadFeed(feed: FeedName, destDir: string): Promise<string> {
  const token = await authenticate();
  const res = await fetch(`${NRDP_BASE}${FEED_PATHS[feed]}`, {
    headers: { "X-Auth-Token": token },
  });
  if (!res.ok || !res.body) {
    throw new Error(`NRDP ${feed} download failed: ${res.status}`);
  }
  // Content-Disposition carries the versioned name, e.g. RJTTF512.ZIP.
  const disposition = res.headers.get("content-disposition") ?? "";
  const nameMatch = /filename="?([^";]+)"?/.exec(disposition);
  const filename = nameMatch?.[1] ?? `${feed}-${new Date().toISOString().slice(0, 10)}.zip`;

  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, filename);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  console.log(`Downloaded ${feed} -> ${dest}`);
  return dest;
}
