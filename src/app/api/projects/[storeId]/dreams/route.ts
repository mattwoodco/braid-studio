/**
 * POST /api/projects/[storeId]/dreams — kick off a memory-distillation
 *   "dream" for this project's memory store, optionally including past
 *   session_ids in the conditioning. The dream produces a NEW memory store
 *   that summarizes brand voice + recurring patterns across sessions.
 *
 * GET  /api/projects/[storeId]/dreams — list all dreams that include this
 *   project's memory_store_id as an input. (The Anthropic list endpoint is
 *   account-wide; we filter client-side.)
 */
import { createDream, listDreams } from "@/lib/anthropic";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BodySchema = z.object({
  sessionIds: z.array(z.string().min(4)).max(100).optional(),
  model: z.enum(["claude-opus-4-7", "claude-sonnet-4-6"]).optional(),
  instructions: z.string().min(4).max(4096).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await ctx.params;
  let json: unknown;
  try {
    json = await req.json().catch(() => ({}));
  } catch {
    json = {};
  }
  const parsed = BodySchema.safeParse(json ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const input: Parameters<typeof createDream>[0] = { memoryStoreId: storeId };
    if (parsed.data.sessionIds) input.sessionIds = parsed.data.sessionIds;
    if (parsed.data.model) input.model = parsed.data.model;
    if (parsed.data.instructions) input.instructions = parsed.data.instructions;
    const dream = await createDream(input);
    return NextResponse.json({ dream });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: "dream_create_failed", message }, { status });
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await ctx.params;
  try {
    const all = await listDreams();
    const dreams = all.filter((d) =>
      d.inputs.some((i) => i.type === "memory_store" && i.memory_store_id === storeId),
    );
    return NextResponse.json({ dreams });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "dream_list_failed", message }, { status: 500 });
  }
}
