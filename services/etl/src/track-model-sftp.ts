import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import SftpClient from "ssh2-sftp-client";
import { trackModel } from "./track-model.js";

/**
 * SFTP wrapper for Network Rail Track Model drops. It accepts either a zip /
 * tar.gz archive named with the NWR_TrackModel prefix, or individual files with
 * that prefix, then feeds the normalized shapefile directory to the existing
 * track-model importer.
 */

const PREFIX = "nwr_trackmodel";
const REQUIRED = ["NWR_TrackCentreLines.shp", "NWR_TrackCentreLines.dbf"];

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] || (fallback ? process.env[fallback] : undefined);
}

function requireEnv(name: string, fallback?: string): string {
  const value = env(name, fallback);
  if (!value) throw new Error(`${name}${fallback ? ` / ${fallback}` : ""} is not set`);
  return value;
}

function remoteDir(): string {
  return env("NR_SFTP_TRACK_MODEL_DIR", "DTD_SFTP_TRACK_MODEL_DIR") ?? "/";
}

function workDir(): string {
  return process.env.TRACK_MODEL_SFTP_WORK_DIR ?? "/tmp/signaller-track-model-sftp";
}

function deleteProcessed(): boolean {
  return process.env.NR_SFTP_DELETE_PROCESSED !== "false";
}

async function withSftp<T>(fn: (sftp: SftpClient) => Promise<T>): Promise<T> {
  const host = requireEnv("NR_SFTP_HOST", "DTD_SFTP_HOST");
  const port = Number(env("NR_SFTP_PORT", "DTD_SFTP_PORT") || "22");
  const username = requireEnv("NR_SFTP_USERNAME", "DTD_SFTP_USERNAME");
  const password = requireEnv("NR_SFTP_PASSWORD", "DTD_SFTP_PASSWORD");

  const sftp = new SftpClient();
  try {
    await sftp.connect({ host, port, username, password });
    return await fn(sftp);
  } finally {
    await sftp.end();
  }
}

function remotePath(dir: string, file: string): string {
  return `${dir.replace(/\/$/, "")}/${file}`;
}

function isArchive(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".zip");
}

async function extractTarGz(file: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", file, "-C", dest], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
}

async function extractZip(file: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("unzip", ["-q", "-o", file, "-d", dest], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip exited with code ${code}`));
    });
  });
}

async function extractArchive(file: string, dest: string): Promise<void> {
  if (file.toLowerCase().endsWith(".zip")) await extractZip(file, dest);
  else await extractTarGz(file, dest);
}

async function findModelDir(root: string): Promise<string> {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (REQUIRED.every((f) => existsSync(path.join(dir, f)))) return dir;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
    }
  }
  throw new Error(`No Track Model shapefile set found under ${root}`);
}

async function normalizePrefixedFiles(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.toLowerCase().startsWith(`${PREFIX}_`)) continue;
    const normalized = name.slice("NWR_TrackModel_".length);
    if (normalized) await rename(path.join(dir, name), path.join(dir, normalized));
  }
}

export async function syncTrackModelFromSftp(): Promise<void> {
  await withSftp(async (sftp) => {
    const dir = remoteDir();
    const files = (await sftp.list(dir))
      .filter((e) => e.type === "-" && e.name.toLowerCase().startsWith(PREFIX))
      .sort((a, b) => a.modifyTime - b.modifyTime);

    if (files.length === 0) {
      console.log(`[track-model] no ${PREFIX}* files found in SFTP dir ${dir}`);
      return;
    }

    const root = workDir();
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    const archives = files.filter((f) => isArchive(f.name));
    const filesToLoad =
      archives.length > 0
        ? [archives.sort((a, b) => a.modifyTime - b.modifyTime || a.name.localeCompare(b.name)).at(-1)!]
        : files;

    for (const file of filesToLoad) {
      const remote = remotePath(dir, file.name);
      const local = path.join(root, file.name);
      await sftp.fastGet(remote, local);
      console.log(`[track-model] downloaded ${remote} -> ${local}`);
      if (isArchive(file.name)) await extractArchive(local, root);
    }

    await normalizePrefixedFiles(root);
    const modelDir = await findModelDir(root);
    await trackModel(modelDir);

    if (deleteProcessed()) {
      for (const file of files) {
        const remote = remotePath(dir, file.name);
        await sftp.delete(remote);
        console.log(`[track-model] deleted processed SFTP file ${remote}`);
      }
    }
  });
}
