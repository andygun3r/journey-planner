import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Sidecar container for the motis Coolify app.
 *
 * Two things motis's own image can't do for itself, both needing the Docker
 * control plane rather than anything inside the motis container:
 *
 *   1. Reimport + restart. motis has no live-reload API — `motis server`
 *      only ever serves whatever's already preprocessed under /data/data, so
 *      a restart alone picks up nothing new; `motis import` has to run
 *      first, in its own throwaway container so the (memory-heavy) import
 *      never shares a cgroup with the live server.
 *   2. Receiving a fresh GTFS zip at all. motis reads GTFS from its own
 *      `gtfs-data` volume (mounted at /input) — before this split, web/etl
 *      wrote there directly because they shared that volume over Docker
 *      Compose. As separate Coolify apps they don't anymore, so the zip has
 *      to arrive over HTTP and land in the volume via a throwaway container
 *      that mounts it, same trick as the reimport step.
 *
 * This is a second, small container in the SAME Coolify app as motis (not a
 * shared host with any other app) — it carries the docker CLI + host socket
 * mount, and its `--volumes-from`/`docker restart` calls always target its
 * sibling motis container by definition, so there's no cross-app
 * container-name guessing the way the old docker-compose-project-name
 * defaults needed.
 */

const MOTIS_CONTAINER = process.env.MOTIS_CONTAINER_NAME ?? "motis";
const MOTIS_IMAGE = process.env.MOTIS_IMAGE ?? "ghcr.io/motis-project/motis:latest";
const IMPORT_MEMORY = process.env.MOTIS_IMPORT_MEMORY;

async function reimport(): Promise<void> {
  console.log("[motis-sidecar] reimporting GTFS into motis (separate container)…");
  await exec("docker", [
    "run",
    "--rm",
    "--volumes-from",
    MOTIS_CONTAINER,
    ...(IMPORT_MEMORY ? ["--memory", IMPORT_MEMORY] : []),
    "-w",
    "/data",
    MOTIS_IMAGE,
    "/motis",
    "import",
    "-d",
    "/data/data",
    "-c",
    "/data/config.yml",
  ]);

  console.log(`[motis-sidecar] reimport done — restarting ${MOTIS_CONTAINER}`);
  await exec("docker", ["restart", MOTIS_CONTAINER]);
}

/** Streams `body` into /input/gb-rail.gtfs.zip inside motis's own gtfs-data volume via a throwaway container. */
async function writeGtfsZip(body: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", [
      "run",
      "--rm",
      "-i",
      "--volumes-from",
      MOTIS_CONTAINER,
      MOTIS_IMAGE,
      "sh",
      "-c",
      "cat > /input/gb-rail.gtfs.zip",
    ]);
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`docker run (write gtfs) exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)),
    );
    body.pipe(child.stdin);
  });
}

function checkAuth(req: IncomingMessage): boolean {
  const expected = process.env.MOTIS_REIMPORT_KEY;
  if (!expected) return false;
  return req.headers["x-internal-key"] === expected;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const port = Number(process.env.HTTP_PORT ?? 4002);
const server = createServer((req, res) => {
  void (async () => {
    if (!checkAuth(req)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 404, { error: "not found" });
      return;
    }

    try {
      if (req.url === "/reimport") {
        await reimport();
        send(res, 200, { ok: true });
      } else if (req.url === "/upload-gtfs") {
        await writeGtfsZip(req);
        send(res, 200, { ok: true });
      } else {
        send(res, 404, { error: "not found" });
      }
    } catch (err) {
      console.error(`[motis-sidecar] ${req.url} failed:`, (err as Error).message);
      send(res, 500, { error: (err as Error).message });
    }
  })();
});

server.listen(port, () => {
  console.log(`[motis-sidecar] HTTP server listening on :${port}`);
});
