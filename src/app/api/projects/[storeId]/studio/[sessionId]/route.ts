import { sendEvent } from "@/lib/anthropic";
/**
 * POST /api/projects/[storeId]/studio/[sessionId]  — post a user.message
 * follow-up to an existing session.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  content: z.string().min(1).max(4000),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ storeId: string; sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await ctx.params;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    await sendEvent(sessionId, { type: "user.message", content: parsed.data.content });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      {
        error: "send_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
