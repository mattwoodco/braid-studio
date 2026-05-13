import { aggregate, listCritiques, summarize } from "@/lib/critique";
import {
  type DraftEnvelope,
  listDrafts,
  nextVersion,
  readDraft,
  readHead,
  writeDraft,
  writeHead,
} from "@/lib/drafts";
import { getVideoBackend } from "@/lib/video-backend";
import { basename } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  draftVersion: z.string().min(1).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ storeId: string; sessionId: string }> },
): Promise<Response> {
  const { storeId } = await ctx.params;

  let body: z.infer<typeof BodySchema> = {};
  try {
    const text = await req.text();
    if (text.trim().length > 0) {
      const parsed = BodySchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        return NextResponse.json({ error: "invalid_body" }, { status: 400 });
      }
      body = parsed.data;
    }
  } catch {
    // empty body OK
  }

  let parentVersion = body.draftVersion;
  if (!parentVersion) {
    const head = await readHead(storeId);
    if (head) parentVersion = head.version;
  }
  if (!parentVersion) {
    return NextResponse.json({ error: "no_draft" }, { status: 404 });
  }

  const parent = await readDraft(storeId, parentVersion);
  if (!parent) {
    return NextResponse.json({ error: "draft_not_found" }, { status: 404 });
  }

  const critiques = await listCritiques(storeId, parentVersion);
  if (critiques.length === 0) {
    return NextResponse.json({ error: "no_critiques" }, { status: 404 });
  }

  const agg = aggregate(critiques);
  const reason = summarize(critiques);

  // Build per-shot prompts: locked shots keep parent prompt; regen shots get
  // parent.prompt + suggestion.
  const prompts: string[] = parent.shots.map((s) => s.prompt);
  const lockedUrls: Record<number, string> = {};
  const lockedSet = new Set(agg.locked);
  for (const n of agg.locked) {
    const shot = parent.shots.find((s) => s.n === n);
    if (shot?.video_url) lockedUrls[n] = shot.video_url;
  }
  for (const r of agg.regen) {
    const parentShot = parent.shots.find((s) => s.n === r.n);
    const basePrompt = parentShot?.prompt ?? "";
    prompts[r.n] = `${basePrompt} | ${r.suggestion}`;
  }

  const start = Date.now();
  const existing = await listDrafts(storeId);
  const childVersion = nextVersion(existing.map((d) => d.version));
  const outputBasename = `draft-${storeId}-${childVersion}-${start}`;

  let result;
  try {
    result = await getVideoBackend().generateAndCompose({
      prompts,
      lockedUrls,
      storeId,
      outputBasename,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "compose_failed", message }, { status: 500 });
  }

  const childShots = prompts.map((p, i) => ({
    n: i,
    prompt: p,
    video_url: result.shotUrls[i] ?? null,
  }));

  const child: DraftEnvelope = {
    version: childVersion,
    parent: parentVersion,
    reason,
    locked_shots: agg.locked,
    shots: childShots,
    mp4_filename: basename(result.mp4LocalPath),
    duration_seconds: result.durationSeconds,
    file_bytes: result.fileBytes,
    wall_ms: Date.now() - start,
    model_used: result.modelUsed,
    updated_at: new Date().toISOString(),
  };
  void lockedSet;

  await writeDraft(storeId, child);
  await writeHead(storeId, { version: child.version, updated_at: child.updated_at });

  return NextResponse.json(child);
}
