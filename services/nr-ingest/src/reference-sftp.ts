import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import SftpClient from "ssh2-sftp-client";
import { loadSmartFromFile } from "./reference.js";

/**
 * Pulls Network Rail reference files delivered by RDG SFTP. The timetable ETL
 * already has SFTP support; this is the equivalent path for the smaller NR
 * reference drops that make the live Train Describer data useful.
 *
 * Remote deletion is deliberately after successful processing. If a load fails,
 * the remote file stays put for the next run.
 */

const SMART_NAMES = new Set(["smartextract.csv.gz", "smartextract.json.gz"]);
const TPS_NAME = "tps_data.tar.gz";

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] || (fallback ? process.env[fallback] : undefined);
}

function requireEnv(name: string, fallback?: string): string {
  const value = env(name, fallback);
  if (!value) throw new Error(`${name}${fallback ? ` / ${fallback}` : ""} is not set`);
  return value;
}

function remoteDir(): string {
  return env("NR_SFTP_REFERENCE_DIR", "DTD_SFTP_REFERENCE_DIR") ?? "/";
}

function workDir(): string {
  return process.env.NR_SFTP_WORK_DIR ?? "/tmp/mainline-nr-reference";
}

function tpsDir(): string {
  return process.env.NR_TPS_DIR ?? "/data/tps";
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

async function stageTpsArchive(file: string): Promise<void> {
  const dest = tpsDir();
  await rm(dest, { recursive: true, force: true });
  await extractTarGz(file, dest);
  console.log(`[nr] staged Train Planning Model into ${dest}`);
}

export async function syncReferenceFromSftp(): Promise<void> {
  await withSftp(async (sftp) => {
    const dir = remoteDir();
    const entries = await sftp.list(dir);
    const files = entries
      .filter((e) => e.type === "-")
      .filter((e) => SMART_NAMES.has(e.name.toLowerCase()) || e.name.toLowerCase() === TPS_NAME)
      .sort((a, b) => a.modifyTime - b.modifyTime);

    if (files.length === 0) {
      console.log(`[nr] no SMART/TPS reference files found in SFTP dir ${dir}`);
      return;
    }

    await mkdir(workDir(), { recursive: true });

    for (const file of files) {
      const remote = remotePath(dir, file.name);
      const local = path.join(workDir(), file.name);
      await sftp.fastGet(remote, local);
      console.log(`[nr] downloaded ${remote} -> ${local}`);

      if (SMART_NAMES.has(file.name.toLowerCase())) {
        await loadSmartFromFile(local);
      } else if (file.name.toLowerCase() === TPS_NAME) {
        await stageTpsArchive(local);
      }

      if (deleteProcessed()) {
        await sftp.delete(remote);
        console.log(`[nr] deleted processed SFTP file ${remote}`);
      }
    }
  });
}
