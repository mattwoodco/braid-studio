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
  console.log(
    "[studio/followup] POST",
    { sessionId, contentLen: parsed.data.content.length },
  );
  try {
    await sendEvent(sessionId, { type: "user.message", content: parsed.data.content });
    console.log("[studio/followup] sendEvent ok", sessionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/followup] sendEvent failed", { sessionId, message });
    return NextResponse.json({ error: "send_failed", message }, { status: 500 });
  }
}
