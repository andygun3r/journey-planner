import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { applyBundle } from "./etl-apply";
import type { ApplyProgress } from "./etl-apply";

export type EtlJobStatus = "running" | "done" | "error";

interface EtlJob {
  id: string;
  status: EtlJobStatus;
  lines: string[];
  emitter: EventEmitter;
}

// In-memory job store — a single web instance handles this, and jobs are
// short-lived (minutes), so there's no need for Redis/persistence here.
const jobs = new Map<string, EtlJob>();

/** Starts a background job that streams progress lines via SSE (see the [jobId]/stream route). */
function startJob(run: (onProgress: ApplyProgress) => Promise<void>, cleanup?: () => Promise<void>): string {
  const id = randomUUID();
  const emitter = new EventEmitter();
  const job: EtlJob = { id, status: "running", lines: [], emitter };
  jobs.set(id, job);

  const onProgress = (message: string) => {
    job.lines.push(message);
    job.emitter.emit("line", message);
  };

  run(onProgress)
    .then(() => {
      job.status = "done";
      job.emitter.emit("status", "done");
    })
    .catch((err: Error) => {
      job.status = "error";
      job.lines.push(`Error: ${err.message}`);
      job.emitter.emit("line", `Error: ${err.message}`);
      job.emitter.emit("status", "error");
    })
    .finally(() => {
      cleanup?.().catch(() => {});
    });

  return id;
}

export function startApplyJob(bundlePath: string): string {
  return startJob(
    (onProgress) => applyBundle(bundlePath, onProgress),
    () => rm(bundlePath, { force: true }),
  );
}

export function startSftpSyncJob(): string {
  return startJob(async (onProgress) => {
    const { syncTimetableFromSftp } = await import("./etl-sftp-sync");
    await syncTimetableFromSftp(onProgress);
  });
}

export function getJob(id: string): EtlJob | undefined {
  return jobs.get(id);
}
