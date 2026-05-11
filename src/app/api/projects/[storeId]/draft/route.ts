/**
 * POST /api/projects/[storeId]/draft  — fast text-to-video lane.
 *
 * Plan N shots in one Claude call (forced tool_use). Parallel fal t2v.
 * Local ffmpeg compose. Returns the local mp4 path + wall time.
 */
import { mkdir, copyFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { submitTextToVideo } from "@/lib/fal";
import { composeClips, ffprobeDuration } from "@/lib/ffmpeg";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BodySchema = z.object({
  brief: z.string().min(4).max(2000),
  shots: z.number().int().min(1).max(5).optional(),
});

const DEFAULT_SHOTS = 3;
const PLANNER_MODEL = "claude-sonnet-4-5";

const SHOT_LIST_TOOL = {
  name: "submit_shot_list",
  description:
    "Submit a shot plan for a short cinematic ad. Each shot's video_prompt is a self-contained description for a text-to-video model: setting, subject, camera motion, lighting, action.",
  input_schema: {
    type: "object" as const,
    properties: {
      shots: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            video_prompt: { type: "string", minLength: 4, maxLength: 800 },
          },
          required: ["video_prompt"],
        },
      },
    },
    required: ["shots"],
  },
};

const ShotPlanSchema = z.object({
  shots: z.array(z.object({ video_prompt: z.string().min(4).max(800) })).min(1).max(5),
});

async function planShots(brief: string, n: number): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const system = `Plan ${n} short video shots for a TV ad from this brief. Each prompt should be a vivid description of motion + setting + lighting. Shot 1 = hook, middle = value beats, last = brand resolution.`;
  interface CreateArgs {
    model: string;
    max_tokens: number;
    system: string;
    tools: (typeof SHOT_LIST_TOOL)[];
    tool_choice: { type: "tool"; name: string };
    messages: Array<{ role: "user"; content: string }>;
  }
  interface CreateRes {
    content: Array<{ type: string; name?: string; input?: unknown }>;
  }
  const args: CreateArgs = {
    model: PLANNER_MODEL,
    max_tokens: 1024,
    system,
    tools: [SHOT_LIST_TOOL],
    tool_choice: { type: "tool", name: SHOT_LIST_TOOL.name },
    messages: [
      { role: "user", content: `Brief: ${brief}\n\nProduce exactly ${n} shots.` },
    ],
  };
  const res = (await client.messages.create(
    args as unknown as Parameters<typeof client.messages.create>[0],
  )) as unknown as CreateRes;
  const block = res.content.find(
    (c) => c.type === "tool_use" && c.name === SHOT_LIST_TOOL.name,
  );
  if (!block) throw new Error("planShots: no submit_shot_list tool_use returned");
  const parsed = ShotPlanSchema.safeParse(block.input);
  if (!parsed.success) {
    throw new Error(`planShots: invalid tool_use input: ${parsed.error.message}`);
  }
  return parsed.data.shots.slice(0, n).map((s) => s.video_prompt);
}

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
  const t0 = Date.now();
  const n = parsed.data.shots ?? DEFAULT_SHOTS;

  try {
    const prompts = await planShots(parsed.data.brief, n);
    const results = await Promise.all(
      prompts.map((p) => submitTextToVideo({ prompt: p })),
    );
    const clipUrls = results.map((r) => r.videoUrl);

    const runId = randomUUID();
    const outDir = `/tmp/braid-studio-${runId}`;
    await mkdir(outDir, { recursive: true });
    const outPath = `${outDir}/final.mp4`;
    await composeClips({ clipUrls, outPath });
    const duration = await ffprobeDuration(outPath);

    // Save a copy under <repo>/data/finals/
    const finalsDir = resolvePath(process.cwd(), "data/finals");
    await mkdir(finalsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const localCopy = resolvePath(finalsDir, `draft-${ts}.mp4`);
    await copyFile(outPath, localCopy);
    const st = await stat(localCopy);

    return NextResponse.json({
      storeId,
      mp4LocalPath: localCopy,
      mp4Url: null,
      shotUrls: clipUrls,
      durationSeconds: duration,
      fileBytes: st.size,
      wallMs: Date.now() - t0,
      modelUsed: results[0]?.modelUsed ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "draft_failed",
        message: err instanceof Error ? err.message : String(err),
        wallMs: Date.now() - t0,
      },
      { status: 500 },
    );
  }
}
