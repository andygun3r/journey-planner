import Redis from "ioredis";

/**
 * One Redis subscriber for the whole web process, shared by every open stream.
 *
 * The commute stream used to call `new Redis()` per request, so every browser
 * tab held its own TCP connection and its own subscription. Ten people with
 * three tabs each meant thirty Redis connections doing identical work — fine
 * for one user, not fine for a public deployment.
 *
 * This keeps a single connection and fans messages out in process. Subscriptions
 * are reference-counted, so a channel is unsubscribed when its last listener
 * leaves and Redis is told about a channel once rather than once per viewer.
 */

export type Listener = (channel: string, message: string) => void;

interface Bus {
  redis: Redis | null;
  listeners: Map<string, Set<Listener>>;
}

/**
 * Held on globalThis because Next.js reloads modules in development, and a
 * plain module-level variable would leak a connection per reload. This is the
 * standard pattern for a long-lived client in a Next app.
 */
const globalForBus = globalThis as unknown as { __mainlineLiveBus?: Bus };

function bus(): Bus {
  globalForBus.__mainlineLiveBus ??= { redis: null, listeners: new Map() };
  return globalForBus.__mainlineLiveBus;
}

/** The shared subscriber, connected on first use. Null when Redis isn't configured. */
function subscriber(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  const b = bus();
  if (b.redis) return b.redis;

  const redis = new Redis(url, {
    // A live stream is worth reconnecting for indefinitely; giving up would
    // silently downgrade every viewer to polling until the process restarts.
    maxRetriesPerRequest: null,
  });

  redis.on("message", (channel, message) => {
    for (const listener of b.listeners.get(channel) ?? []) {
      try {
        listener(channel, message);
      } catch {
        // One broken stream must not stop the others being served.
      }
    }
  });

  // On a reconnect, ioredis does not restore subscriptions for us.
  redis.on("ready", () => {
    const channels = [...b.listeners.keys()];
    if (channels.length > 0) void redis.subscribe(...channels).catch(() => {});
  });

  redis.on("error", () => {
    // Connection-level errors are already retried; swallow so an unhandled
    // 'error' event cannot take the process down.
  });

  b.redis = redis;
  return redis;
}

/**
 * Listen to a Redis channel. Returns an unsubscribe function — always call it,
 * normally from the request's abort handler, or the listener set grows forever.
 */
export function subscribe(channel: string, listener: Listener): () => void {
  const redis = subscriber();
  if (!redis) return () => {};

  const b = bus();
  let set = b.listeners.get(channel);
  if (!set) {
    set = new Set();
    b.listeners.set(channel, set);
    // First listener for this channel: tell Redis about it.
    void redis.subscribe(channel).catch(() => {});
  }
  set.add(listener);

  return () => {
    const current = b.listeners.get(channel);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      b.listeners.delete(channel);
      void redis.unsubscribe(channel).catch(() => {});
    }
  };
}

/** How many channels and listeners are live. Reported by /api/metrics. */
export function busStats(): { channels: number; listeners: number } {
  const b = bus();
  let listeners = 0;
  for (const set of b.listeners.values()) listeners += set.size;
  return { channels: b.listeners.size, listeners };
}
