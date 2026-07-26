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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — required for SFTP feed delivery`);
  return value;
}

/** Picks the most recently modified .zip in the remote directory. */
async function latestZip(sftp: SftpClient, remoteDir: string): Promise<SftpClient.FileInfo> {
  const entries = await sftp.list(remoteDir);
  const zips = entries.filter((e) => e.type === "-" && e.name.toLowerCase().endsWith(".zip"));
  zips.sort((a, b) => b.modifyTime - a.modifyTime);
  const [latest] = zips;
  if (!latest) throw new Error(`No .zip files found in SFTP dir ${remoteDir}`);
  return latest;
}

export async function downloadFeedViaSftp(feed: SftpFeedName, destDir: string): Promise<string> {
  const host = requireEnv("DTD_SFTP_HOST");
  const port = Number(process.env.DTD_SFTP_PORT || "22");
  const username = requireEnv("DTD_SFTP_USERNAME");
  const password = requireEnv("DTD_SFTP_PASSWORD");
  const remoteDir = REMOTE_DIRS[feed];

  const sftp = new SftpClient();
  try {
    await sftp.connect({ host, port, username, password });
    const file = await latestZip(sftp, remoteDir);
    await mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, file.name);
    await sftp.fastGet(`${remoteDir}/${file.name}`, dest);
    console.log(`Downloaded ${feed} via SFTP -> ${dest}`);
    return dest;
  } finally {
    await sftp.end();
  }
}
