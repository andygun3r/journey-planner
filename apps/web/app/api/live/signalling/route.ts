import { subscribeToDiagram } from "@/lib/signalling-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Corridor signalling as Server-Sent Events.
 *
 * Replaces an 8-second poll of `/api/signalling` that returned the whole
 * diagram every time — including the berth layout, which comes from static
 * SMART reference data and never changes mid-view. That was hundreds of nodes
 * re-sent 7.5 times a minute to draw the same picture.
 *
 * Events:
 *   ready     the stream is open — the client stands its poll down
 *   layout    the corridor's shape. Sent on connect, and again only if the
 *             train moves into a different TD area
 *   state     aspects and train positions, on every change
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const trainId = url.searchParams.get("trainId") ?? undefined;
  const rid = url.searchParams.get("rid") ?? undefined;
  const area = url.searchParams.get("area") ?? undefined;
  const crs = url.searchParams.get("crs") ?? undefined;

  if (!trainId && !rid && !area && !crs) {
    return new Response("trainId, rid, area or crs required", { status: 400 });
  }

  if (!process.env.REDIS_URL) {
    // Without Redis there is no trigger, so the stream would only ever carry
    // the slow safety-net tick. Polling is the better answer; say so.
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

      const unsubscribe = subscribeToDiagram(
        { trainId, rid, area, crs },
        (layout, areas) => send("layout", { layout, areas }),
        (state) => send("state", state),
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
