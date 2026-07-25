import Redis from "ioredis";
import { getDeviceId } from "@/lib/device";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events stream of commute alerts for the current device. The
 * darwin-ingest worker publishes to `commute:alert:{deviceId}` on Redis when a
 * matched train is cancelled/delayed; this relays each as an `alert` event so
 * the dashboard's alert feed updates live (falling back to polling if the
 * connection can't be established). A comment heartbeat keeps the connection
 * alive through proxies.
 */
export async function GET(req: Request) {
  const deviceId = await getDeviceId();
  const redisUrl = process.env.REDIS_URL;

  if (!deviceId || !redisUrl) {
    // No identity or no Redis — signal the client to stick with polling.
    return new Response("event: unavailable\ndata: {}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const channel = `commute:alert:${deviceId}`;
  const sub = new Redis(redisUrl);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      send("ready", "{}");

      sub.subscribe(channel).catch(() => {
        // If the subscribe fails, close so the client falls back to polling.
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      sub.on("message", (_chan, message) => send("alert", message));

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 25_000);

      const close = () => {
        clearInterval(heartbeat);
        sub.disconnect();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      sub.disconnect();
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
