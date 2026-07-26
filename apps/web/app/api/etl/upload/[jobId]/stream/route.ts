import { getJob } from "@/lib/etl-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** SSE stream of progress lines for a bundle-apply job started by /api/etl/upload. */
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return new Response("event: error\ndata: job not found\n\n", {
      status: 404,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: string) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          /* stream already closed */
        }
      };

      // Replay anything that happened before the client connected.
      for (const line of job.lines) send("line", JSON.stringify(line));
      if (job.status !== "running") {
        send("status", job.status);
        controller.close();
        return;
      }

      const onLine = (line: string) => send("line", JSON.stringify(line));
      const onStatus = (status: string) => {
        send("status", status);
        job.emitter.off("line", onLine);
        job.emitter.off("status", onStatus);
        controller.close();
      };
      job.emitter.on("line", onLine);
      job.emitter.on("status", onStatus);
      req.signal.addEventListener("abort", () => {
        job.emitter.off("line", onLine);
        job.emitter.off("status", onStatus);
      });
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
