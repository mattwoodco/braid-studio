import { createSession, sendEvent } from "@/lib/anthropic";
import { getEnv } from "@/lib/env";
/**
 * POST /api/projects/[storeId]/studio  — create an agent session and seed it.
 *
 * Returns { sessionId } in < 2s. The client opens an SSE stream at /events.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  brief: z.string().min(4).max(4000),
});

const RUBRIC = [
  "Success = a structured manifest written to the mounted memory store. Backend composes the mp4 from the manifest — your job is NOT compose.",
  "Required files when you end the turn:",
  "  /memory/shots/<N>.json  for each shot, with { n, prompt, video_url, updated_at }",
  "  /memory/final.json      with { shot_urls: [<3 URLs in order>], duration_seconds_per_clip, crossfade_ms, updated_at }",
  "Each video_url MUST be a public fal-storage URL returned by `fal` MCP submit_job + check_job against fal-ai/ltx-2.3/text-to-video/fast.",
  "You MUST NOT run ffmpeg. You MUST NOT upload files. You MUST NOT validate or inspect any composed mp4. The backend owns composition; it cannot proceed without your manifest.",
  "End the turn as soon as the manifest is written, with one short agent.message: 'DONE — manifest written for N shots.'",
].join("\n");

export async function POST(
  req: Request,
  ctx: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const env = getEnv();
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
  try {
    const { sessionId } = await createSession({
      agentId: env.AGENT_ID,
      environmentId: env.ENV_ID,
      vaultIds: [env.VAULT_ID],
      resources: [
        {
          type: "memory_store",
          memory_store_id: storeId,
          access: "read_write",
          instructions: [
            "MEMORY STORE MOUNT — READ CAREFULLY.",
            "The memory store you must write to is mounted at `/mnt/memory/<store-dir>/`.",
            "STEP 0 (do this BEFORE anything else): run `bash` with `ls /mnt/memory/`. That command returns the directory name. Treat the result as `STORE_DIR`. From now on, when the system prompt says `/memory/X`, you must read or write `/mnt/memory/$STORE_DIR/X` instead.",
            "Concretely, your four required writes are:",
            "  /mnt/memory/$STORE_DIR/shots/1.json",
            "  /mnt/memory/$STORE_DIR/shots/2.json",
            "  /mnt/memory/$STORE_DIR/shots/3.json",
            "  /mnt/memory/$STORE_DIR/final.json",
            "Files written ANYWHERE ELSE on the container filesystem will be lost — they will not appear in the memory store. The backend reads the memory store, not the container.",
            "If `ls /mnt/memory/` shows more than one directory, pick the most recently-modified one.",
          ].join("\n"),
        },
      ],
    });
    await sendEvent(sessionId, {
      type: "user.define_outcome",
      rubric: RUBRIC,
      maxIterations: 3,
    });
    await sendEvent(sessionId, {
      type: "user.message",
      content: parsed.data.brief,
    });
    return NextResponse.json({ sessionId });
  } catch (err) {
    return NextResponse.json(
      {
        error: "studio_create_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
