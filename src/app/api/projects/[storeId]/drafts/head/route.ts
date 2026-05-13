/**
 * POST/GET /api/projects/[storeId]/drafts/head
 *
 * Promote an existing draft envelope to HEAD, or read the current HEAD pointer.
 * Per docs/SPEC.md Unit 5: idempotent, 404 on unknown version.
 */
import { readDraft, readHead, writeHead } from "@/lib/drafts";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  version: z.string().min(1),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await ctx.params;
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
  const { version } = parsed.data;

  const draft = await readDraft(storeId, version);
  if (!draft) {
    return NextResponse.json({ error: "version not found" }, { status: 404 });
  }

  const existing = await readHead(storeId);
  if (existing && existing.version === version) {
    return NextResponse.json({ head: existing }, { status: 200 });
  }

  const head = { version, updated_at: new Date().toISOString() };
  await writeHead(storeId, head);
  return NextResponse.json({ head }, { status: 200 });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await ctx.params;
  const head = await readHead(storeId);
  return NextResponse.json({ head }, { status: 200 });
}
