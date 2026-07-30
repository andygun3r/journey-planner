import { Redis } from "ioredis";

/**
 * Redis publishing for this service, in one place.
 *
 * It lives here rather than in index.ts because the useful publishes have to
 * happen deep inside the store. The position publish used to be in the caller,
 * guarded on the CRS the write returned — so a berth step that didn't map to a
 * station published nothing, which is exactly the between-station movement the
 * live map exists to show. Publishing from where the write happens fixes that.
 *
 * Everything here sends ids, not data. A consumer re-queries when it hears
 * something changed. That keeps the wire format out of the ingest schema, and it
 * is what the existing channels already do.
 */

const url = process.env.REDIS_URL;
const redis: Redis | null = url ? new Redis(url) : null;

if (!redis) console.warn("[nr] REDIS_URL not set — running without live pub/sub");

/**
 * Fire and forget, deliberately.
 *
 * These sit on the hottest write paths in the system — the TD feed alone runs
 * to hundreds of messages a second at peak. Awaiting each publish there would
 * add a network round trip per message to a loop that is already the throughput
 * ceiling, and a live-update hint is never worth slowing ingestion for. Errors
 * are swallowed for the same reason: a Redis blip must not stall the feed.
 */
function fire(channel: string, message: string): void {
  if (!redis) return;
  void redis.publish(channel, message).catch(() => {});
}

/**
 * A train moved.
 *
 * Keyed by rid where we have one, so a page following a single service can
 * subscribe to just that train. Falls back to the position row's own key when
 * the rid is unresolved, so the map still hears about it — the map recomputes
 * everything anyway and only needs to know that *something* moved.
 */
export function publishPosition(rid: string | null, trainId: string): void {
  fire(`nr:pos:${rid ?? trainId}`, trainId);
}

/** A train reported at a station. The pre-existing channel, unchanged. */
export function publishCrs(crs: string, id: string): void {
  fire(`nr:crs:${crs}`, id);
}

/**
 * Signalling state changed in a TD area.
 *
 * Nothing published this before, so the signalling diagram had no event to
 * listen for at all and could only poll. One message per area per batch rather
 * than per address — a refresh scan can carry hundreds of addresses, and the
 * consumer redraws the whole area regardless.
 */
export function publishSignalling(areas: Iterable<string>): void {
  for (const area of areas) fire(`nr:sig:${area}`, area);
}

export function closePublisher(): void {
  redis?.disconnect();
}
