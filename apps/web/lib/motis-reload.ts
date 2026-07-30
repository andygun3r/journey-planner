import { spawn } from "node:child_process";

/**
 * Reimport the refreshed GTFS into MOTIS, then restart it.
 *
 * Both steps, always. MOTIS has no live-reload API — `motis server` only serves
 * whatever is already preprocessed under /data/data, so a restart on its own
 * picks up nothing. The SFTP sync path used to restart without importing, which
 * meant it updated Postgres, reported success, and quietly left routing on the
 * old timetable. Having one helper both callers use is what stops that
 * happening again.
 *
 * The import runs as its own throwaway container rather than `docker exec` into
 * the serving one, so it gets its own memory budget instead of sharing the
 * server's cgroup. Preprocessing the GB-wide dataset is the heaviest step in the
 * pipeline and has run the box out of memory; it must not also be squeezed by
 * whatever the live server is holding.
 */

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args[0]} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)),
    );
  });
}

export type ReloadProgress = (line: string) => void;

export async function reloadMotis(onProgress: ReloadProgress): Promise<void> {
  const container = process.env.MOTIS_CONTAINER_NAME ?? "mainline-motis-1";
  const image = process.env.MOTIS_IMAGE ?? "ghcr.io/motis-project/motis:latest";
  const importMemory = process.env.MOTIS_IMPORT_MEMORY;

  onProgress("Reimporting into motis (separate container)...");
  await run("docker", [
    "run",
    "--rm",
    // Reuse the serving container's volumes, so the import writes where the
    // server reads. Survives the volume renaming that deploy tools apply.
    "--volumes-from",
    container,
    ...(importMemory ? ["--memory", importMemory] : []),
    "-w",
    "/data",
    image,
    "/motis",
    "import",
    "-d",
    "/data/data",
    "-c",
    "/data/config.yml",
  ]);

  onProgress("Restarting motis to serve the new data...");
  await run("docker", ["restart", container]);
}
