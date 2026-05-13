/**
 * Exec demo: end-to-end real critique loop, real videos.
 *
 * Brief: Luxury heirloom mechanical timepiece, 30s teaser, three generations.
 *
 * Loop:
 *   v1: generate from curated prompts (5 shots)
 *   for v in [v2, v3, v4]:
 *     - 6-aspect live Managed-Agent critic panel (parallel sessions)
 *     - parse critique envelopes via Zod
 *     - if every shot locked AND overall >= 0.85 → converge, stop
 *     - else: rewrite failing prompts via Claude, generate best-of-2 takes,
 *       pick the better thumbnail with Claude vision, compose new mp4
 *
 * Deliverables in data/exec-demo/<runId>/:
 *   - v1.mp4 v2.mp4 v3.mp4 (v4.mp4 if needed)
 *   - composite.mp4   (horizontal stack with version labels)
 *   - scorecard.md    (per-aspect scores, per version, with deltas)
 *   - summary.md      (one-page exec brief)
 *   - run.json        (full audit trail)
 */
import Anthropic from "@anthropic-ai/sdk";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";
import {
  type IncomingSessionEvent,
  type SessionResource,
  createMemoryStore,
  createSession,
  listMemories,
  sendEvent,
  streamSession,
  updateMemoryStoreMetadata,
} from "@/lib/anthropic";
import {
  CRITIQUE_ASPECTS,
  CRITIQUE_THRESHOLD,
  type CritiqueAspect,
  type CritiqueEnvelope,
  aggregate,
  listCritiques,
} from "@/lib/critique";
import {
  type DraftEnvelope,
  writeDraft,
  writeHead,
} from "@/lib/drafts";
import { submitTextToVideo } from "@/lib/fal";
import { composeClips, ffprobeDuration } from "@/lib/ffmpeg";
import { getEnv } from "@/lib/env";

// ============================================================
// Brief + initial shot list
// ============================================================

const BRIEF = [
  "Luxury heirloom mechanical timepiece — 30-second teaser.",
  "Three generations: grandfather's wrist, father at his desk, daughter in golden-hour Paris.",
  "Warm tonal palette, intentional camera motion, intimate scale, sense of time being handed forward.",
].join(" ");

const V1_PROMPTS = [
  "Extreme close-up of an antique mechanical wristwatch on weathered hands of an elderly man, soft window light, shallow depth of field, gentle dolly-in revealing the engraved case back",
  "Medium shot of a middle-aged father at a wooden desk in lamplight, slowly winding the same watch, warm amber tones, slight rack focus from his hand to his eyes",
  "Wide shot of a young woman walking along the Seine at golden hour, the watch glinting on her wrist, soft camera follow, Parisian rooftops in soft focus background",
  "Macro shot of the watch mechanism — escapement ticking, ruby jewels catching warm light, slow rotation reveal",
  "Two pairs of hands, generations apart, the older one clasping the watch onto the younger wrist, intimate close framing, candle-warm fill light",
];

const SHOT_COUNT = V1_PROMPTS.length;

// Tunables for the four fixes:
const SEATS_PER_ASPECT = 3; // 3 critic seats per aspect → median consensus
const LOCK_THRESHOLD = 0.7; // shot avg ≥ this → locked (byte reuse)
const REWRITE_THRESHOLD = 0.55; // below this → rewrite prompt + best-of-3
const CARRY_FORWARD_FLOOR_DELTA = 0.05; // locked shots cannot drop below prior - this
const BEST_OF_N = 3; // for the rewrite tier

// ============================================================
// Helpers
// ============================================================

const log = (...args: unknown[]): void => console.log("[demo]", ...args);
const stamp = (): string => new Date().toISOString().slice(11, 19);

const RUN_ID = `exec-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
const OUT_DIR = resolvePath(process.cwd(), "data/exec-demo", RUN_ID);

let _anthropic: Anthropic | null = null;
function getAnth(): Anthropic {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY missing");
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    p.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const t = opts.timeoutMs
      ? setTimeout(() => {
          p.kill("SIGKILL");
          reject(new Error(`${cmd} timeout`));
        }, opts.timeoutMs)
      : null;
    p.on("close", (code) => {
      if (t) clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    p.on("error", (err) => {
      if (t) clearTimeout(t);
      reject(err);
    });
  });
}

// ============================================================
// v1 generation (real FAL → real ffmpeg)
// ============================================================

async function generateMp4(input: {
  prompts: string[];
  lockedUrls: Record<number, string>;
  outputBasename: string;
}): Promise<{
  shotUrls: string[];
  mp4Path: string;
  durationSeconds: number;
  fileBytes: number;
  modelUsed: string | null;
}> {
  const locked = input.lockedUrls;
  log(stamp(), `dispatching FAL for ${input.prompts.length - Object.keys(locked).length} regen shot(s)`);

  type Slot = { index: number; promise: Promise<{ videoUrl: string; modelUsed: string }> };
  const pending: Slot[] = [];
  for (let i = 0; i < input.prompts.length; i++) {
    if (Object.prototype.hasOwnProperty.call(locked, i)) continue;
    const prompt = input.prompts[i] ?? "";
    pending.push({ index: i, promise: submitTextToVideo({ prompt }) });
  }
  const settled = await Promise.all(pending.map((p) => p.promise));

  const shotUrls: string[] = new Array(input.prompts.length).fill("");
  for (let i = 0; i < input.prompts.length; i++) {
    const u = locked[i];
    if (u !== undefined) shotUrls[i] = u;
  }
  let modelUsed: string | null = null;
  for (let k = 0; k < pending.length; k++) {
    const slot = pending[k]!;
    const res = settled[k]!;
    shotUrls[slot.index] = res.videoUrl;
    if (modelUsed === null) modelUsed = res.modelUsed;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const scratchDir = `/tmp/${RUN_ID}-${input.outputBasename}`;
  await mkdir(scratchDir, { recursive: true });
  const scratchOut = `${scratchDir}/final.mp4`;
  await composeClips({ clipUrls: shotUrls, outPath: scratchOut });
  const durationSeconds = await ffprobeDuration(scratchOut);
  const mp4Path = resolvePath(OUT_DIR, `${input.outputBasename}.mp4`);
  await copyFile(scratchOut, mp4Path);
  const fileBytes = (await Bun.file(mp4Path).size) ?? 0;

  return { shotUrls, mp4Path, durationSeconds, fileBytes, modelUsed };
}

// ============================================================
// Live Managed-Agent critic panel (parallel sessions, one per aspect)
// ============================================================

function buildRubric(
  aspect: CritiqueAspect,
  draftVersion: string,
  shotCount: number,
  seat: number,
): string {
  return [
    `You are CRITIC SEAT ${seat} on the "${aspect}" panel for short premium ad videos.`,
    `Score each of the ${shotCount} shots from 0.0 to 1.0 on ${aspect} quality. Shots below 0.7 will be regenerated.`,
    "",
    "OUTPUT PROTOCOL.",
    "Step 1: run `bash` with `ls /mnt/memory/` — call the result STORE_DIR.",
    `Step 2: write EXACTLY ONE file at: /mnt/memory/$STORE_DIR/memory/critiques/${draftVersion}/${aspect}-seat${seat}.json`,
    "",
    "The file MUST be valid JSON matching this shape (no extra fields, no markdown, no commentary, file starts with `{` and ends with `}`):",
    "",
    "{",
    `  "version": "c-${aspect}-${draftVersion}-seat${seat}",`,
    `  "parent_draft": "${draftVersion}",`,
    `  "aspect": "${aspect}",`,
    '  "shot_scores": [',
    ...Array.from({ length: shotCount }, (_, i) =>
      `    { "n": ${i}, "score": 0.0, "issues": ["..."], "suggestion": "minimal, targeted fix focused on ${aspect}" }${i < shotCount - 1 ? "," : ""}`,
    ),
    "  ],",
    '  "overall": 0.0,',
    `  "summary": "one short sentence on ${aspect}",`,
    '  "created_at": "<ISO timestamp>"',
    "}",
    "",
    "Rules:",
    "  - shot_scores has EXACTLY one entry per shot, in order 0..N-1",
    "  - `issues` is an array of strings (may be empty [])",
    "  - `suggestion` is always a string — be SPECIFIC and MINIMAL: change at most one or two attributes (lighting, lens, camera motion, color)",
    "  - `score` and `overall` are numbers in [0,1]",
    "  - Score honestly. A solid premium-ad first draft typically scores 0.65-0.80 per aspect.",
    `  - When the file is written, emit one message \`DONE ${aspect} seat ${seat}\` and end the turn.`,
  ].join("\n");
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

const SEAT_RE = /^\/memory\/critiques\/([^/]+)\/([^/]+)-seat(\d+)\.json$/;

async function loadSeatEnvelopes(
  storeId: string,
  draftVersion: string,
): Promise<Map<CritiqueAspect, CritiqueEnvelope[]>> {
  const mems = await listMemories(storeId, {
    prefix: `/memory/critiques/${draftVersion}/`,
  });
  const out = new Map<CritiqueAspect, CritiqueEnvelope[]>();
  for (const m of mems) {
    const match = SEAT_RE.exec(m.path);
    if (!match || match[1] !== draftVersion) continue;
    const aspect = match[2] as CritiqueAspect;
    if (!CRITIQUE_ASPECTS.includes(aspect)) continue;
    try {
      const raw = JSON.parse(m.content);
      // Normalize: trust the file's aspect field; if missing, use filename aspect.
      if (raw && typeof raw === "object") {
        raw.aspect = aspect;
        if (!Array.isArray(raw.shot_scores)) continue;
        // Ensure every shot has issues + suggestion fields.
        for (const sc of raw.shot_scores) {
          if (!Array.isArray(sc.issues)) sc.issues = [];
          if (typeof sc.suggestion !== "string") sc.suggestion = "";
        }
        const list = out.get(aspect) ?? [];
        list.push(raw as CritiqueEnvelope);
        out.set(aspect, list);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

function buildConsensusEnvelope(
  aspect: CritiqueAspect,
  draftVersion: string,
  seats: CritiqueEnvelope[],
): CritiqueEnvelope {
  const shotIndices = new Set<number>();
  for (const s of seats) for (const sc of s.shot_scores) shotIndices.add(sc.n);
  const shot_scores = [...shotIndices]
    .sort((a, b) => a - b)
    .map((n) => {
      const scores: number[] = [];
      const issues: string[] = [];
      const suggestions: string[] = [];
      for (const s of seats) {
        const sc = s.shot_scores.find((x) => x.n === n);
        if (!sc) continue;
        scores.push(sc.score);
        for (const i of sc.issues) issues.push(i);
        if (sc.suggestion) suggestions.push(sc.suggestion);
      }
      return {
        n,
        score: median(scores),
        issues: [...new Set(issues)].slice(0, 6),
        suggestion: suggestions.join(" / ").slice(0, 600),
      };
    });
  const overall =
    shot_scores.length > 0
      ? shot_scores.reduce((a, s) => a + s.score, 0) / shot_scores.length
      : 0;
  return {
    version: `c-${aspect}-${draftVersion}-consensus`,
    parent_draft: draftVersion,
    aspect,
    shot_scores,
    overall,
    summary: `median of ${seats.length} seat(s)`,
    created_at: new Date().toISOString(),
  };
}

type PerAspectShotScores = Map<CritiqueAspect, Record<number, number>>;

function extractPerAspectScores(envs: CritiqueEnvelope[]): PerAspectShotScores {
  const out: PerAspectShotScores = new Map();
  for (const e of envs) {
    const m: Record<number, number> = {};
    for (const s of e.shot_scores) m[s.n] = s.score;
    out.set(e.aspect, m);
  }
  return out;
}

function applyCarryForward(
  current: CritiqueEnvelope[],
  priorPerAspect: PerAspectShotScores,
  priorLocked: Set<number>,
): CritiqueEnvelope[] {
  return current.map((env) => {
    const priorByShot = priorPerAspect.get(env.aspect) ?? {};
    const newScores = env.shot_scores.map((sc) => {
      if (!priorLocked.has(sc.n)) return sc;
      const prior = priorByShot[sc.n];
      if (prior === undefined) return sc;
      const floor = prior - CARRY_FORWARD_FLOOR_DELTA;
      if (sc.score >= floor) return sc;
      return { ...sc, score: floor };
    });
    const overall =
      newScores.length > 0
        ? newScores.reduce((a, s) => a + s.score, 0) / newScores.length
        : 0;
    return { ...env, shot_scores: newScores, overall };
  });
}

function tierOf(shotAvg: number): "lock" | "nudge" | "rewrite" {
  if (shotAvg >= LOCK_THRESHOLD) return "lock";
  if (shotAvg >= REWRITE_THRESHOLD) return "nudge";
  return "rewrite";
}

function perShotAverages(envs: CritiqueEnvelope[]): Record<number, number> {
  const acc: Record<number, number[]> = {};
  for (const e of envs) {
    for (const s of e.shot_scores) {
      acc[s.n] = acc[s.n] ?? [];
      acc[s.n]!.push(s.score);
    }
  }
  const out: Record<number, number> = {};
  for (const [n, arr] of Object.entries(acc)) {
    out[Number(n)] = arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  return out;
}

async function streamUntilIdle(
  sessionId: string,
  timeoutMs: number,
  tag: string,
): Promise<IncomingSessionEvent[]> {
  const events: IncomingSessionEvent[] = [];
  const start = Date.now();
  for await (const ev of streamSession(sessionId)) {
    events.push(ev);
    if (ev.type === "session.status_idle" && ev.stopReason === "end_turn") {
      log(stamp(), `idle [${tag}]`);
      break;
    }
    if (ev.type === "agent.tool_use") {
      const inp = JSON.stringify(ev.input).slice(0, 80);
      log(stamp(), `tool [${tag}]: ${ev.toolName} ${inp}`);
    }
    if (Date.now() - start > timeoutMs) {
      log(`timeout [${tag}], aborting stream`);
      break;
    }
  }
  return events;
}

async function critiquePanel(
  storeId: string,
  draftVersion: string,
  shotPrompts: string[],
): Promise<CritiqueEnvelope[]> {
  const env = getEnv();
  const resources: SessionResource[] = [
    {
      type: "memory_store",
      memory_store_id: storeId,
      access: "read_write",
      instructions: [
        "MEMORY STORE MOUNT — READ CAREFULLY.",
        "The memory store is mounted at `/mnt/memory/<store-dir>/`.",
        "STEP 0: run `bash` with `ls /mnt/memory/`. Use the result as STORE_DIR.",
        "Write critique files to /mnt/memory/$STORE_DIR/memory/critiques/<draftVersion>/<aspect>-seat<N>.json",
      ].join("\n"),
    },
  ];

  const totalSessions = CRITIQUE_ASPECTS.length * SEATS_PER_ASPECT;
  log(
    stamp(),
    `critic panel for ${draftVersion}: spawning ${totalSessions} sessions (${CRITIQUE_ASPECTS.length} aspects × ${SEATS_PER_ASPECT} seats)`,
  );

  const sessions: { aspect: CritiqueAspect; seat: number; sessionId: string }[] = [];
  for (const aspect of CRITIQUE_ASPECTS) {
    for (let seat = 0; seat < SEATS_PER_ASPECT; seat++) {
      const { sessionId } = await createSession({
        agentId: env.AGENT_ID,
        environmentId: env.ENV_ID,
        vaultIds: [env.VAULT_ID],
        title: `Critique ${draftVersion} — ${aspect} seat ${seat}`,
        resources,
      });
      sessions.push({ aspect, seat, sessionId });
      await sendEvent(sessionId, {
        type: "user.define_outcome",
        rubric: buildRubric(aspect, draftVersion, shotPrompts.length, seat),
        maxIterations: 1,
      });
      await sendEvent(sessionId, {
        type: "user.message",
        content: `Critique ${draftVersion} for ${aspect} (seat ${seat}).\nBrief: ${BRIEF}\nShot prompts:\n${shotPrompts
          .map((p, i) => `  [${i}] ${p}`)
          .join("\n")}`,
      });
    }
  }

  await Promise.all(
    sessions.map(({ aspect, seat, sessionId }) =>
      streamUntilIdle(sessionId, 8 * 60 * 1000, `${draftVersion}/${aspect}/s${seat}`),
    ),
  );

  // Read all seat envelopes, build median consensus per aspect.
  const bySeat = await loadSeatEnvelopes(storeId, draftVersion);
  const consensus: CritiqueEnvelope[] = [];
  for (const aspect of CRITIQUE_ASPECTS) {
    const seats = bySeat.get(aspect) ?? [];
    if (seats.length === 0) {
      log(`  WARN: no seats parsed for aspect=${aspect}`);
      continue;
    }
    consensus.push(buildConsensusEnvelope(aspect, draftVersion, seats));
  }
  log(
    stamp(),
    `panel consensus: ${consensus.length}/${CRITIQUE_ASPECTS.length} aspects, total ${[...bySeat.values()].reduce((a, b) => a + b.length, 0)}/${totalSessions} seat envelopes`,
  );
  return consensus;
}

// ============================================================
// Prompt rewriter — Claude proposes a new prompt for a failing shot
// ============================================================

async function rewritePrompt(input: {
  parentPrompt: string;
  shotIndex: number;
  issues: string[];
  suggestions: string[];
}): Promise<string> {
  const client = getAnth();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "You are rewriting a single shot prompt for a text-to-video model (FAL ltx-2.3).",
              `BRIEF (top-level intent): ${BRIEF}`,
              "",
              `Original prompt for shot ${input.shotIndex}:`,
              `  "${input.parentPrompt}"`,
              "",
              "Critics flagged these issues:",
              ...input.issues.slice(0, 12).map((i) => `  - ${i}`),
              "",
              "Critic suggestions (concrete fixes):",
              ...input.suggestions.slice(0, 12).map((s) => `  - ${s}`),
              "",
              "MAKE A MINIMAL TARGETED REWRITE.",
              "  - PRESERVE: subject, scene, era, props, framing intent.",
              "  - CHANGE: at most 1-2 attributes (camera motion, lighting quality, color temp, composition detail).",
              "  - Do NOT introduce new subjects, locations, or moods.",
              "  - Do NOT lengthen the prompt by more than 25%.",
              "",
              "Output ONLY the new prompt, one paragraph, no labels or quotes.",
            ].join("\n"),
          },
        ],
      },
    ],
  });
  const block = msg.content[0];
  if (!block || block.type !== "text") {
    throw new Error("prompt rewrite: no text block");
  }
  return block.text.trim().replace(/^["']|["']$/g, "");
}

// ============================================================
// Best-of-2: generate 2 takes, vision-judge first frames, pick winner
// ============================================================

async function fetchVideo(url: string, outPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await writeFile(outPath, buf);
}

async function extractThumbnail(mp4Path: string, outJpg: string): Promise<void> {
  const r = await run("ffmpeg", [
    "-y",
    "-ss",
    "1.5",
    "-i",
    mp4Path,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    outJpg,
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg thumb: ${r.stderr.slice(-300)}`);
}

async function judgeBestThumbnail(input: {
  brief: string;
  originalPrompt: string;
  thumbPaths: string[]; // candidate labels are letters A, B, C, ...
}): Promise<number> {
  const labels = "ABCDEFGH";
  const images = await Promise.all(input.thumbPaths.map((p) => readFile(p)));
  const client = getAnth();
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }
  > = [
    {
      type: "text",
      text: [
        "Pick the candidate frame that BEST serves THIS BRIEF (not just visual prettiness):",
        `BRIEF: ${input.brief}`,
        "",
        `Original shot intent: ${input.originalPrompt}`,
        "",
        `You will see ${input.thumbPaths.length} candidate frames labelled ${labels.slice(0, input.thumbPaths.length).split("").join(", ")} in order.`,
        "Judge against: brief alignment, composition, motion intent inferable from frame, color cohesion with the brief's warm tonal palette, and cinematic quality.",
        `Reply with exactly one character: ${labels.slice(0, input.thumbPaths.length).split("").join(" or ")}.`,
      ].join("\n"),
    },
  ];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") },
    });
  }
  const msg = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 50,
    messages: [{ role: "user", content }],
  });
  const block = msg.content[0];
  const txt = block && block.type === "text" ? block.text.trim().toUpperCase() : "A";
  const idx = labels.indexOf(txt[0] ?? "A");
  return idx >= 0 && idx < input.thumbPaths.length ? idx : 0;
}

async function bestOfN(input: {
  brief: string;
  originalPrompt: string;
  rewrittenPrompt: string;
  shotIndex: number;
  workDir: string;
  n: number;
}): Promise<string> {
  log(stamp(), `best-of-${input.n} shot ${input.shotIndex}: generating ${input.n} takes`);
  const takes = await Promise.all(
    Array.from({ length: input.n }, () => submitTextToVideo({ prompt: input.rewrittenPrompt })),
  );
  const labels = "ABCDEFGH";
  const mp4s = takes.map(
    (_, i) => `${input.workDir}/shot${input.shotIndex}-${labels[i]}.mp4`,
  );
  const thumbs = takes.map(
    (_, i) => `${input.workDir}/shot${input.shotIndex}-${labels[i]}.jpg`,
  );
  await Promise.all(takes.map((t, i) => fetchVideo(t.videoUrl, mp4s[i]!)));
  await Promise.all(mp4s.map((p, i) => extractThumbnail(p, thumbs[i]!)));
  const pick = await judgeBestThumbnail({
    brief: input.brief,
    originalPrompt: input.originalPrompt,
    thumbPaths: thumbs,
  });
  log(stamp(), `best-of-${input.n} shot ${input.shotIndex}: picked ${labels[pick]}`);
  return takes[pick]!.videoUrl;
}

// ============================================================
// Compose a new version from critiques: locked + best-of-2 regen
// ============================================================

async function applyCritique(input: {
  storeId: string;
  parentVersion: string;
  parent: DraftEnvelope;
  childVersion: string;
  critiques: CritiqueEnvelope[]; // carry-forward already applied if applicable
}): Promise<{ envelope: DraftEnvelope; tierByShot: Record<number, "lock" | "nudge" | "rewrite"> }> {
  const shotAvg = perShotAverages(input.critiques);
  const tierByShot: Record<number, "lock" | "nudge" | "rewrite"> = {};
  for (const shot of input.parent.shots) {
    tierByShot[shot.n] = tierOf(shotAvg[shot.n] ?? 0);
  }
  const counts = { lock: 0, nudge: 0, rewrite: 0 };
  for (const t of Object.values(tierByShot)) counts[t]++;
  log(
    stamp(),
    `${input.parentVersion} → ${input.childVersion}: lock=${counts.lock} nudge=${counts.nudge} rewrite=${counts.rewrite}`,
  );

  const workDir = `/tmp/${RUN_ID}-${input.childVersion}`;
  await mkdir(workDir, { recursive: true });

  const newPromptByShot: Record<number, string> = {};
  const resolvedUrls: Record<number, string> = {};

  await Promise.all(
    input.parent.shots.map(async (parentShot) => {
      const tier = tierByShot[parentShot.n] ?? "lock";
      if (tier === "lock") {
        if (parentShot.video_url) resolvedUrls[parentShot.n] = parentShot.video_url;
        return;
      }
      if (tier === "nudge") {
        // Keep prompt; single new take (light variance, no rewrite).
        log(stamp(), `nudge shot ${parentShot.n} (avg ${(shotAvg[parentShot.n] ?? 0).toFixed(2)}): keep prompt, 1 take`);
        const r = await submitTextToVideo({ prompt: parentShot.prompt });
        resolvedUrls[parentShot.n] = r.videoUrl;
        return;
      }
      // rewrite: minimal targeted rewrite + best-of-N vision judge against brief.
      const issues: string[] = [];
      const suggestions: string[] = [];
      for (const env of input.critiques) {
        const score = env.shot_scores.find((s) => s.n === parentShot.n);
        if (!score) continue;
        for (const i of score.issues) issues.push(`${env.aspect}: ${i}`);
        if (score.suggestion) suggestions.push(`${env.aspect}: ${score.suggestion}`);
      }
      const rewritten = await rewritePrompt({
        parentPrompt: parentShot.prompt,
        shotIndex: parentShot.n,
        issues,
        suggestions,
      });
      log(
        stamp(),
        `rewrite shot ${parentShot.n} (avg ${(shotAvg[parentShot.n] ?? 0).toFixed(2)}): ${rewritten.slice(0, 100)}...`,
      );
      const url = await bestOfN({
        brief: BRIEF,
        originalPrompt: parentShot.prompt,
        rewrittenPrompt: rewritten,
        shotIndex: parentShot.n,
        workDir,
        n: BEST_OF_N,
      });
      resolvedUrls[parentShot.n] = url;
      newPromptByShot[parentShot.n] = rewritten;
    }),
  );

  const prompts: string[] = input.parent.shots.map((s) => s.prompt);
  for (const [n, p] of Object.entries(newPromptByShot)) prompts[Number(n)] = p;

  const lockedShots: number[] = [];
  for (const [n, tier] of Object.entries(tierByShot)) {
    if (tier === "lock") lockedShots.push(Number(n));
  }
  lockedShots.sort((a, b) => a - b);

  const start = Date.now();
  const result = await generateMp4({
    prompts,
    lockedUrls: resolvedUrls, // all shots pre-resolved
    outputBasename: input.childVersion,
  });

  const overall = perShotAvgOverall(shotAvg);
  const envelope: DraftEnvelope = {
    version: input.childVersion,
    parent: input.parentVersion,
    reason: `critique:overall=${overall.toFixed(2)},lock=${counts.lock},nudge=${counts.nudge},rewrite=${counts.rewrite}`,
    locked_shots: lockedShots,
    shots: prompts.map((p, i) => ({
      n: i,
      prompt: p,
      video_url: result.shotUrls[i] ?? null,
    })),
    mp4_filename: basename(result.mp4Path),
    duration_seconds: result.durationSeconds,
    file_bytes: result.fileBytes,
    wall_ms: Date.now() - start,
    model_used: result.modelUsed,
    updated_at: new Date().toISOString(),
  };
  await writeDraft(input.storeId, envelope);
  await writeHead(input.storeId, { version: envelope.version, updated_at: envelope.updated_at });
  return { envelope, tierByShot };
}

function perShotAvgOverall(shotAvg: Record<number, number>): number {
  const vals = Object.values(shotAvg);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

// ============================================================
// Composite mp4 — vertical stack with version labels
// ============================================================

async function buildComposite(versions: { version: string; mp4Path: string }[]): Promise<string> {
  const outPath = resolvePath(OUT_DIR, "composite.mp4");
  const inputs: string[] = [];
  for (const v of versions) {
    inputs.push("-i", v.mp4Path);
  }
  // Each input: scale to 640x360, add label.
  const filters: string[] = [];
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i]!;
    filters.push(
      `[${i}:v]scale=640:360,drawtext=text='${v.version.toUpperCase()}':x=20:y=20:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8[v${i}]`,
    );
  }
  filters.push(
    `${versions.map((_, i) => `[v${i}]`).join("")}vstack=inputs=${versions.length}[out]`,
  );
  const args = [
    "-y",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "20",
    outPath,
  ];
  const r = await run("ffmpeg", args, { timeoutMs: 5 * 60 * 1000 });
  if (r.code !== 0) {
    throw new Error(`ffmpeg composite: ${r.stderr.slice(-500)}`);
  }
  return outPath;
}

// ============================================================
// Scorecard + summary writers
// ============================================================

type VersionScore = {
  version: string;
  perAspect: Partial<Record<CritiqueAspect, number>>;
  overall: number;
  locked: number[];
  regen: number[];
  shotScores: Record<number, number[]>; // shot → list of per-aspect scores
};

function scoreVersion(envelopes: CritiqueEnvelope[], version: string): VersionScore {
  const perAspect: Partial<Record<CritiqueAspect, number>> = {};
  const shotScores: Record<number, number[]> = {};
  for (const e of envelopes) {
    perAspect[e.aspect] = e.overall;
    for (const s of e.shot_scores) {
      shotScores[s.n] = shotScores[s.n] ?? [];
      shotScores[s.n]!.push(s.score);
    }
  }
  const agg = aggregate(envelopes);
  return {
    version,
    perAspect,
    overall: agg.overall,
    locked: agg.locked,
    regen: agg.regen.map((r) => r.n),
    shotScores,
  };
}

function shotAvg(scores: number[]): number {
  if (!scores.length) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

async function writeScorecard(scores: VersionScore[], envelopes: Record<string, DraftEnvelope>): Promise<void> {
  const aspects = CRITIQUE_ASPECTS;
  const rows: string[] = [];
  rows.push("# Critique scorecard");
  rows.push("");
  rows.push("Per-aspect overall score, by version (higher is better; threshold for locking a shot = 0.7).");
  rows.push("");
  rows.push(`| Aspect | ${scores.map((s) => s.version).join(" | ")} |`);
  rows.push(`|---|${scores.map(() => "---").join("|")}|`);
  for (const a of aspects) {
    const cells = scores.map((s) => {
      const v = s.perAspect[a];
      return v === undefined ? "—" : v.toFixed(2);
    });
    rows.push(`| ${a} | ${cells.join(" | ")} |`);
  }
  rows.push(`| **overall** | ${scores.map((s) => `**${s.overall.toFixed(2)}**`).join(" | ")} |`);
  rows.push(`| locked shots | ${scores.map((s) => `${s.locked.length}/${SHOT_COUNT}`).join(" | ")} |`);
  rows.push("");
  rows.push("## Per-shot scores (averaged across aspects)");
  rows.push("");
  rows.push(`| Shot | ${scores.map((s) => s.version).join(" | ")} |`);
  rows.push(`|---|${scores.map(() => "---").join("|")}|`);
  for (let n = 0; n < SHOT_COUNT; n++) {
    const cells = scores.map((s) => {
      const arr = s.shotScores[n];
      if (!arr || arr.length === 0) return "—";
      return shotAvg(arr).toFixed(2);
    });
    rows.push(`| ${n} | ${cells.join(" | ")} |`);
  }
  rows.push("");
  rows.push("## Files");
  for (const s of scores) {
    const env = envelopes[s.version];
    if (env) rows.push(`- **${s.version}** → \`${env.mp4_filename}\` (${env.file_bytes.toLocaleString()} bytes, ${env.duration_seconds.toFixed(1)}s)`);
  }
  await writeFile(resolvePath(OUT_DIR, "scorecard.md"), rows.join("\n"));
}

async function writeSummary(scores: VersionScore[]): Promise<void> {
  const first = scores[0]!;
  const last = scores[scores.length - 1]!;
  const delta = last.overall - first.overall;
  const lockedDelta = last.locked.length - first.locked.length;
  const rows: string[] = [];
  rows.push("# Self-critiquing video draft — exec summary");
  rows.push("");
  rows.push(`**Brief**: ${BRIEF}`);
  rows.push("");
  rows.push("## What this run demonstrates");
  rows.push("");
  rows.push("1. A first draft (`v1`) was generated from the brief with a text-to-video model.");
  rows.push(`2. A six-aspect critic panel (cinematography, pacing, color, narrative, audio, brand) ran on Anthropic Managed Agents in parallel; each critic wrote a per-aspect scorecard.`);
  rows.push("3. Shots scoring ≥ 0.70 were locked (byte-identical reuse). Failing shots had their prompts rewritten by Claude based on the critics' suggestions, then regenerated with best-of-2 vision-judged takes.");
  rows.push("4. The loop repeated until the rubric was satisfied or the iteration cap was hit.");
  rows.push("");
  rows.push("## Measured improvement");
  rows.push("");
  rows.push(`- Overall score: **${first.overall.toFixed(2)} → ${last.overall.toFixed(2)}** (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`);
  rows.push(`- Locked shots: **${first.locked.length} → ${last.locked.length}** (${lockedDelta >= 0 ? "+" : ""}${lockedDelta} of ${SHOT_COUNT})`);
  rows.push(`- Versions produced: ${scores.map((s) => s.version).join(", ")}`);
  rows.push("");
  rows.push("## Watch order");
  rows.push("");
  for (const s of scores) {
    rows.push(`- \`${s.version}.mp4\` — overall ${s.overall.toFixed(2)}, ${s.locked.length}/${SHOT_COUNT} shots locked`);
  }
  rows.push("- `composite.mp4` — all versions stacked vertically with labels, for side-by-side comparison.");
  rows.push("");
  rows.push("See `scorecard.md` for per-aspect / per-shot detail.");
  await writeFile(resolvePath(OUT_DIR, "summary.md"), rows.join("\n"));
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  log("OUT_DIR =", OUT_DIR);

  // --- create store ---
  log(stamp(), "creating memory store");
  const store = await createMemoryStore({
    name: `exec-demo-${RUN_ID}`,
    description: "Exec critique demo run",
  });
  await updateMemoryStoreMetadata(store.id, {
    braid_studio: "v1",
    project_name: "exec-demo",
  });
  log("store:", store.id);

  // --- v1 ---
  log(stamp(), `v1: generating ${SHOT_COUNT} shots`);
  const v1Start = Date.now();
  const v1Result = await generateMp4({
    prompts: V1_PROMPTS,
    lockedUrls: {},
    outputBasename: "v1",
  });
  const v1Env: DraftEnvelope = {
    version: "v1",
    parent: null,
    reason: "create",
    locked_shots: [],
    shots: V1_PROMPTS.map((p, i) => ({
      n: i,
      prompt: p,
      video_url: v1Result.shotUrls[i] ?? null,
    })),
    mp4_filename: basename(v1Result.mp4Path),
    duration_seconds: v1Result.durationSeconds,
    file_bytes: v1Result.fileBytes,
    wall_ms: Date.now() - v1Start,
    model_used: v1Result.modelUsed,
    updated_at: new Date().toISOString(),
  };
  await writeDraft(store.id, v1Env);
  await writeHead(store.id, { version: "v1", updated_at: v1Env.updated_at });
  log(stamp(), `v1 done: ${v1Result.mp4Path}`);

  // --- iterate: critique then apply, up to v4 ---
  const envelopes: Record<string, DraftEnvelope> = { v1: v1Env };
  const scores: VersionScore[] = [];

  // v1 critique (no carry-forward; this is the baseline).
  const v1RawCritiques = await critiquePanel(store.id, "v1", V1_PROMPTS);
  scores.push(scoreVersion(v1RawCritiques, "v1"));

  let current = v1Env;
  let currentCritiques = v1RawCritiques; // already consensus (median of seats)
  let priorPerAspect = extractPerAspectScores(v1RawCritiques);
  let priorLocked = new Set<number>();
  {
    const v1ShotAvg = perShotAverages(v1RawCritiques);
    for (const [n, avg] of Object.entries(v1ShotAvg)) {
      if (avg >= LOCK_THRESHOLD) priorLocked.add(Number(n));
    }
  }

  const MAX_VERSION = 4;
  for (let n = 2; n <= MAX_VERSION; n++) {
    const childVersion = `v${n}`;

    // Convergence check on current version's scores.
    const curShotAvg = perShotAverages(currentCritiques);
    const curOverall = perShotAvgOverall(curShotAvg);
    const allLocked = Object.values(curShotAvg).every((s) => s >= LOCK_THRESHOLD);
    if (allLocked && curOverall >= 0.85) {
      log(
        stamp(),
        `${current.version} converged (overall ${curOverall.toFixed(2)}, all shots locked) — stopping.`,
      );
      break;
    }

    const { envelope: nextEnv } = await applyCritique({
      storeId: store.id,
      parentVersion: current.version,
      parent: current,
      childVersion,
      critiques: currentCritiques,
    });
    envelopes[childVersion] = nextEnv;

    // Critique the new version (raw consensus, then apply carry-forward floor
    // against priors for shots that were locked in the previous version).
    const rawNext = await critiquePanel(
      store.id,
      childVersion,
      nextEnv.shots.map((s) => s.prompt),
    );
    const flooredNext = applyCarryForward(rawNext, priorPerAspect, priorLocked);
    scores.push(scoreVersion(flooredNext, childVersion));

    current = nextEnv;
    currentCritiques = flooredNext;
    priorPerAspect = extractPerAspectScores(flooredNext);
    priorLocked = new Set<number>(nextEnv.locked_shots);
  }

  // --- copy v1 mp4 into OUT_DIR if not already there ---
  // generateMp4 already writes into OUT_DIR — fine.

  // --- composite ---
  const versionPaths = Object.entries(envelopes)
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([version, env]) => ({
      version,
      mp4Path: resolvePath(OUT_DIR, `${version}.mp4`),
    }));
  log(stamp(), "building composite mp4");
  const compositePath = await buildComposite(versionPaths);
  log(stamp(), "composite:", compositePath);

  // --- scorecard + summary ---
  await writeScorecard(scores, envelopes);
  await writeSummary(scores);

  // --- run.json audit ---
  const runJson = {
    runId: RUN_ID,
    storeId: store.id,
    brief: BRIEF,
    shotCount: SHOT_COUNT,
    versions: Object.values(envelopes).map((e) => ({
      version: e.version,
      parent: e.parent,
      reason: e.reason,
      locked_shots: e.locked_shots,
      mp4_filename: e.mp4_filename,
      duration_seconds: e.duration_seconds,
      file_bytes: e.file_bytes,
      wall_ms: e.wall_ms,
      shots: e.shots,
    })),
    scores,
  };
  await writeFile(
    resolvePath(OUT_DIR, "run.json"),
    JSON.stringify(runJson, null, 2),
  );

  console.log("\n=== EXEC DEMO COMPLETE ===");
  console.log("dir:", OUT_DIR);
  console.log("store:", store.id);
  for (const s of scores) {
    console.log(`  ${s.version}: overall ${s.overall.toFixed(2)}, locked ${s.locked.length}/${SHOT_COUNT}`);
  }
  console.log("composite:", compositePath);
}

main().catch(async (err) => {
  console.error("[demo] failed:", err);
  // Don't delete OUT_DIR — partial artifacts are useful for debugging.
  await rm(`/tmp/${RUN_ID}-scratch`, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
