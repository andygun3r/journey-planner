import { subscribeToMap } from "@/lib/live-trains-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Live train positions as Server-Sent Events.
 *
 * Replaces the map polling `/api/live-trains` every 15 seconds. That endpoint
 * runs three queries returning tens of thousands of rows to produce an answer
 * identical for every viewer, so N viewers meant N times the work. Here the
 * computation is shared: one run per tick however many people are watching.
 *
 * Events:
 *   snapshot  the full set, sent on connect and on reconnect
 *   delta     { upserted, removed } — only what changed since the last tick
 *
 * A snapshot on every connect is not optional. Redis pub/sub is fire-and-forget
 * and nothing replays it, so anything published while a client was away is
 * simply gone; only a fresh full set can be trusted after a gap.
 */
export async function GET(req: Request) {
  if (!process.env.REDIS_URL) {
    // Tell the client to stay on polling rather than leaving it on a stream
    // that will never carry anything. Same contract as the commute stream.
    return new Response("event: unavailable\ndata: {}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The client went away between the check and the write.
        }
      };

      const unsubscribe = subscribeToMap(
        (snapshot) => send("snapshot", snapshot),
        (delta) => send("delta", delta),
      );

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        // Releasing this is what lets the shared computation stop when the last
        // viewer leaves.
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      cleanup = close;
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Belt and braces for proxies that buffer by default. Traefik streams
      // without it, but nginx does not, and the failure looks like working code.
      "X-Accel-Buffering": "no",
    },
  });
}
