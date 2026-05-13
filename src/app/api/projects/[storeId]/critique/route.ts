import { createSession, sendEvent } from "@/lib/anthropic";
import { CRITIQUE_ASPECTS } from "@/lib/critique";
import { listDrafts, readDraft, readHead } from "@/lib/drafts";
import { getEnv } from "@/lib/env";
import { getTasteStoreId } from "@/lib/taste";
import { VIDEO_RUBRIC_TEMPLATE, buildCoordinatorPrompt } from "@/lib/video-rubric";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  draftVersion: z.string().min(1).optional(),
  brief: z.string().min(1).max(2000).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const env = getEnv();
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
    // empty body OK; defaults to HEAD
  }

  let version = body.draftVersion;
  if (!version) {
    const head = await readHead(storeId);
    if (head) {
      version = head.version;
    } else {
      const list = await listDrafts(storeId);
      const last = list[list.length - 1];
      if (last) version = last.version;
    }
  }
  if (!version) {
    return NextResponse.json({ error: "no_draft" }, { status: 404 });
  }

  const draft = await readDraft(storeId, version);
  if (!draft) {
    return NextResponse.json({ error: "draft_not_found" }, { status: 404 });
  }

  const tasteStoreId = getTasteStoreId();
  const resources: Array<{
    type: "memory_store";
    memory_store_id: string;
    access: "read_only" | "read_write";
  }> = [
    {
      type: "memory_store",
      memory_store_id: storeId,
      access: "read_write",
    },
  ];
  if (tasteStoreId) {
    resources.push({
      type: "memory_store",
      memory_store_id: tasteStoreId,
      access: "read_only",
    });
  }

  try {
    const { sessionId } = await createSession({
      agentId: env.AGENT_ID,
      environmentId: env.ENV_ID,
      vaultIds: [env.VAULT_ID],
      title: `Critique ${draft.version}`,
      resources,
      multiagent: {
        type: "coordinator",
        agents: CRITIQUE_ASPECTS.map(() => ({
          id: env.AGENT_ID,
          type: "self" as const,
        })),
      },
    });

    await sendEvent(sessionId, {
      type: "user.define_outcome",
      rubric: VIDEO_RUBRIC_TEMPLATE,
      maxIterations: 3,
    });

    await sendEvent(sessionId, {
      type: "user.message",
      content: buildCoordinatorPrompt({
        brief: body.brief ?? "(no brief supplied)",
        draft,
      }),
    });

    return NextResponse.json({ sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "critique_failed", message }, { status: 500 });
  }
}
