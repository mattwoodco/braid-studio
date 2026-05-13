/**
 * GET    /api/projects/[storeId]/dreams/[dreamId] — fetch dream status + outputs
 * DELETE /api/projects/[storeId]/dreams/[dreamId] — cancel a running dream
 */
import { cancelDream, getDream } from "@/lib/anthropic";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ storeId: string; dreamId: string }> },
): Promise<Response> {
  const { dreamId } = await ctx.params;
  try {
    const dream = await getDream(dreamId);
    return NextResponse.json({ dream });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: "dream_get_failed", message }, { status });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ storeId: string; dreamId: string }> },
): Promise<Response> {
  const { dreamId } = await ctx.params;
  try {
    const dream = await cancelDream(dreamId);
    return NextResponse.json({ dream });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json({ error: "dream_cancel_failed", message }, { status });
  }
}
