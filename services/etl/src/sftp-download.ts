import { mkdir } from "node:fs/promises";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";

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

// Some RDG SFTP accounts deliver every feed (timetable, fares, NR Track
// Model, ...) into one shared root folder rather than per-feed
// subdirectories — in that layout, pointing DTD_SFTP_TIMETABLE_DIR at "/"
// would otherwise pick up every .zip in the folder, including files that
// belong to a different feed entirely. Filenames are the only thing that
// distinguishes them in that case, so filter by a per-feed prefix — set
// only if your account needs it; unset means "no filtering, take every
// .zip" (the original per-subfolder assumption).
const NAME_PREFIXES: Record<SftpFeedName, string | undefined> = {
  timetable: process.env.DTD_SFTP_TIMETABLE_PREFIX,
  fares: process.env.DTD_SFTP_FARES_PREFIX,
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — required for SFTP feed delivery`);
  return value;
}

/** Picks the most recently modified .zip in the remote directory. */
async function latestZip(sftp: SftpClient, remoteDir: string, feed: SftpFeedName): Promise<SftpClient.FileInfo> {
  const zips = await listZips(sftp, remoteDir, feed);
  const [latest] = zips;
  if (!latest) throw new Error(`No .zip files found in SFTP dir ${remoteDir}`);
  return latest;
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
    const file = await latestZip(sftp, remoteDir, feed);
    await mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, file.name);
    await sftp.fastGet(`${remoteDir}/${file.name}`, dest);
    console.log(`Downloaded ${feed} via SFTP -> ${dest}`);
    return dest;
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
      const dest = path.join(destDir, file.name);
      await sftp.fastGet(`${remoteDir}/${file.name}`, dest);
      console.log(`Downloaded ${feed} via SFTP -> ${dest}`);
      dests.push({ path: dest, sourceModifiedAt: file.modifyTime });
    }
    return dests;
  });
}
