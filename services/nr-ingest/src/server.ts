import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { syncReferenceFromSftp } from "./reference-sftp.js";

/**
 * Small HTTP listener alongside the live ingester daemon, used once web/
 * etl-cron are separate Coolify apps with no shared Docker socket to reach
 * across (see apps/web/lib/etl-sftp-sync.ts, which used to `docker exec`
 * into the separate nr-reference-sync container by name — that container
 * shared this exact image, so its one job (reference-sftp) is folded in here
 * as an endpoint instead of staying a standalone app).
 *
 * reference-sftp is exempt from the singleton ingest lock (see index.ts) —
 * it's an idempotent loader, safe to run while the live ingester is up.
 */

function checkAuth(req: IncomingMessage): boolean {
  const expected = process.env.NR_INGEST_INTERNAL_KEY;
  if (!expected) return false;
  return req.headers["x-internal-key"] === expected;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startServer(port: number): void {
  const server = createServer((req, res) => {
    void (async () => {
      if (!checkAuth(req)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method !== "POST" || req.url !== "/reference-sftp") {
        send(res, 404, { error: "not found" });
        return;
      }
      try {
        await syncReferenceFromSftp();
        send(res, 200, { ok: true });
      } catch (err) {
        console.error("[nr] reference-sftp failed:", (err as Error).message);
        send(res, 500, { error: (err as Error).message });
      }
    })();
  });

  server.listen(port, () => {
    console.log(`[nr] HTTP server listening on :${port}`);
  });
}
