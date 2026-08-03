import { getUserId } from "@/lib/current-user";
import { subscribe } from "@/lib/live-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events stream of commute alerts for the signed-in user. The
 * darwin-ingest worker publishes to `commute:alert:{userId}` on Redis when a
 * matched train is cancelled/delayed; this relays each as an `alert` event so
 * the dashboard's alert feed updates live (falling back to polling if the
 * connection can't be established). A comment heartbeat keeps the connection
 * alive through proxies.
 *
 * Subscribes through the shared bus rather than opening its own Redis
 * connection: this used to be one connection per browser tab.
 */
export async function GET(req: Request) {
  const userId = await getUserId();
  const redisUrl = process.env.REDIS_URL;

  if (!userId || !redisUrl) {
    // No identity or no Redis — signal the client to stick with polling.
    return new Response("event: unavailable\ndata: {}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const channel = `commute:alert:${userId}`;
  const encoder = new TextEncoder();

  // Set in start(), used by cancel() — the two are separate callbacks, and
  // either can be the one that ends the stream.
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // The client went away between the check and the write.
        }
      };

      send("ready", "{}");

      const unsubscribe = subscribe(channel, (_chan, message) => send("alert", message));

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
        // Releasing the listener is what keeps the shared bus from growing.
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
    },
  });
}
