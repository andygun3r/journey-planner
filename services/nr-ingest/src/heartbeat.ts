import { closeSync, openSync, utimesSync } from "node:fs";

/**
 * Records that the ingest loop is still doing work, for the container health
 * check to read.
 *
 * The old check was `pgrep -f 'tsx src/index.ts'`, which only proves a process
 * exists. A Kafka or STOMP consumer can be alive and connected while consuming
 * nothing at all — after a silent auth failure, a dropped subscription, or a
 * handler wedged on a slow query — and the container kept reporting healthy the
 * whole time. That is precisely the "live updates went stale and nothing
 * restarted" case, and the compose file's own comment admitted the check could
 * not catch it.
 *
 * A file's mtime is enough: no HTTP server, no port to expose, and the check is
 * a one-line `find -newermt`.
 */
const PATH = process.env.INGEST_HEARTBEAT_FILE ?? "/tmp/ingest-heartbeat";

/**
 * Touching on every message would be a syscall per message on a feed doing
 * thousands a minute. Once every few seconds says the same thing.
 */
const MIN_INTERVAL_MS = 5_000;

let lastTouch = 0;

/** Call from the message loop. Cheap, and rate-limited internally. */
export function beat(now = Date.now()): void {
  if (now - lastTouch < MIN_INTERVAL_MS) return;
  lastTouch = now;
  try {
    const when = new Date(now);
    try {
      utimesSync(PATH, when, when);
    } catch {
      // First call, or the file was cleared: create it.
      closeSync(openSync(PATH, "w"));
    }
  } catch {
    // A health check that can't be written is not worth crashing ingest over.
  }
}
