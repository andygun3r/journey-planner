import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { guarded, EtlBusyError } from "./run-guard.js";
import { syncTrackModelFromSftp } from "./track-model-sftp.js";
import { fares, importTimetableZip, timetable } from "./commands.js";

/**
 * HTTP entry point for the etl service, used once web/etl-cron are separate
 * Coolify apps with no shared Docker socket or shared dtd-archive/gtfs-data
 * volume to reach across (see apps/web/lib/etl-sftp-sync.ts, which used to
 * `docker exec` into this service's container by name, and
 * apps/web/app/api/etl/upload-raw/route.ts, which used to write an uploaded
 * zip to a volume etl-cron read from the same path). Runs alongside the
 * existing CLI dispatch in index.ts — set HTTP_PORT to start it; the one-off
 * `docker run --rm etl <command>` CLI path is unaffected.
 *
 * Every route re-runs the exact function the CLI's `switch` in index.ts
 * calls, including the guarded() lock — two triggers (a human clicking
 * "sync" and the nightly cron) racing on the same MariaDB scratch DB is
 * exactly what run-guard.ts exists to prevent, so this must not bypass it.
 */

const UPLOAD_DIR = path.join(process.env.ETL_ARCHIVE_DIR ?? "/data/dtd/archive", "incoming");

function checkAuth(req: IncomingMessage): boolean {
  const expected = process.env.ETL_INTERNAL_KEY;
  if (!expected) return false;
  return req.headers["x-internal-key"] === expected;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Node's fetch() wraps the real network error (DNS failure, connection
 * refused, timeout, ...) in `.cause`, one or two levels deep — the
 * top-level message is always just "fetch failed", which is useless on its
 * own. Unwrap it so logs/responses show what actually went wrong.
 */
function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" -> ");
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Accepts a raw DTD timetable zip's bytes directly in the request body (the
 * web app's /api/etl/upload-raw route streams the upload straight through,
 * rather than writing it somewhere etl is expected to also have mounted).
 * Filename comes from x-filename, sanitized the same way the old route did.
 */
async function handleUpload(req: IncomingMessage): Promise<void> {
  const rawName = (req.headers["x-filename"] as string) || "timetable.zip";
  const filename = path.basename(rawName).replace(/[^A-Za-z0-9._-]/g, "_") || "timetable.zip";
  await mkdir(UPLOAD_DIR, { recursive: true });
  const zipPath = path.join(UPLOAD_DIR, filename);
  await writeFile(zipPath, await readBody(req));
  await guarded("etl-timetable", "timetable", () => importTimetableZip(zipPath));
}

type Handler = (req: IncomingMessage) => Promise<unknown>;

const routes: Record<string, Handler> = {
  "/timetable": () => guarded("etl-timetable", "timetable", () => timetable()),
  "/fares": () => guarded("etl-fares", "fares", () => fares()),
  "/track-model-sftp": () => syncTrackModelFromSftp(),
  "/upload": (req) => handleUpload(req),
};

/**
 * The etl-cron Coolify app runs both the nightly sweep and this HTTP server
 * in one standing container — same combination the old etl-cron compose
 * service ran (crond -f, backgrounded, plus a long-running process), just
 * started from here instead of a separate shell entrypoint. dcron's
 * setpgid(0,0) call fails with EPERM as PID 1 (a session leader may never
 * change its own process group), so this process — the HTTP server —
 * must be PID 1, with crond as its child, not the other way round.
 */
function startCronIfRequested(): void {
  if (process.env.ETL_CRON !== "1") return;
  console.log("[etl] starting crond for the nightly sweep");
  const crond = spawn("crond", ["-f", "-l", "2"], { stdio: "inherit" });
  crond.on("exit", (code) => {
    console.error(`[etl] crond exited unexpectedly (${code}) — nightly sweep will not run`);
  });
}

export function startServer(port: number): void {
  startCronIfRequested();
  const server = createServer((req, res) => {
    void (async () => {
      if (!checkAuth(req)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      const handler = req.url ? routes[req.url] : undefined;
      if (req.method !== "POST" || !handler) {
        send(res, 404, { error: "not found" });
        return;
      }

      try {
        await handler(req);
        send(res, 200, { ok: true });
      } catch (err) {
        if (err instanceof EtlBusyError) {
          send(res, 409, { error: err.message });
          return;
        }
        const description = describeError(err);
        console.error(`[etl] ${req.url} failed:`, description);
        send(res, 500, { error: description });
      }
    })();
  });

  server.listen(port, () => {
    console.log(`[etl] HTTP server listening on :${port}`);
  });
}
