/**
 * GET /api/projects/[storeId]/studio/[sessionId]/events
 * SSE proxy of the agent's session event stream. Closes on session.status_idle
 * with stop_reason=end_turn.
 */
import { streamSession } from "@/lib/anthropic";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ storeId: string; sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await ctx.params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // controller already closed
        }
      }, 25_000);

      const safeClose = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      try {
        for await (const event of streamSession(sessionId)) {
          if (closed) break;
          const payload = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
          if (event.type === "session.status_idle" && event.stopReason === "end_turn") {
            safeClose();
            return;
          }
        }
      } catch (err) {
        if (!closed) {
          const msg = err instanceof Error ? err.message : String(err);
          const payload = `event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`;
          try {
            controller.enqueue(encoder.encode(payload));
          } catch {
            // ignore
          }
        }
      } finally {
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
