import { subscribeToService } from "@/lib/service-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One train's live position, as Server-Sent Events.
 *
 * The service page ran three uncoordinated timers for a single train: a 30s
 * page refresh, a 25s position poll and an 8s signalling poll. This is the one
 * stream they collapse into — the client shares a single connection between the
 * map and the page refresher (see components/service-live.ts).
 *
 * Events:
 *   ready     the stream is open — the client stands its poll down
 *   position  the train's current position, or null when it is not correlated
 *
 * Deliberately no route geometry. The calling pattern and the track-following
 * line are fetched once by the client; re-sending them every update was the
 * expensive part of the poll this replaces, and they do not change while the
 * train runs.
 */
export async function GET(req: Request) {
  const rid = new URL(req.url).searchParams.get("rid");
  if (!rid) return new Response("rid required", { status: 400 });

  if (!process.env.REDIS_URL) {
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

      send("ready", {});
      const unsubscribe = subscribeToService(rid, (position) => send("position", position));

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
      "X-Accel-Buffering": "no",
    },
  });
}
