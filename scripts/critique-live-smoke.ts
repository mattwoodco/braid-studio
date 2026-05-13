/**
 * Live Managed-Agent critique smoke: minimal scope.
 *
 *   - Creates a memory store.
 *   - Writes a stub v1 draft (no FAL).
 *   - Spawns a multiagent.coordinator with 2 sub-agents (cinematography, pacing).
 *   - Streams the session until idle.
 *   - Polls listCritiques(store, "v1"); asserts at least one envelope parses.
 *
 * The goal is to validate that a real Managed-Agent panel can produce
 * envelopes our Zod schema accepts. Stub URLs are fine — the critic scores
 * shot prompts against the rubric, not pixels.
 */
import {
  type IncomingSessionEvent,
  type SessionResource,
  createSession,
  listMemories,
  sendEvent,
  streamSession,
  createMemoryStore,
  updateMemoryStoreMetadata,
} from "@/lib/anthropic";
import {
  type CritiqueAspect,
  listCritiques,
  writeCritique,
} from "@/lib/critique";
import { type DraftEnvelope, writeDraft, writeHead } from "@/lib/drafts";
import { getEnv } from "@/lib/env";

const ASPECTS: CritiqueAspect[] = ["cinematography", "pacing"];

const STUB_V1: Omit<DraftEnvelope, "version" | "updated_at"> = {
  parent: null,
  reason: "create",
  locked_shots: [],
  shots: [
    {
      n: 0,
      prompt: "wide cinematic shot of a city street at dawn, slow dolly forward",
      video_url: "https://stub.example/v1/0.mp4",
    },
    {
      n: 1,
      prompt: "medium shot of a person walking in soft morning light",
      video_url: "https://stub.example/v1/1.mp4",
    },
    {
      n: 2,
      prompt: "close-up of hands holding a coffee cup, steam rising",
      video_url: "https://stub.example/v1/2.mp4",
    },
  ],
  mp4_filename: "stub-v1.mp4",
  duration_seconds: 6,
  file_bytes: 0,
  wall_ms: 0,
  model_used: "stub",
};

function buildRubric(aspect: CritiqueAspect): string {
  return [
    `You are a film critic specialising in the "${aspect}" of short ad videos.`,
    `Score each of the 3 shots from 0.0 to 1.0 on ${aspect} quality. Anything < 0.7 should regenerate.`,
    "",
    "OUTPUT PROTOCOL — read carefully.",
    "Before doing anything else, run a Bash command: `ls /mnt/memory/` to discover the store directory. Call that result STORE_DIR.",
    "",
    `Then write EXACTLY ONE FILE at: /mnt/memory/$STORE_DIR/memory/critiques/v1/${aspect}.json`,
    "",
    "The file MUST be valid JSON matching this exact shape (no extra fields, no markdown, no commentary):",
    "",
    "{",
    `  "version": "c-${aspect}-v1",`,
    '  "parent_draft": "v1",',
    `  "aspect": "${aspect}",`,
    '  "shot_scores": [',
    '    { "n": 0, "score": 0.85, "issues": [], "suggestion": "" },',
    '    { "n": 1, "score": 0.55, "issues": ["soft lighting", "weak motion"], "suggestion": "harden contrast, add subject motion" },',
    '    { "n": 2, "score": 0.7, "issues": [], "suggestion": "" }',
    "  ],",
    '  "overall": 0.7,',
    `  "summary": "one-sentence ${aspect} summary",`,
    '  "created_at": "<ISO-8601 timestamp>"',
    "}",
    "",
    "Rules:",
    "  - shot_scores MUST have exactly one entry per shot, in order n=0,1,2",
    "  - `issues` is always an array of strings (possibly empty)",
    "  - `suggestion` is always a string (possibly empty)",
    "  - `score` and `overall` are numbers in [0,1]",
    "  - DO NOT write any other files; DO NOT use code blocks; the file content must start with `{` and end with `}`",
    "  - When the file is written, emit one agent.message that says `DONE ${aspect}` and end the turn",
  ].join("\n");
}

function log(...args: unknown[]): void {
  console.log("[live]", ...args);
}

async function streamUntilIdle(
  sessionId: string,
  timeoutMs: number,
): Promise<IncomingSessionEvent[]> {
  const collected: IncomingSessionEvent[] = [];
  const start = Date.now();
  for await (const ev of streamSession(sessionId)) {
    collected.push(ev);
    if (ev.type === "agent.message") {
      log(`msg [${sessionId.slice(0, 12)}]:`, ev.text.slice(0, 200));
    } else if (ev.type === "agent.tool_use") {
      log(`tool_use [${sessionId.slice(0, 12)}]:`, ev.toolName, JSON.stringify(ev.input).slice(0, 200));
    } else if (ev.type === "agent.tool_result") {
      log(
        `tool_result [${sessionId.slice(0, 12)}]:`,
        ev.isError ? "ERR" : "ok",
        ev.content.slice(0, 200),
      );
    } else if (ev.type === "session.status_idle") {
      log(`idle [${sessionId.slice(0, 12)}] stop=${ev.stopReason}`);
      if (ev.stopReason === "end_turn") break;
    } else if (ev.type === "other") {
      log(`other [${sessionId.slice(0, 12)}]:`, ev.rawType);
    }
    if (Date.now() - start > timeoutMs) {
      log("timeout, breaking");
      break;
    }
  }
  return collected;
}

async function main(): Promise<void> {
  const env = getEnv();

  log("creating store");
  const store = await createMemoryStore({
    name: `live-critique-${new Date().toISOString().slice(0, 19)}`,
    description: "Live Managed-Agent critique smoke",
  });
  await updateMemoryStoreMetadata(store.id, {
    braid_studio: "v1",
    project_name: "live-critique",
  });
  log("store:", store.id);

  // Write stub v1
  const v1: DraftEnvelope = {
    ...STUB_V1,
    version: "v1",
    updated_at: new Date().toISOString(),
  };
  await writeDraft(store.id, v1);
  await writeHead(store.id, { version: "v1", updated_at: v1.updated_at });
  log("stub v1 written");

  // Resource with mount-discovery instructions (matches the studio pattern).
  const resources: SessionResource[] = [
    {
      type: "memory_store",
      memory_store_id: store.id,
      access: "read_write",
      instructions: [
        "MEMORY STORE MOUNT — READ CAREFULLY.",
        "The memory store you must write to is mounted at `/mnt/memory/<store-dir>/`.",
        "STEP 0: run `bash` with `ls /mnt/memory/`. The result is STORE_DIR.",
        "When the rubric says `/memory/critiques/v1/<aspect>.json`, you must write to:",
        "  `/mnt/memory/$STORE_DIR/memory/critiques/v1/<aspect>.json`",
        "If `ls /mnt/memory/` shows multiple directories, pick the most-recently-modified one.",
      ].join("\n"),
    },
  ];

  // Spawn one session per aspect (parallel) — simpler than multiagent and
  // each agent has a focused rubric.
  const sessionIds: { aspect: CritiqueAspect; sessionId: string }[] = [];
  for (const aspect of ASPECTS) {
    log(`creating session: ${aspect}`);
    const { sessionId } = await createSession({
      agentId: env.AGENT_ID,
      environmentId: env.ENV_ID,
      vaultIds: [env.VAULT_ID],
      title: `Critique v1 — ${aspect}`,
      resources,
    });
    sessionIds.push({ aspect, sessionId });
    await sendEvent(sessionId, {
      type: "user.define_outcome",
      rubric: buildRubric(aspect),
      maxIterations: 1,
    });
    await sendEvent(sessionId, {
      type: "user.message",
      content: `Critique v1 for ${aspect}. Shot prompts:\n${v1.shots
        .map((s) => `  [${s.n}] ${s.prompt}`)
        .join("\n")}`,
    });
  }

  // Stream all sessions concurrently.
  log("streaming sessions...");
  await Promise.all(
    sessionIds.map(({ sessionId }) => streamUntilIdle(sessionId, 8 * 60 * 1000)),
  );

  // Inspect the memory store directly to see what was written.
  log("listing memory store contents...");
  const memories = await listMemories(store.id, { prefix: "/memory/critiques/" });
  console.log("\n=== RAW MEMORY ENTRIES UNDER /memory/critiques/ ===");
  for (const m of memories) {
    console.log(`  ${m.path}  (${m.content.length} bytes)`);
    console.log("    head:", m.content.slice(0, 120).replace(/\s+/g, " "));
  }

  // Try parsing through our schema.
  const parsed = await listCritiques(store.id, "v1");
  console.log("\n=== PARSED via listCritiques ===");
  console.log("count:", parsed.length);
  for (const env of parsed) {
    console.log(
      `  aspect=${env.aspect} overall=${env.overall.toFixed(2)} shots=${env.shot_scores.length}`,
    );
    for (const s of env.shot_scores) {
      console.log(`    shot ${s.n}: score=${s.score} issues=${s.issues.length}`);
    }
  }

  const ok = parsed.length >= 1 &&
    parsed.every((e) => e.shot_scores.length === 3);
  console.log(ok ? "\nLIVE CRITIQUE PARSEABLE ✓" : "\nLIVE CRITIQUE FAILED ✗");
  if (!ok) {
    // Surface unparsed entries so we can iterate the prompt.
    console.log("\nstore:", store.id);
    for (const m of memories) {
      console.log(`---- ${m.path} ----`);
      console.log(m.content);
    }
    process.exit(1);
  }
  console.log("store:", store.id);
}

main().catch((err) => {
  console.error("[live] failed:", err);
  process.exit(1);
});
