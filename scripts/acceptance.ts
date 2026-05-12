#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
/**
 * Live acceptance test for braid-studio.
 *
 * 1. Health: GET / on localhost:3000.
 * 2. Create project.
 * 3. Draft test: POST /draft, assert mp4 exists, duration > 14s, size > 50KB.
 * 4. Studio test: POST /studio, stream events, wait for end_turn, read
 *    /memory/final.json from the memory store, download mp4, ffprobe.
 * 5. Studio followup: POST /studio/<sessionId>, re-stream, assert
 *    /memory/shots/2.json updated_at is newer, /memory/final.json mp4_url differs.
 */
import { appendFile, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { listMemories } from "../src/lib/anthropic";
import { ffprobeDuration } from "../src/lib/ffmpeg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const BRIEF =
  "15-second ad for a coffee shop: sunrise light, espresso pouring, a couple at the window. Warm cinematic tones.";

const PERF_DIR = resolvePath(process.cwd(), "data", "perf");
const AGENT_YAML = resolvePath(process.cwd(), "infra", "agent.yaml");

type Lane = "draft" | "studio" | "studio-followup";

interface ToolUseRecord {
  eventId: string;
  toolName: string;
  prompt: string | null;
  negativePrompt: string | null;
  inputKeys: string[];
}

interface RunContext {
  lane: Lane;
  toolUses: ToolUseRecord[];
  finalJson: FinalJson | null;
  shotsByN: Map<number, ShotJson>;
  mp4DurationSec: number | null;
  mp4Bytes: number | null;
  error: string | null;
}

interface AssertionResult {
  status: "pass" | "fail" | "skipped";
  observed: string;
  expected: string;
  evidenceEventIds?: string[];
}

interface Assertion {
  id: string;
  lane: Lane | "all";
  description: string;
  evaluate: (ctx: RunContext) => AssertionResult;
}

interface LedgerLaneRow {
  kind: "lane";
  run_id: string;
  ts: string;
  lane: Lane;
  git_sha: string;
  agent_yaml_sha256: string;
  brief_sha256: string;
  model: string | null;
  wall_ms: number;
  tool_use_count: number;
  mcp_tool_use_count: number;
  shot_count: number | null;
  template: string | null;
  error: string | null;
}

interface LedgerAssertionRow {
  kind: "assertion";
  run_id: string;
  ts: string;
  lane: Lane;
  assertion_id: string;
  status: "pass" | "fail" | "skipped";
  observed: string;
  expected: string;
  evidence_event_ids?: string[];
  agent_yaml_sha256: string;
}

type LedgerRow = LedgerLaneRow | LedgerAssertionRow;

interface DraftRes {
  mp4LocalPath: string;
  shotUrls: string[];
  durationSeconds: number;
  fileBytes: number;
  wallMs: number;
  modelUsed: string | null;
  error?: string;
}

interface FinalJson {
  shot_urls?: string[];
  duration_seconds_per_clip?: number;
  crossfade_ms?: number;
  updated_at?: number | string;
}

interface FinalizeRes {
  mp4LocalPath: string;
  shotUrls: string[];
  durationSeconds: number;
  crossfadeMs: number;
  wallMs: number;
  error?: string;
}

interface ShotJson {
  prompt?: string;
  clip_url?: string;
  updated_at?: string;
}

async function waitForHealth(maxMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok || res.status === 200) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server not healthy at ${BASE} after ${maxMs}ms`);
}

async function createProject(): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `acceptance-${ts}` }),
  });
  if (!res.ok) throw new Error(`create project failed: ${res.status}`);
  const data = (await res.json()) as { storeId: string };
  return data.storeId;
}

async function runDraft(storeId: string): Promise<{ wallMs: number; mp4Path: string }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/projects/${storeId}/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief: BRIEF }),
  });
  const data = (await res.json()) as DraftRes;
  if (!res.ok || data.error) {
    throw new Error(`draft failed: ${data.error ?? res.status}`);
  }
  const dur = await ffprobeDuration(data.mp4LocalPath);
  const st = await stat(data.mp4LocalPath);
  if (st.size < 50 * 1024) {
    throw new Error(`draft mp4 too small: ${st.size} bytes`);
  }
  if (dur < 5) {
    throw new Error(`draft mp4 too short: ${dur}s`);
  }
  console.log(
    `  draft: wall=${((Date.now() - t0) / 1000).toFixed(1)}s, dur=${dur.toFixed(2)}s, size=${(st.size / 1024).toFixed(0)}KB`,
  );
  return { wallMs: Date.now() - t0, mp4Path: data.mp4LocalPath };
}

async function streamUntilIdle(
  storeId: string,
  sessionId: string,
  maxMs = 600_000,
): Promise<ToolUseRecord[]> {
  const url = `${BASE}/api/projects/${storeId}/studio/${sessionId}/events`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`SSE open failed: ${res.status}`);
  }
  const toolUses: ToolUseRecord[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + maxMs;
  let buf = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const dataPart = line.slice(5).trim();
        if (!dataPart) continue;
        try {
          const ev = JSON.parse(dataPart) as {
            type: string;
            eventId?: string;
            stopReason?: string;
            toolName?: string;
            text?: string;
            input?: Record<string, unknown>;
          };
          if (ev.type === "agent.message" && ev.text) {
            console.log(`    agent: ${ev.text.slice(0, 120)}`);
          } else if (ev.type === "agent.tool_use") {
            const input = ev.input ?? {};
            // fal MCP `run_model` / `submit_job` nest the model args under
            // `input.input`, e.g. { model: "fal-ai/...", input: { prompt, negative_prompt } }.
            // Read both shapes so the assertion is robust to either calling style.
            const nested =
              typeof input.input === "object" && input.input !== null
                ? (input.input as Record<string, unknown>)
                : {};
            const promptCandidate =
              typeof nested.prompt === "string"
                ? nested.prompt
                : typeof input.prompt === "string"
                  ? input.prompt
                  : null;
            const negPromptCandidate =
              typeof nested.negative_prompt === "string"
                ? nested.negative_prompt
                : typeof input.negative_prompt === "string"
                  ? input.negative_prompt
                  : null;
            toolUses.push({
              eventId: ev.eventId ?? "",
              toolName: ev.toolName ?? "",
              prompt: promptCandidate,
              negativePrompt: negPromptCandidate,
              inputKeys: [
                ...Object.keys(input),
                ...Object.keys(nested).map((k) => `input.${k}`),
              ],
            });
            console.log(
              `    tool_use: ${ev.toolName}${promptCandidate ? ` prompt[${promptCandidate.length}c]` : ""}`,
            );
          } else if (ev.type === "session.status_idle") {
            console.log(`    idle (${ev.stopReason})`);
            if (ev.stopReason === "end_turn") return toolUses;
          }
        } catch {
          // ignore
        }
      }
    }
  }
  throw new Error("studio: stream did not end with end_turn before timeout");
}

async function readFinalJson(storeId: string): Promise<FinalJson | null> {
  for (const p of ["/final.json", "/memory/final.json"]) {
    const memories = await listMemories(storeId, { prefix: p });
    const m = memories.find((x) => x.path === p);
    if (m) {
      try {
        return JSON.parse(m.content) as FinalJson;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function readShotJson(storeId: string, n: number): Promise<ShotJson | null> {
  for (const p of [`/shots/${n}.json`, `/memory/shots/${n}.json`]) {
    const memories = await listMemories(storeId, { prefix: p });
    const m = memories.find((x) => x.path === p);
    if (m) {
      try {
        return JSON.parse(m.content) as ShotJson;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function downloadAndVerify(
  url: string,
  outPath: string,
): Promise<{ size: number; duration: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download mp4 failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(resolvePath(outPath, ".."), { recursive: true });
  await writeFile(outPath, buf);
  const dur = await ffprobeDuration(outPath);
  return { size: buf.length, duration: dur };
}

async function finalizeStudio(storeId: string, sessionId: string): Promise<FinalizeRes> {
  const res = await fetch(`${BASE}/api/projects/${storeId}/studio/${sessionId}/finalize`, {
    method: "POST",
  });
  const data = (await res.json()) as FinalizeRes;
  if (!res.ok || data.error) {
    throw new Error(`finalize failed: ${data.error ?? res.status}`);
  }
  return data;
}

async function runStudio(storeId: string): Promise<{
  wallMs: number;
  sessionId: string;
  mp4Path: string;
  shotUrls: string[];
  toolUses: ToolUseRecord[];
  finalJson: FinalJson | null;
  durationSeconds: number;
  fileBytes: number;
}> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/projects/${storeId}/studio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief: BRIEF }),
  });
  if (!res.ok) throw new Error(`studio create failed: ${res.status}`);
  const data = (await res.json()) as { sessionId: string };
  console.log(`  studio session: ${data.sessionId}`);
  const toolUses = await streamUntilIdle(storeId, data.sessionId);
  const finalJson = await readFinalJson(storeId);
  const shotUrls = finalJson?.shot_urls ?? [];
  if (shotUrls.length === 0) {
    throw new Error("studio: /memory/final.json missing or no shot_urls");
  }
  console.log(`  studio: agent wrote ${shotUrls.length} shot URLs; composing...`);
  const finalized = await finalizeStudio(storeId, data.sessionId);
  if (finalized.durationSeconds < 5) {
    throw new Error(`studio mp4 too short: ${finalized.durationSeconds}s`);
  }
  const st = await stat(finalized.mp4LocalPath);
  console.log(
    `  studio: wall=${((Date.now() - t0) / 1000).toFixed(1)}s, dur=${finalized.durationSeconds.toFixed(2)}s, mp4=${finalized.mp4LocalPath}`,
  );
  return {
    wallMs: Date.now() - t0,
    sessionId: data.sessionId,
    mp4Path: finalized.mp4LocalPath,
    shotUrls,
    toolUses,
    finalJson,
    durationSeconds: finalized.durationSeconds,
    fileBytes: st.size,
  };
}

async function runFollowup(
  storeId: string,
  sessionId: string,
  prevShotUrls: string[],
): Promise<{
  wallMs: number;
  mp4Path: string;
  toolUses: ToolUseRecord[];
  finalJson: FinalJson | null;
  durationSeconds: number;
  fileBytes: number;
}> {
  const t0 = Date.now();
  const beforeShot2 = await readShotJson(storeId, 2);
  const res = await fetch(`${BASE}/api/projects/${storeId}/studio/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "regenerate shot 2 with cooler tone and softer light",
    }),
  });
  if (!res.ok) throw new Error(`followup post failed: ${res.status}`);
  const toolUses = await streamUntilIdle(storeId, sessionId);
  const afterShot2 = await readShotJson(storeId, 2);
  if (!afterShot2?.updated_at) {
    throw new Error("followup: shot 2 has no updated_at after followup");
  }
  const beforeTs = beforeShot2?.updated_at;
  const afterTs = afterShot2.updated_at;
  if (beforeTs !== undefined && String(afterTs) <= String(beforeTs)) {
    throw new Error(`followup: shot 2 updated_at not newer (before=${beforeTs}, after=${afterTs})`);
  }
  const finalJson = await readFinalJson(storeId);
  const newShotUrls = finalJson?.shot_urls ?? [];
  if (newShotUrls.length === 0) throw new Error("followup: no shot_urls");
  const shot2New = newShotUrls[1];
  const shot2Old = prevShotUrls[1];
  if (shot2New && shot2Old && shot2New === shot2Old) {
    throw new Error("followup: shot 2 URL unchanged");
  }
  const finalized = await finalizeStudio(storeId, sessionId);
  const st = await stat(finalized.mp4LocalPath);
  const followupFinalJson = await readFinalJson(storeId);
  console.log(
    `  followup: wall=${((Date.now() - t0) / 1000).toFixed(1)}s, dur=${finalized.durationSeconds.toFixed(2)}s, mp4=${finalized.mp4LocalPath}`,
  );
  return {
    wallMs: Date.now() - t0,
    mp4Path: finalized.mp4LocalPath,
    toolUses,
    finalJson: followupFinalJson,
    durationSeconds: finalized.durationSeconds,
    fileBytes: st.size,
  };
}

// ----- Assertion table (T1) -----
//
// One row per (lane, assertion). Each assertion returns pass | fail | skipped
// with a short observed/expected string. New assertions are added here;
// nowhere else. See docs/tech.md for the full design.

const SUBMIT_JOB_TOOLS = new Set(["submit_job", "run_model"]);

const FinalJsonSchema = z.object({
  shot_urls: z.array(z.url()).min(1),
  duration_seconds_per_clip: z.number().positive().optional(),
  crossfade_ms: z.number().nonnegative().optional(),
  updated_at: z.union([z.number(), z.string()]).optional(),
});

const ASSERTIONS: Assertion[] = [
  // Always-validate (AV) checks — gate the run's "healthy event seam" but do
  // not block downstream feature assertions.
  {
    id: "AV1.manifest_schema",
    lane: "studio",
    description: "/memory/final.json parses against the manifest schema",
    evaluate: (ctx) => evaluateManifestSchema(ctx),
  },
  {
    id: "AV1.manifest_schema",
    lane: "studio-followup",
    description: "/memory/final.json parses against the manifest schema",
    evaluate: (ctx) => evaluateManifestSchema(ctx),
  },
  {
    id: "AV2.shot_grammar.prompt_nonempty",
    lane: "studio",
    description: "Every submit_job carries a non-empty input.prompt",
    evaluate: (ctx) => evaluatePromptNonEmpty(ctx),
  },
  {
    id: "AV2.shot_grammar.prompt_nonempty",
    lane: "studio-followup",
    description: "Every submit_job carries a non-empty input.prompt",
    evaluate: (ctx) => evaluatePromptNonEmpty(ctx),
  },
  // Feature assertions (red until the matching agent.yaml prompt edit lands).
  {
    id: "V6.negative_prompt_nonempty",
    lane: "studio",
    description: "Every submit_job carries a non-empty input.negative_prompt",
    evaluate: (ctx) => evaluateNegativePromptNonEmpty(ctx),
  },
  {
    id: "V6.negative_prompt_nonempty",
    lane: "studio-followup",
    description: "Every submit_job carries a non-empty input.negative_prompt",
    evaluate: (ctx) => evaluateNegativePromptNonEmpty(ctx),
  },
];

function evaluateManifestSchema(ctx: RunContext): AssertionResult {
  if (!ctx.finalJson) {
    return {
      status: "fail",
      observed: "/memory/final.json missing or unparseable",
      expected: "valid manifest matching FinalJsonSchema",
    };
  }
  const parsed = FinalJsonSchema.safeParse(ctx.finalJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}:${i.message}`)
      .join("; ");
    return {
      status: "fail",
      observed: `schema errors: ${issues}`,
      expected: "valid manifest matching FinalJsonSchema",
    };
  }
  return {
    status: "pass",
    observed: `manifest has ${parsed.data.shot_urls.length} shot_urls`,
    expected: "valid manifest matching FinalJsonSchema",
  };
}

function evaluatePromptNonEmpty(ctx: RunContext): AssertionResult {
  const jobs = ctx.toolUses.filter((t) => SUBMIT_JOB_TOOLS.has(t.toolName));
  if (jobs.length === 0) {
    return {
      status: "skipped",
      observed: "no submit_job tool_use events captured",
      expected: ">=1 submit_job event with non-empty prompt",
    };
  }
  const empty = jobs.filter((j) => !j.prompt || j.prompt.trim().length === 0);
  const diag = empty
    .slice(0, 3)
    .map((j) => `${j.toolName}[${j.inputKeys.slice(0, 6).join(",")}]`)
    .join("; ");
  return {
    status: empty.length === 0 ? "pass" : "fail",
    observed:
      empty.length === 0
        ? `${jobs.length}/${jobs.length} submit_job calls had non-empty prompt`
        : `${jobs.length - empty.length}/${jobs.length} submit_job calls had non-empty prompt; missing: ${diag}`,
    expected: "non-empty prompt on every submit_job call",
    evidenceEventIds: empty.map((e) => e.eventId).filter((x) => x.length > 0),
  };
}

function evaluateNegativePromptNonEmpty(ctx: RunContext): AssertionResult {
  const jobs = ctx.toolUses.filter((t) => SUBMIT_JOB_TOOLS.has(t.toolName));
  if (jobs.length === 0) {
    return {
      status: "skipped",
      observed: "no submit_job tool_use events captured",
      expected: ">=1 submit_job event with non-empty negative_prompt",
    };
  }
  const withNeg = jobs.filter(
    (j) => j.negativePrompt !== null && j.negativePrompt.trim().length > 0,
  );
  return {
    status: withNeg.length === jobs.length ? "pass" : "fail",
    observed: `${withNeg.length}/${jobs.length} submit_job calls had non-empty negative_prompt`,
    expected: "non-empty negative_prompt on every submit_job call",
    evidenceEventIds: jobs
      .filter((j) => !j.negativePrompt || j.negativePrompt.trim().length === 0)
      .map((j) => j.eventId)
      .filter((x) => x.length > 0),
  };
}

function evaluateLane(ctx: RunContext): AssertionResult[] {
  const rows: AssertionResult[] = [];
  for (const a of ASSERTIONS) {
    if (a.lane !== "all" && a.lane !== ctx.lane) continue;
    rows.push(a.evaluate(ctx));
  }
  return rows;
}

function assertionsForLane(lane: Lane): Assertion[] {
  return ASSERTIONS.filter((a) => a.lane === "all" || a.lane === lane);
}

// ----- Ledger (T2) -----

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  try {
    const buf = await readFile(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return "missing";
  }
}

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "no-git";
  }
}

function makeRunId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const tag = randomBytes(2).toString("hex");
  return `${iso}-${tag}`;
}

function countSubmitJobs(toolUses: ToolUseRecord[]): number {
  return toolUses.filter((t) => SUBMIT_JOB_TOOLS.has(t.toolName)).length;
}

interface LedgerHarness {
  runId: string;
  filePath: string;
  agentYamlSha: string;
  briefSha: string;
  gitSha: string;
  rows: LedgerRow[];
}

async function openLedger(): Promise<LedgerHarness> {
  await mkdir(PERF_DIR, { recursive: true });
  const runId = makeRunId();
  const filePath = resolvePath(PERF_DIR, `${runId}.ndjson`);
  return {
    runId,
    filePath,
    agentYamlSha: await sha256File(AGENT_YAML),
    briefSha: sha256(BRIEF),
    gitSha: gitSha(),
    rows: [],
  };
}

async function writeLedger(h: LedgerHarness, row: LedgerRow): Promise<void> {
  h.rows.push(row);
  await appendFile(h.filePath, `${JSON.stringify(row)}\n`);
}

async function emitLaneAndAssertions(
  h: LedgerHarness,
  ctx: RunContext,
  wallMs: number,
): Promise<{ pass: number; fail: number; skipped: number }> {
  const submitJobs = countSubmitJobs(ctx.toolUses);
  const laneRow: LedgerLaneRow = {
    kind: "lane",
    run_id: h.runId,
    ts: new Date().toISOString(),
    lane: ctx.lane,
    git_sha: h.gitSha,
    agent_yaml_sha256: h.agentYamlSha,
    brief_sha256: h.briefSha,
    model: null, // populated once span.* seam lands
    wall_ms: wallMs,
    tool_use_count: ctx.toolUses.length,
    mcp_tool_use_count: submitJobs,
    shot_count: ctx.finalJson?.shot_urls?.length ?? null,
    template:
      typeof (ctx.finalJson as Record<string, unknown> | null)?.template === "string"
        ? ((ctx.finalJson as Record<string, unknown>).template as string)
        : null,
    error: ctx.error,
  };
  await writeLedger(h, laneRow);
  const results = evaluateLane(ctx);
  const assertions = assertionsForLane(ctx.lane);
  const counts = { pass: 0, fail: 0, skipped: 0 };
  for (let i = 0; i < assertions.length; i += 1) {
    const a = assertions[i];
    const r = results[i];
    if (!a || !r) continue;
    counts[r.status] += 1;
    const aRow: LedgerAssertionRow = {
      kind: "assertion",
      run_id: h.runId,
      ts: new Date().toISOString(),
      lane: ctx.lane,
      assertion_id: a.id,
      status: r.status,
      observed: r.observed,
      expected: r.expected,
      evidence_event_ids: r.evidenceEventIds,
      agent_yaml_sha256: h.agentYamlSha,
    };
    await writeLedger(h, aRow);
    const tag = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "·";
    console.log(`    ${tag} ${a.id}: ${r.observed}`);
  }
  return counts;
}

// ----- Report mode (T3 — minimal first cut) -----

async function reportMode(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await readdir(PERF_DIR)).filter((f) => f.endsWith(".ndjson"));
  } catch {
    console.log("No ledger entries yet. Run `bun scripts/acceptance.ts` first.");
    return;
  }
  if (files.length === 0) {
    console.log("No ledger entries yet.");
    return;
  }
  const laneRows: LedgerLaneRow[] = [];
  const assertionRows: LedgerAssertionRow[] = [];
  for (const f of files) {
    const text = await readFile(resolvePath(PERF_DIR, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as LedgerRow;
        if (r.kind === "lane") laneRows.push(r);
        else if (r.kind === "assertion") assertionRows.push(r);
      } catch {
        // skip malformed
      }
    }
  }
  console.log(
    `Ledger: ${files.length} runs, ${laneRows.length} lane rows, ${assertionRows.length} assertion rows\n`,
  );

  // Per-lane median wall_ms across most recent 10 runs.
  const byLane = new Map<string, number[]>();
  for (const r of laneRows.slice(-30)) {
    if (!byLane.has(r.lane)) byLane.set(r.lane, []);
    byLane.get(r.lane)?.push(r.wall_ms);
  }
  console.log("LANE WALL TIME (most recent up to 30 runs)");
  console.log("lane                median(s)   p90(s)    n");
  for (const [lane, vals] of byLane) {
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    console.log(
      `${lane.padEnd(20)} ${(median / 1000).toFixed(1).padStart(7)}   ${(p90 / 1000).toFixed(1).padStart(6)}  ${String(vals.length).padStart(3)}`,
    );
  }

  // Per-assertion pass rate by agent_yaml_sha256.
  console.log("\nASSERTION TREND (by agent_yaml_sha256, last 7d)");
  console.log("assertion_id                          lane              sha(8)    p/f/s");
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const buckets = new Map<string, { pass: number; fail: number; skipped: number }>();
  for (const r of assertionRows) {
    if (Date.parse(r.ts) < cutoff) continue;
    const k = `${r.assertion_id}|${r.lane}|${r.agent_yaml_sha256.slice(0, 8)}`;
    let b = buckets.get(k);
    if (!b) {
      b = { pass: 0, fail: 0, skipped: 0 };
      buckets.set(k, b);
    }
    b[r.status] += 1;
  }
  const keys = [...buckets.keys()].sort();
  for (const k of keys) {
    const [id, lane, sha] = k.split("|");
    const b = buckets.get(k);
    if (!b) continue;
    console.log(
      `${(id ?? "").padEnd(38)} ${(lane ?? "").padEnd(17)} ${sha}  ${b.pass}/${b.fail}/${b.skipped}`,
    );
  }
}

// ----- Main -----

async function main(): Promise<void> {
  if (process.argv.includes("--report")) {
    await reportMode();
    return;
  }
  console.log("[acceptance] waiting for server health...");
  await waitForHealth();
  console.log("[acceptance] creating project...");
  const storeId = await createProject();
  console.log(`[acceptance] storeId=${storeId}`);

  const ledger = await openLedger();
  console.log(`[acceptance] ledger: ${ledger.filePath}`);
  console.log(`[acceptance] agent.yaml sha256=${ledger.agentYamlSha.slice(0, 12)}`);

  const results: Array<{ test: string; wallMs: number; path: string }> = [];
  const allCounts = { pass: 0, fail: 0, skipped: 0 };

  console.log("[acceptance] --- DRAFT ---");
  let draftErr: string | null = null;
  let draft: { wallMs: number; mp4Path: string } | null = null;
  try {
    draft = await runDraft(storeId);
  } catch (e) {
    draftErr = e instanceof Error ? e.message : String(e);
  }
  const draftCtx: RunContext = {
    lane: "draft",
    toolUses: [],
    finalJson: null,
    shotsByN: new Map(),
    mp4DurationSec: null,
    mp4Bytes: null,
    error: draftErr,
  };
  await emitLaneAndAssertions(ledger, draftCtx, draft?.wallMs ?? 0);
  if (draft) {
    const draftCopy = resolvePath(
      process.cwd(),
      "data/finals",
      `draft-acceptance-${Date.now()}.mp4`,
    );
    await copyFile(draft.mp4Path, draftCopy);
    results.push({ test: "draft", wallMs: draft.wallMs, path: draftCopy });
  }
  if (draftErr) throw new Error(`draft failed: ${draftErr}`);

  console.log("[acceptance] --- STUDIO ---");
  const studio = await runStudio(storeId);
  const studioCtx: RunContext = {
    lane: "studio",
    toolUses: studio.toolUses,
    finalJson: studio.finalJson,
    shotsByN: new Map(),
    mp4DurationSec: studio.durationSeconds,
    mp4Bytes: studio.fileBytes,
    error: null,
  };
  const studioCounts = await emitLaneAndAssertions(ledger, studioCtx, studio.wallMs);
  allCounts.pass += studioCounts.pass;
  allCounts.fail += studioCounts.fail;
  allCounts.skipped += studioCounts.skipped;
  results.push({ test: "studio", wallMs: studio.wallMs, path: studio.mp4Path });

  console.log("[acceptance] --- STUDIO FOLLOWUP ---");
  const followup = await runFollowup(storeId, studio.sessionId, studio.shotUrls);
  const followupCtx: RunContext = {
    lane: "studio-followup",
    toolUses: followup.toolUses,
    finalJson: followup.finalJson,
    shotsByN: new Map(),
    mp4DurationSec: followup.durationSeconds,
    mp4Bytes: followup.fileBytes,
    error: null,
  };
  const followupCounts = await emitLaneAndAssertions(ledger, followupCtx, followup.wallMs);
  allCounts.pass += followupCounts.pass;
  allCounts.fail += followupCounts.fail;
  allCounts.skipped += followupCounts.skipped;
  results.push({ test: "studio-followup", wallMs: followup.wallMs, path: followup.mp4Path });

  console.log("\n[acceptance] SUMMARY");
  console.log("test               wall(s)   ratio-vs-235s  path");
  for (const r of results) {
    const sec = (r.wallMs / 1000).toFixed(1).padStart(7);
    const ratio = (235 / (r.wallMs / 1000)).toFixed(2).padStart(6);
    console.log(`${r.test.padEnd(18)} ${sec}   ${ratio}x       ${r.path}`);
  }
  console.log(
    `\n[acceptance] assertions: pass=${allCounts.pass} fail=${allCounts.fail} skipped=${allCounts.skipped}`,
  );
  console.log(`[acceptance] ledger written: ${ledger.filePath}`);
}

main().catch((err) => {
  console.error(`[acceptance] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
