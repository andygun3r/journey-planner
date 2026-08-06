import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import { classifyZip } from "./classify-zip.js";

/**
 * Pulls the latest DTD static feed zip from RDG's SFTP delivery — the push/pull
 * alternative to the NRDP HTTPS staticfeed API (same RJTTF/RJFAF products,
 * different transport, separate account from NRDP_USERNAME/PASSWORD).
 */

export type SftpFeedName = "timetable" | "fares";

const REMOTE_DIRS: Record<SftpFeedName, string> = {
  timetable: process.env.DTD_SFTP_TIMETABLE_DIR || "/timetable",
  fares: process.env.DTD_SFTP_FARES_DIR || "/fares",
};

// Optional pre-filter for accounts that deliver every feed into one shared
// root folder: narrows the SFTP directory listing by filename before
// anything downloads, so a known filename pattern skips wasted downloads of
// files that content-classification (below) would reject anyway. Not
// required — classifyZip() catches mismatches either way — this is purely
// a bandwidth/time optimization when you know your account's naming.
const NAME_PREFIXES: Record<SftpFeedName, string | undefined> = {
  timetable: process.env.DTD_SFTP_TIMETABLE_PREFIX,
  fares: process.env.DTD_SFTP_FARES_PREFIX,
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — required for SFTP feed delivery`);
  return value;
}

/** All .zip files in the remote directory matching the feed's name prefix (if set), oldest first. */
async function listZips(sftp: SftpClient, remoteDir: string, feed: SftpFeedName): Promise<SftpClient.FileInfo[]> {
  const prefix = NAME_PREFIXES[feed]?.toLowerCase();
  const entries = await sftp.list(remoteDir);
  const zips = entries.filter(
    (e) =>
      e.type === "-" &&
      e.name.toLowerCase().endsWith(".zip") &&
      (!prefix || e.name.toLowerCase().startsWith(prefix)),
  );
  zips.sort((a, b) => a.modifyTime - b.modifyTime);
  return zips;
}

/**
 * Downloads a candidate, then peeks inside to confirm it's actually the feed
 * being asked for — some RDG SFTP accounts drop timetable/fares/Track Model
 * files into one shared folder with no per-feed subdirectories, so a
 * directory listing alone can't always tell them apart (see
 * classify-zip.ts). Deletes and returns null on a mismatch rather than
 * letting a wrong-feed zip reach dtd2mysql and fail deep in the pipeline.
 */
async function downloadIfMatches(
  sftp: SftpClient,
  remoteDir: string,
  file: SftpClient.FileInfo,
  destDir: string,
  feed: SftpFeedName,
): Promise<string | null> {
  const dest = path.join(destDir, file.name);
  await sftp.fastGet(`${remoteDir}/${file.name}`, dest);

  const kind = await classifyZip(dest);
  // "timetable" must actually look like one; "fares" has no reliable content
  // signature of its own, so anything that isn't recognisably Track Model,
  // timetable, or unreadable is accepted as fares — see classify-zip.ts.
  // "unreadable" (corrupted/truncated on the remote server — seen in
  // practice with a genuinely broken NWR_TrackModel*.zip) never matches
  // either feed; a broken file must never be fed to dtd2mysql.
  const matches =
    kind !== "unreadable" &&
    (feed === "timetable" ? kind === "timetable" : kind !== "track-model" && kind !== "timetable");
  if (!matches) {
    console.log(`Skipping ${file.name} — looks like ${kind}, not ${feed}`);
    await unlink(dest);
    return null;
  }

  console.log(`Downloaded ${feed} via SFTP -> ${dest}`);
  return dest;
}

async function withSftp<T>(fn: (sftp: SftpClient) => Promise<T>): Promise<T> {
  const host = requireEnv("DTD_SFTP_HOST");
  const port = Number(process.env.DTD_SFTP_PORT || "22");
  const username = requireEnv("DTD_SFTP_USERNAME");
  const password = requireEnv("DTD_SFTP_PASSWORD");

  const sftp = new SftpClient();
  try {
    await sftp.connect({ host, port, username, password });
    return await fn(sftp);
  } finally {
    await sftp.end();
  }
}

export async function downloadFeedViaSftp(feed: SftpFeedName, destDir: string): Promise<string> {
  return withSftp(async (sftp) => {
    const remoteDir = REMOTE_DIRS[feed];
    const zips = await listZips(sftp, remoteDir, feed);
    await mkdir(destDir, { recursive: true });

    // Newest first: try the most recent candidate, fall through to older
    // ones if a shared-folder mismatch keeps rejecting them.
    for (const file of [...zips].reverse()) {
      const dest = await downloadIfMatches(sftp, remoteDir, file, destDir, feed);
      if (dest) return dest;
    }
    throw new Error(`No ${feed} zip found in SFTP dir ${remoteDir}`);
  });
}

export interface DownloadedFeedFile {
  path: string;
  /** Remote file mtime at download time (epoch ms). */
  sourceModifiedAt: number;
}

/**
 * Downloads every .zip in the remote directory whose mtime is newer than
 * `sinceModifiedAt` — oldest first, so a monthly full drop and any daily
 * updates since are applied in delivery order. Mtime, not filename, is what
 * decides "already imported": RDG's SFTP drop reuses static filenames (e.g.
 * timetable_full.zip) rather than versioned ones, so a name-based skip would
 * miss real updates. Used instead of downloadFeedViaSftp so a run never
 * skips files that landed between cron runs (e.g. after downtime, or a full
 * + same-day daily).
 */
export async function downloadPendingFeedsViaSftp(
  feed: SftpFeedName,
  destDir: string,
  sinceModifiedAt: number,
): Promise<DownloadedFeedFile[]> {
  return withSftp(async (sftp) => {
    const remoteDir = REMOTE_DIRS[feed];
    const zips = await listZips(sftp, remoteDir, feed);
    const pending = zips.filter((z) => z.modifyTime > sinceModifiedAt);

    await mkdir(destDir, { recursive: true });
    const dests: DownloadedFeedFile[] = [];
    for (const file of pending) {
      const dest = await downloadIfMatches(sftp, remoteDir, file, destDir, feed);
      if (dest) dests.push({ path: dest, sourceModifiedAt: file.modifyTime });
    }
    return dests;
  });
}
