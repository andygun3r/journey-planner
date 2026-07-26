import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { applyBundle } from "./etl-apply";

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

export function startApplyJob(bundlePath: string): string {
  const id = randomUUID();
  const emitter = new EventEmitter();
  const job: EtlJob = { id, status: "running", lines: [], emitter };
  jobs.set(id, job);

  const onProgress = (message: string) => {
    job.lines.push(message);
    job.emitter.emit("line", message);
  };

  applyBundle(bundlePath, onProgress)
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
      rm(bundlePath, { force: true }).catch(() => {});
    });

  return id;
}

export function getJob(id: string): EtlJob | undefined {
  return jobs.get(id);
}
