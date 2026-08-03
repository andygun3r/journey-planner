import { spawn } from "node:child_process";
import type { ApplyProgress } from "./etl-apply";
import { reloadMotis } from "./motis-reload";

/**
 * Runs `pnpm tsx src/index.ts timetable [arg]` inside the etl-cron container
 * and streams its output back. The web container has no dtd2mysql/MariaDB
 * access (that heavy conversion deliberately stays off the low-memory prod
 * box — see etl-apply.ts), so this runs inside the already-running etl-cron
 * container instead, via the same docker socket etl-apply.ts uses to restart
 * motis.
 */
async function runDockerExec(onProgress: ApplyProgress, container: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", ["exec", container, ...args], { stdio: ["ignore", "pipe", "pipe"] });

    const forwardLines = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length > 0) onProgress(line);
      }
    };
    child.stdout.on("data", forwardLines);
    child.stderr.on("data", forwardLines);

    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${container} exited ${code}`))));
  });
}

async function runEtlCronCommand(onProgress: ApplyProgress, command: string, arg?: string): Promise<void> {
  const container = process.env.ETL_CRON_CONTAINER_NAME ?? "mainline-etl-cron-1";
  const args = ["pnpm", "tsx", "src/index.ts", command];
  if (arg) args.push(arg);
  onProgress(`[etl] running ${command}${arg ? ` ${arg}` : ""}`);
  await runDockerExec(onProgress, container, args);
}

async function runEtlCronTimetable(onProgress: ApplyProgress, arg?: string): Promise<void> {
  await runEtlCronCommand(onProgress, "timetable", arg);
  // Import AND restart. This used to only restart, which does nothing at all
  // against already-preprocessed data — so this path reported success while
  // leaving routing on the old timetable, with Postgres and MOTIS disagreeing.
  await reloadMotis(onProgress);

  onProgress("Done.");
}

/**
 * On-demand SFTP pull-and-import. etl-cron's `timetable` command (no arg)
 * already applies every SFTP file not yet recorded in etl_run (monthly full
 * + daily updates), oldest first — see services/etl/src/index.ts.
 */
export async function syncTimetableFromSftp(onProgress: ApplyProgress): Promise<void> {
  await runEtlCronTimetable(onProgress);
}

/**
 * On-demand SFTP sweep for every rail data drop the deployment understands:
 * DTD timetable, DTD fares, NR SMART/TPS reference files, and Network Rail
 * Track Model snapshots. Each underlying command is idempotent/no-op when its
 * SFTP folder has nothing new.
 */
export async function syncAllRailDataFromSftp(onProgress: ApplyProgress): Promise<void> {
  await runEtlCronTimetable(onProgress);
  await runEtlCronCommand(onProgress, "fares");

  const referenceContainer = process.env.NR_REFERENCE_SYNC_CONTAINER_NAME ?? "mainline-nr-reference-sync-1";
  onProgress("[nr] running reference-sftp");
  await runDockerExec(onProgress, referenceContainer, ["node", "dist/index.js", "reference-sftp"]);

  await runEtlCronCommand(onProgress, "track-model-sftp");
  onProgress("All SFTP rail data sync complete.");
}

/**
 * Imports one raw DTD zip (e.g. RJTTF512.ZIP) already saved to the shared
 * dtd-archive volume. Passing an explicit path makes etl-cron's `timetable`
 * command import that file directly instead of polling SFTP — see
 * services/etl/src/index.ts `timetable(source?)`.
 */
export async function importUploadedTimetableZip(zipPathInContainer: string, onProgress: ApplyProgress): Promise<void> {
  await runEtlCronTimetable(onProgress, zipPathInContainer);
}
