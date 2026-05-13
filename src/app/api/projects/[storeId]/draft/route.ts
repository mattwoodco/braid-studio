/**
 * POST /api/projects/[storeId]/draft  — versioned-envelope mode router.
 *
 * Modes (zod discriminated union on `mode`):
 *   - "create" (default): plan → generateAndCompose → writeDraft(vN+1) → writeHead.
 *   - "sweep": for each value, run a create-like flow IN PARALLEL.
 *       All share one sweep_run_id; HEAD does NOT advance.
 *   - "constrain": readDraft(parent), reuse parent.shots[i].video_url for each
 *       locked index, generate only the open ones; writeDraft + writeHead.
 *
 * Test seams (do not use in production code paths):
 *   - setShotPlanner(fn | null) — replace the Claude-driven shot planner.
 *   - drafts storage seam via setDraftsStorage.
 *   - video backend seam via setVideoBackend / getVideoBackend.
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
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

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_SHOTS = 3;
const PLANNER_MODEL = "claude-sonnet-4-5";

// ---------- Body schema (discriminated union on `mode`) ----------

const CreateBody = z.object({
  mode: z.literal("create").optional(),
  brief: z.string().min(4).max(2000).optional(),
  shots: z.number().int().min(1).max(5).optional(),
});

const SweepBody = z.object({
  mode: z.literal("sweep"),
  brief: z.string().min(4).max(2000).optional(),
  shots: z.number().int().min(1).max(5).optional(),
  sweep: z.object({
    axis: z.union([
      z.literal("model"),
      z.literal("style"),
      z.literal("temperature"),
    ]),
    values: z.array(z.string().min(1)).min(1).max(8),
  }),
});

const ConstrainBody = z.object({
  mode: z.literal("constrain"),
  parent: z.string().min(1),
  locked_shots: z.array(z.number().int().min(0)).min(0),
  brief: z.string().min(4).max(2000).optional(),
});

const BodySchema = z.union([CreateBody, SweepBody, ConstrainBody]);

// ---------- Shot planner (with test seam) ----------

export type ShotPlanner = (brief: string, n: number) => Promise<string[]>;

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
  shots: z
    .array(z.object({ video_prompt: z.string().min(4).max(800) }))
    .min(1)
    .max(5),
});

const defaultPlanner: ShotPlanner = async (brief, n) => {
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
};

let _planner: ShotPlanner = defaultPlanner;

export function setShotPlanner(fn: ShotPlanner | null): void {
  _planner = fn ?? defaultPlanner;
}

// ---------- Helpers ----------

function tsStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function envelopeShots(
  prompts: string[],
  shotUrls: (string | null)[],
): DraftEnvelope["shots"] {
  const out: DraftEnvelope["shots"] = [];
  for (let i = 0; i < prompts.length; i++) {
    out.push({
      n: i,
      prompt: prompts[i] ?? "",
      video_url: shotUrls[i] ?? null,
    });
  }
  return out;
}

async function runComposition(
  storeId: string,
  prompts: string[],
  lockedUrls: Record<number, string> | undefined,
  outputBasename: string,
): Promise<{
  shotUrls: (string | null)[];
  mp4LocalPath: string;
  durationSeconds: number;
  fileBytes: number;
  modelUsed: string | null;
  wallMs: number;
}> {
  const t0 = Date.now();
  const backend = getVideoBackend();
  const input: Parameters<typeof backend.generateAndCompose>[0] = {
    prompts,
    storeId,
    outputBasename,
  };
  if (lockedUrls !== undefined) input.lockedUrls = lockedUrls;
  const result = await backend.generateAndCompose(input);
  return {
    shotUrls: result.shotUrls,
    mp4LocalPath: result.mp4LocalPath,
    durationSeconds: result.durationSeconds,
    fileBytes: result.fileBytes,
    modelUsed: result.modelUsed,
    wallMs: Date.now() - t0,
  };
}

// ---------- POST handler ----------

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
    return NextResponse.json(
      { error: "invalid_body", message: parsed.error.message },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const mode: "create" | "sweep" | "constrain" =
    "mode" in body && body.mode !== undefined ? body.mode : "create";

  try {
    if (mode === "create") {
      return await handleCreate(storeId, body as z.infer<typeof CreateBody>);
    }
    if (mode === "sweep") {
      return await handleSweep(storeId, body as z.infer<typeof SweepBody>);
    }
    return await handleConstrain(storeId, body as z.infer<typeof ConstrainBody>);
  } catch (err) {
    return NextResponse.json(
      {
        error: "draft_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

// ---------- Mode: create ----------

async function handleCreate(
  storeId: string,
  body: z.infer<typeof CreateBody>,
): Promise<Response> {
  const n = body.shots ?? DEFAULT_SHOTS;
  const brief = body.brief ?? "";
  const prompts = await _planner(brief, n);

  const existing = await listDrafts(storeId);
  const headBefore = await readHead(storeId);
  const version = nextVersion(existing.map((d) => d.version));
  const outputBasename = `draft-${storeId}-${version}-${tsStamp()}`;

  const comp = await runComposition(storeId, prompts, undefined, outputBasename);

  const envelope: DraftEnvelope = {
    version,
    parent: headBefore?.version ?? null,
    reason: "create",
    locked_shots: [],
    shots: envelopeShots(prompts, comp.shotUrls),
    mp4_filename: basename(comp.mp4LocalPath),
    duration_seconds: comp.durationSeconds,
    file_bytes: comp.fileBytes,
    wall_ms: comp.wallMs,
    model_used: comp.modelUsed,
    updated_at: new Date().toISOString(),
  };
  await writeDraft(storeId, envelope);
  const head = { version, updated_at: new Date().toISOString() };
  await writeHead(storeId, head);

  return NextResponse.json({
    version,
    mp4LocalPath: comp.mp4LocalPath,
    head,
    envelope,
  });
}

// ---------- Mode: sweep ----------

async function handleSweep(
  storeId: string,
  body: z.infer<typeof SweepBody>,
): Promise<Response> {
  const n = body.shots ?? DEFAULT_SHOTS;
  const brief = body.brief ?? "";
  const headBefore = await readHead(storeId);
  const parent = headBefore?.version ?? null;

  // Claim monotonic versions sequentially up-front so all variants are unique.
  const existing = await listDrafts(storeId);
  const claimed: string[] = [];
  const known = existing.map((d) => d.version);
  for (let i = 0; i < body.sweep.values.length; i++) {
    const v = nextVersion([...known, ...claimed]);
    claimed.push(v);
  }

  const sweepRunId = randomUUID();

  // Plan shots per-variant in parallel (axis may influence brief in future;
  // for now each variant gets its own plan from the same brief).
  const prompts = await _planner(brief, n);

  // Run all variant compositions in parallel.
  const variantTasks = body.sweep.values.map(async (value, idx) => {
    const version = claimed[idx];
    if (version === undefined) throw new Error("sweep: missing claimed version");
    const outputBasename = `sweep-${storeId}-${sweepRunId}-${version}-${tsStamp()}`;
    const comp = await runComposition(storeId, prompts, undefined, outputBasename);
    const envelope: DraftEnvelope = {
      version,
      parent,
      reason: `sweep:axis=${body.sweep.axis},value=${value}`,
      sweep_run_id: sweepRunId,
      locked_shots: [],
      shots: envelopeShots(prompts, comp.shotUrls),
      mp4_filename: basename(comp.mp4LocalPath),
      duration_seconds: comp.durationSeconds,
      file_bytes: comp.fileBytes,
      wall_ms: comp.wallMs,
      model_used: comp.modelUsed,
      updated_at: new Date().toISOString(),
    };
    return envelope;
  });

  const envelopes = await Promise.all(variantTasks);
  // Persist sequentially to avoid duplicate-list races inside writeDraft.
  for (const env of envelopes) {
    await writeDraft(storeId, env);
  }

  // HEAD intentionally NOT advanced.
  return NextResponse.json({
    sweep_run_id: sweepRunId,
    variants: envelopes,
  });
}

// ---------- Mode: constrain ----------

async function handleConstrain(
  storeId: string,
  body: z.infer<typeof ConstrainBody>,
): Promise<Response> {
  const parentEnv = await readDraft(storeId, body.parent);
  if (!parentEnv) {
    return NextResponse.json(
      { error: "unknown_parent", message: `parent not found: ${body.parent}` },
      { status: 400 },
    );
  }
  const M = parentEnv.shots.length;
  const lockedSorted = [...body.locked_shots].sort((a, b) => a - b);
  for (const i of lockedSorted) {
    if (i < 0 || i >= M) {
      return NextResponse.json(
        { error: "locked_out_of_range", message: `index ${i} not in [0..${M - 1}]` },
        { status: 400 },
      );
    }
  }

  // Reconstruct prompt list from parent so locked indices carry forward prompts.
  const prompts = parentEnv.shots.map((s) => s.prompt);
  const lockedUrls: Record<number, string> = {};
  for (const i of lockedSorted) {
    const url = parentEnv.shots[i]?.video_url;
    if (!url) {
      return NextResponse.json(
        {
          error: "locked_missing_url",
          message: `parent shot ${i} has no video_url to lock`,
        },
        { status: 400 },
      );
    }
    lockedUrls[i] = url;
  }

  const existing = await listDrafts(storeId);
  const version = nextVersion(existing.map((d) => d.version));
  const outputBasename = `constrain-${storeId}-${version}-${tsStamp()}`;
  const comp = await runComposition(storeId, prompts, lockedUrls, outputBasename);

  const envelope: DraftEnvelope = {
    version,
    parent: body.parent,
    reason: `constrain:locked=[${lockedSorted.join(",")}]`,
    locked_shots: lockedSorted,
    shots: envelopeShots(prompts, comp.shotUrls),
    mp4_filename: basename(comp.mp4LocalPath),
    duration_seconds: comp.durationSeconds,
    file_bytes: comp.fileBytes,
    wall_ms: comp.wallMs,
    model_used: comp.modelUsed,
    updated_at: new Date().toISOString(),
  };
  await writeDraft(storeId, envelope);
  const head = { version, updated_at: new Date().toISOString() };
  await writeHead(storeId, head);

  return NextResponse.json({
    version,
    mp4LocalPath: comp.mp4LocalPath,
    head,
    envelope,
  });
}
