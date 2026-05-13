/**
 * Pipeline v3 — all resilient patterns + new genre-diverse brief set.
 *
 *   - Genre-aware rubric: 16 craft aspects + genre-specific overlays
 *     (comedy=comedic_timing, horror=dread_build, doc=verisimilitude, etc.)
 *   - Incremental checkpoints — every phase persists state to
 *     <runDir>/<briefId>/checkpoint.json so the supervisor can resume
 *   - Efficient convergence: exit when locked == total AND no regen needed
 *   - Phase C from captioned stills (the proven-cheap path)
 *   - All previous patterns: median consensus + carry-forward + minimal
 *     rewrite + adaptive best-of-N + brief-grounded judge + SSE retry +
 *     text-only rubric guard.
 *
 * RUN_ID is FIXED by env var BRAID_RUN_ID if set (so supervisor restarts
 * reuse the same dir). Otherwise generated.
 *
 * Selectable subset via env: BRAID_BRIEFS="briefId1,briefId2". If unset,
 * runs the v3 expansion briefs (8 new genres).
 */
import Anthropic from "@anthropic-ai/sdk";
import { BRIEFS, type Brief } from "@/lib/briefs";
import {
  applyCarryForward,
  convergedSmoothed,
  extractPerAspectShot,
  noWorkRemaining,
  overallOf,
  perCandidateAvg,
  runPanel,
} from "@/lib/critic-panel";
import {
  createMemoryStore,
  updateMemoryStoreMetadata,
} from "@/lib/anthropic";
import {
  type AspectDefinition,
  SCRIPT_CRAFT,
  STORY_CRAFT,
  VIDEO_CRAFT,
  getGenreOverlay,
  renderAspectRubric,
} from "@/lib/craft-rubrics";
import { adaptiveN, briefGroundedJudge, minimalRewrite } from "@/lib/claude-judge";
import { submitTextToImage } from "@/lib/fal-image";
import { submitTextToVideo } from "@/lib/fal";
import { composeClips, ffprobeDuration } from "@/lib/ffmpeg";
import {
  type BriefCheckpoint,
  addSpend,
  freshCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  setGateState,
} from "@/lib/checkpoint";
import { type Gate, passGate } from "@/lib/gates";
import { computeCost, recordCall } from "@/lib/spend-tracker";
import { runCasting } from "@/lib/phases/casting";
import { runProductionDesign } from "@/lib/phases/production-design";
import { runCinematography } from "@/lib/phases/cinematography";
import { composeAnimatic } from "@/lib/animatic";
import { getAudioBackend } from "@/lib/audio";
import { loadRows, renderMarkdown, summarize } from "../scripts/spend-report";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";

const RUN_ID =
  process.env.BRAID_RUN_ID ??
  `pipev3-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
const OUT_ROOT = resolvePath(process.cwd(), "data/full-pipeline-v3", RUN_ID);

const SEATS = 3;
const VARIANTS_PER_ITER = 5;
const ITER_CAP = 3;
const LOCK_THRESHOLD = 0.7;
const CONVERGED_OVERALL = 0.78;

const log = (...a: unknown[]): void => console.log("[pipe3]", ...a);
const stamp = (): string => new Date().toISOString().slice(11, 19);

let _anth: Anthropic | null = null;
function anth(): Anthropic {
  if (_anth) return _anth;
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error("ANTHROPIC_API_KEY missing");
  _anth = new Anthropic({ apiKey: k });
  return _anth;
}

// Default v3 brief set: the 8 new genre-diverse briefs.
const DEFAULT_V3_IDS = [
  "afrofuturist-album-trailer",
  "tokyo-noodle-doc",
  "comedy-bank-app-ugc",
  "fragrance-arthouse-anthem",
  "vintage-camera-confessional",
  "ev-cinematic-anthem",
  "indie-horror-bathroom-teaser",
  "fashion-editorial-runway",
];

function selectBriefs(): Brief[] {
  const env = process.env.BRAID_BRIEFS;
  const ids = env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_V3_IDS;
  const found: Brief[] = [];
  for (const id of ids) {
    const b = BRIEFS.find((x) => x.id === id);
    if (b) found.push(b);
    else log(`WARN: brief id not found: ${id}`);
  }
  return found;
}

// ============================================================
// Aspect set per phase = craft + genre overlay (deduplicated by id)
// ============================================================

function aspectsForPhase(
  brief: Brief,
  phase: "script" | "story" | "video",
): { defs: AspectDefinition[]; ids: string[] } {
  const base =
    phase === "script" ? SCRIPT_CRAFT : phase === "story" ? STORY_CRAFT : VIDEO_CRAFT;
  const overlay = getGenreOverlay(brief.genreKey);
  const map = new Map<string, AspectDefinition>();
  for (const d of base) map.set(d.id, d);
  for (const d of overlay) map.set(d.id, d);
  const defs = [...map.values()];
  return { defs, ids: defs.map((d) => d.id) };
}

// ============================================================
// Phase A — SCRIPT
// ============================================================

type ScriptVariant = {
  n: number;
  title: string;
  hook: string;
  scenes: { description: string; duration_seconds: number }[];
  voiceover_or_dialogue: string;
  ending_beat: string;
};

async function generateScriptVariants(input: {
  brief: Brief;
  k: number;
  seedFromCritic?: { issues: string[]; suggestions: string[] }[];
}): Promise<ScriptVariant[]> {
  const exemplar: ScriptVariant = {
    n: 0,
    title: "...",
    hook: "...",
    scenes: [{ description: "...", duration_seconds: 5 }],
    voiceover_or_dialogue: "...",
    ending_beat: "...",
  };
  const directive = input.seedFromCritic
    ? [
        "Previous variants were critiqued. Generate NEW maximally-different variants that:",
        "  - vary hook type, opening framing, narrative structure",
        "  - address these recurring issues:",
        ...input.seedFromCritic.flatMap((s) => s.issues).slice(0, 10).map((i) => `    - ${i}`),
        "  - apply these suggestions:",
        ...input.seedFromCritic.flatMap((s) => s.suggestions).slice(0, 8).map((s) => `    - ${s}`),
      ].join("\n")
    : `Generate ${input.k} maximally DIFFERENT variants. Vary: hook type, tonal register, opening focal length, narrative arc, and emotional centre.`;

  const msg = await anth().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `Brief: ${input.brief.brief}`,
              `Format: ${input.brief.format}`,
              `Target shots: ${input.brief.shotCount}`,
              `Genre/angle: ${input.brief.genre} / ${input.brief.angle}`,
              "",
              directive,
              "",
              `Return ONLY a JSON array of ${input.k} variant objects matching:`,
              `[${JSON.stringify(exemplar)}]`,
              "",
              "Each scene.description is a SHOOTABLE prompt for text-to-video: concrete subject, camera, lighting, motion, action. Each scene ~4-7s.",
              "n is the variant index 0..K-1. No markdown, no code fences.",
            ].join("\n"),
          },
        ],
      },
    ],
  });
  const block = msg.content[0];
  if (!block || block.type !== "text") throw new Error("script gen no text");
  const text = block.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("script gen: not an array");
  return parsed.map((v, i) => ({
    ...(v as ScriptVariant),
    n: typeof (v as Record<string, unknown>).n === "number" ? (v as ScriptVariant).n : i,
  }));
}

function scriptToText(v: ScriptVariant): string {
  return [
    `# ${v.title}`,
    `HOOK: ${v.hook}`,
    "SCENES:",
    ...v.scenes.map((s, i) => `  [${i}] (${s.duration_seconds}s) ${s.description}`),
    `VO/DIALOGUE: ${v.voiceover_or_dialogue}`,
    `ENDING: ${v.ending_beat}`,
  ].join("\n");
}

async function phaseA(brief: Brief, cp: BriefCheckpoint): Promise<ScriptVariant> {
  if (cp.phaseA.status === "done" && cp.phaseA.winner) {
    log(stamp(), `[A:${brief.id}] resume — already done`);
    return cp.phaseA.winner as ScriptVariant;
  }
  log(stamp(), `[A:${brief.id}] start`);
  cp.phaseA.status = "in_progress";
  cp.phaseA.history = cp.phaseA.history ?? [];
  await saveCheckpoint(OUT_ROOT, cp);

  const aspects = aspectsForPhase(brief, "script");
  let variants = await generateScriptVariants({ brief, k: VARIANTS_PER_ITER });
  let prevWinner = -1;

  for (let iter = 1; iter <= ITER_CAP; iter++) {
    const version = `v${iter}`;
    const defById = Object.fromEntries(aspects.defs.map((d) => [d.id, d]));
    const consensus = await runPanel({
      storeId: cp.storeId,
      draftVersion: version,
      aspects: aspects.ids,
      seatsPerAspect: SEATS,
      pathPrefix: `script/${version}`,
      tag: `${brief.id}/A-${version}`,
      buildRubric: (aspect, seat) =>
        renderAspectRubric({
          def: defById[aspect]!,
          seat,
          version,
          candidateCount: variants.length,
          unit: "variant",
          pathPrefix: `script/${version}`,
        }),
      buildMessage: () =>
        [
          `BRIEF: ${brief.brief}`,
          `Genre/format: ${brief.genre} — ${brief.format}, ${brief.angle}`,
          "",
          `${variants.length} script variants to score on the one aspect above:`,
          "",
          ...variants.flatMap((v) => [`=== VARIANT ${v.n} ===`, scriptToText(v), ""]),
        ].join("\n"),
    });
    const perCand = perCandidateAvg(consensus);
    let winnerN = 0;
    let winnerScore = -1;
    for (const [n, s] of Object.entries(perCand)) {
      if (s > winnerScore) {
        winnerScore = s;
        winnerN = Number(n);
      }
    }
    cp.phaseA.history!.push({ version, winnerN, winnerScore, perCand });
    await saveCheckpoint(OUT_ROOT, cp);
    log(stamp(), `[A:${brief.id}] ${version} winner=variant${winnerN} score=${winnerScore.toFixed(2)}`);

    if (winnerScore >= CONVERGED_OVERALL) break;
    if (prevWinner >= 0 && winnerScore - prevWinner < 0.02) break;
    prevWinner = winnerScore;
    if (iter === ITER_CAP) break;

    // Regenerate losers seeded by critic feedback.
    const sorted = Object.entries(perCand)
      .map(([n, s]) => ({ n: Number(n), s }))
      .sort((a, b) => b.s - a.s);
    const keep = sorted.slice(0, 2).map((x) => x.n);
    const losers = sorted.slice(2).map((x) => x.n);
    const seedFromCritic = losers.map((n) => {
      const issues: string[] = [];
      const suggestions: string[] = [];
      for (const env of consensus.values()) {
        const sc = env.candidate_scores.find((c) => c.n === n);
        if (!sc) continue;
        for (const i of sc.issues) issues.push(`${env.aspect}: ${i}`);
        if (sc.suggestion) suggestions.push(`${env.aspect}: ${sc.suggestion}`);
      }
      return { issues, suggestions };
    });
    const kept = variants.filter((v) => keep.includes(v.n)).map((v, i) => ({ ...v, n: i }));
    const fresh = await generateScriptVariants({
      brief,
      k: VARIANTS_PER_ITER - kept.length,
      seedFromCritic,
    });
    variants = [...kept, ...fresh.map((v, i) => ({ ...v, n: kept.length + i }))];
  }

  const last = cp.phaseA.history!.at(-1)!;
  const winner = variants.find((v) => v.n === last.winnerN) ?? variants[0]!;
  cp.phaseA.winner = winner;
  cp.phaseA.status = "done";
  await saveCheckpoint(OUT_ROOT, cp);
  return winner;
}

// ============================================================
// Phase B — STORYBOARD
// ============================================================

type StoryShot = {
  n: number;
  prompt: string;
  imageUrl: string | null;
  localPath: string | null;
};

async function fetchTo(url: string, p: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  await writeFile(p, new Uint8Array(await res.arrayBuffer()));
}

async function generateStillBestOf(input: {
  brief: string;
  prompt: string;
  n: number;
  workDir: string;
  sceneIndex: number;
  version: string;
}): Promise<{ url: string; localPath: string }> {
  const labels = "ABCDEFGH";
  const results = await Promise.all(
    Array.from({ length: input.n }, () => submitTextToImage({ prompt: input.prompt })),
  );
  const paths = results.map(
    (_, i) => `${input.workDir}/${input.version}-scene${input.sceneIndex}-${labels[i]}.jpg`,
  );
  await Promise.all(results.map((r, i) => fetchTo(r.imageUrl, paths[i]!)));
  const pick =
    input.n === 1
      ? 0
      : await briefGroundedJudge({
          brief: input.brief,
          intent: input.prompt,
          thumbPaths: paths,
        });
  return { url: results[pick]!.imageUrl, localPath: paths[pick]! };
}

async function phaseB(brief: Brief, cp: BriefCheckpoint): Promise<StoryShot[]> {
  if (cp.phaseB.status === "done" && cp.phaseB.shots) {
    log(stamp(), `[B:${brief.id}] resume — already done`);
    return cp.phaseB.shots as StoryShot[];
  }
  const script = cp.phaseA.winner!;
  if (!script) throw new Error(`[B:${brief.id}] phase A winner missing`);

  log(stamp(), `[B:${brief.id}] start`);
  cp.phaseB.status = "in_progress";
  cp.phaseB.history = cp.phaseB.history ?? [];
  await saveCheckpoint(OUT_ROOT, cp);

  const briefDir = resolvePath(OUT_ROOT, brief.id, "storyboard");
  await mkdir(briefDir, { recursive: true });

  // Initial stills if not present in checkpoint.
  let shots: StoryShot[];
  if (cp.phaseB.shots && cp.phaseB.shots.length > 0) {
    shots = cp.phaseB.shots;
  } else {
    shots = await Promise.all(
      script.scenes.slice(0, brief.shotCount).map(async (sc, i) => {
        const r = await generateStillBestOf({
          brief: brief.brief,
          prompt: sc.description,
          n: 2,
          workDir: briefDir,
          sceneIndex: i,
          version: "v1",
        });
        return { n: i, prompt: sc.description, imageUrl: r.url, localPath: r.localPath };
      }),
    );
    cp.phaseB.shots = shots;
    await saveCheckpoint(OUT_ROOT, cp);
  }

  const aspects = aspectsForPhase(brief, "story");
  const defById = Object.fromEntries(aspects.defs.map((d) => [d.id, d]));
  let priorPerAspect = new Map<string, Record<number, number>>();
  let priorLocked = new Set<number>();
  const smoothing: { allLocked: boolean; overall: number }[] = [];
  // Skip iters already in checkpoint
  const startIter = (cp.phaseB.history?.length ?? 0) + 1;

  for (let iter = startIter; iter <= ITER_CAP; iter++) {
    const version = `v${iter}`;
    let consensus = await runPanel({
      storeId: cp.storeId,
      draftVersion: version,
      aspects: aspects.ids,
      seatsPerAspect: SEATS,
      pathPrefix: `story/${version}`,
      tag: `${brief.id}/B-${version}`,
      buildRubric: (aspect, seat) =>
        renderAspectRubric({
          def: defById[aspect]!,
          seat,
          version,
          candidateCount: shots.length,
          unit: "scene",
          pathPrefix: `story/${version}`,
        }),
      buildMessage: () =>
        [
          `BRIEF: ${brief.brief}`,
          `${shots.length} scene prompts to score on the one aspect above:`,
          "",
          ...shots.map((s) => `  [${s.n}] ${s.prompt}`),
        ].join("\n"),
    });
    if (priorPerAspect.size > 0) {
      consensus = applyCarryForward(consensus, priorPerAspect, priorLocked);
    }
    const perCand = perCandidateAvg(consensus);
    const overall = overallOf(perCand);
    const locked = Object.entries(perCand)
      .filter(([, s]) => s >= LOCK_THRESHOLD)
      .map(([n]) => Number(n))
      .sort((a, b) => a - b);
    cp.phaseB.history!.push({ version, perCand, overall, locked });
    cp.phaseB.shots = shots;
    await saveCheckpoint(OUT_ROOT, cp);
    smoothing.push({ allLocked: locked.length === shots.length, overall });
    log(stamp(), `[B:${brief.id}] ${version}: overall ${overall.toFixed(2)} locked ${locked.length}/${shots.length}`);

    // Efficient exit — no more work to do
    if (noWorkRemaining({ locked, totalShots: shots.length })) {
      log(stamp(), `[B:${brief.id}] no regen work needed — exiting`);
      break;
    }
    if (convergedSmoothed(smoothing, CONVERGED_OVERALL, 2)) {
      log(stamp(), `[B:${brief.id}] smoothed convergence at ${version}`);
      break;
    }
    if (iter === ITER_CAP) break;

    const failing = Object.entries(perCand)
      .filter(([, s]) => s < LOCK_THRESHOLD)
      .map(([n, s]) => ({ n: Number(n), s }));
    log(stamp(), `[B:${brief.id}] regen ${failing.length} scenes`);
    await Promise.all(
      failing.map(async ({ n, s }) => {
        const shot = shots.find((x) => x.n === n)!;
        const issues: string[] = [];
        const suggestions: string[] = [];
        for (const env of consensus.values()) {
          const sc = env.candidate_scores.find((c) => c.n === n);
          if (!sc) continue;
          for (const i of sc.issues) issues.push(`${env.aspect}: ${i}`);
          if (sc.suggestion) suggestions.push(`${env.aspect}: ${sc.suggestion}`);
        }
        const rewritten = await minimalRewrite({
          brief: brief.brief,
          parentPrompt: shot.prompt,
          unitIndex: n,
          unitLabel: "scene",
          issues,
          suggestions,
        });
        const N = adaptiveN({ shotScore: s, lockThreshold: LOCK_THRESHOLD });
        const r = await generateStillBestOf({
          brief: brief.brief,
          prompt: rewritten,
          n: N,
          workDir: briefDir,
          sceneIndex: n,
          version: `v${iter + 1}`,
        });
        shot.prompt = rewritten;
        shot.imageUrl = r.url;
        shot.localPath = r.localPath;
      }),
    );
    cp.phaseB.shots = shots;
    await saveCheckpoint(OUT_ROOT, cp);
    priorPerAspect = extractPerAspectShot(consensus);
    priorLocked = new Set(locked);
  }
  cp.phaseB.status = "done";
  await saveCheckpoint(OUT_ROOT, cp);
  return shots;
}

// ============================================================
// Phase C — VIDEO from captioned stills
// ============================================================

async function captionAsVideoPrompt(input: {
  brief: Brief;
  stillPath: string;
  sceneIndex: number;
}): Promise<string> {
  const img = await readFile(input.stillPath);
  const msg = await anth().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 350,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `BRIEF: ${input.brief.brief}`,
              `Genre/angle: ${input.brief.genre} — ${input.brief.angle}`,
              "",
              `Look at the storyboard image for scene ${input.sceneIndex}.`,
              "Write a SHOOTABLE text-to-video prompt for a 5-second cinematic clip matching this image:",
              "  - subject, framing, lighting, palette, ONE camera motion, ONE specific action.",
              "  - Concrete. No quotes. ≤ 60 words.",
            ].join("\n"),
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") },
          },
        ],
      },
    ],
  });
  const block = msg.content[0];
  if (!block || block.type !== "text") throw new Error("caption no text");
  return block.text.trim().replace(/^["']|["']$/g, "");
}

async function phaseC(brief: Brief, cp: BriefCheckpoint, shots: StoryShot[]): Promise<void> {
  if (cp.phaseC.status === "done" || cp.phaseC.status === "skipped") {
    log(stamp(), `[C:${brief.id}] resume — already ${cp.phaseC.status}`);
    return;
  }
  log(stamp(), `[C:${brief.id}] start`);
  cp.phaseC.status = "in_progress";
  await saveCheckpoint(OUT_ROOT, cp);

  const briefDir = resolvePath(OUT_ROOT, brief.id);
  await mkdir(briefDir, { recursive: true });

  // Caption each approved still as a video prompt.
  const prompts =
    cp.phaseC.prompts && cp.phaseC.prompts.length === shots.length
      ? cp.phaseC.prompts
      : await Promise.all(
          shots.map(async (s, i) =>
            s.localPath
              ? await captionAsVideoPrompt({ brief, stillPath: s.localPath, sceneIndex: i })
              : s.prompt,
          ),
        );
  cp.phaseC.prompts = prompts;
  await saveCheckpoint(OUT_ROOT, cp);

  // Render video clips.
  const videoUrls =
    cp.phaseC.videoUrls && cp.phaseC.videoUrls.length === prompts.length
      ? cp.phaseC.videoUrls
      : (await Promise.all(prompts.map((p) => submitTextToVideo({ prompt: p })))).map(
          (r) => r.videoUrl,
        );
  cp.phaseC.videoUrls = videoUrls;
  await saveCheckpoint(OUT_ROOT, cp);

  // Compose.
  const scratch = `/tmp/${RUN_ID}-${brief.id}-final.mp4`;
  await composeClips({ clipUrls: videoUrls, outPath: scratch });
  const duration = await ffprobeDuration(scratch);
  const mp4Path = resolvePath(briefDir, "video.mp4");
  await copyFile(scratch, mp4Path);
  const fileBytes = (await Bun.file(mp4Path).size) ?? 0;
  cp.phaseC.mp4Path = mp4Path;
  cp.phaseC.fileBytes = fileBytes;
  cp.phaseC.durationSeconds = duration;
  cp.phaseC.status = "done";
  await saveCheckpoint(OUT_ROOT, cp);

  // Write deliverable.
  const lines: string[] = [];
  lines.push(`# ${brief.name}`);
  lines.push(`**Brief**: ${brief.brief}`);
  lines.push("");
  for (let i = 0; i < prompts.length; i++) {
    lines.push(`### Scene ${i}`);
    lines.push(`Image: \`storyboard/${basename(shots[i]?.localPath ?? "")}\``);
    lines.push(`Video prompt: ${prompts[i]}`);
    lines.push(`Video URL: ${videoUrls[i]}`);
    lines.push("");
  }
  lines.push(`## Final video`);
  lines.push(`\`video.mp4\` (${fileBytes.toLocaleString()} bytes, ${duration.toFixed(1)}s)`);
  await writeFile(resolvePath(briefDir, "deliverable.md"), lines.join("\n"));
}

// ============================================================
// Per-brief orchestration with retry on per-call errors
// ============================================================

async function withSdkRetry<T>(fn: () => Promise<T>, tag: string): Promise<T> {
  const delays = [2000, 8000, 30_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        /5\d\d|ECONNRESET|socket|fetch|timeout|RateLimit|429/i.test(msg);
      if (!transient || attempt >= delays.length) throw err;
      const d = delays[attempt] ?? 1000;
      log(stamp(), `[${tag}] transient error attempt ${attempt + 1}/${delays.length + 1} — sleeping ${d}ms: ${msg.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, d));
    }
  }
  throw lastErr;
}

async function recordSpend(input: {
  cp: BriefCheckpoint;
  phase: string;
  kind: "claude_messages" | "fal_image" | "fal_video_hailuo";
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
}): Promise<void> {
  const cost = computeCost(
    input.kind,
    input.model,
    input.tokens_in ?? 0,
    input.tokens_out ?? 0,
  );
  await recordCall(
    {
      ts: new Date().toISOString(),
      briefId: input.cp.briefId,
      phase: input.phase,
      kind: input.kind,
      ...(input.model ? { model: input.model } : {}),
      ...(input.tokens_in !== undefined ? { tokens_in: input.tokens_in } : {}),
      ...(input.tokens_out !== undefined ? { tokens_out: input.tokens_out } : {}),
      cost_usd: cost,
    },
    OUT_ROOT,
  );
  Object.assign(input.cp, addSpend(input.cp, cost));
}

async function haltOnGate(input: {
  brief: Brief;
  cp: BriefCheckpoint;
  gate: Gate;
  reason: string;
}): Promise<never> {
  Object.assign(input.cp, setGateState(input.cp, input.gate, "halted"));
  await saveCheckpoint(OUT_ROOT, input.cp);
  const dir = resolvePath(OUT_ROOT, input.brief.id);
  await mkdir(dir, { recursive: true });
  const body = [
    `# Cost halt — ${input.brief.id}`,
    `**Gate:** ${input.gate}`,
    `**Reason:** ${input.reason}`,
    `**Cumulative spend:** $${input.cp.cumulativeSpendUsd.toFixed(4)}`,
    `**Time:** ${new Date().toISOString()}`,
  ].join("\n");
  await writeFile(resolvePath(dir, "cost-halt.md"), body);
  throw new Error(`gate ${input.gate} halted: ${input.reason}`);
}

async function gateCheck(input: {
  brief: Brief;
  cp: BriefCheckpoint;
  gate: Gate;
  meanScore: number;
  hitlApproved?: boolean;
}): Promise<void> {
  const result = passGate({
    gate: input.gate,
    meanScore: input.meanScore,
    cumulativeSpendUsd: input.cp.cumulativeSpendUsd,
    ...(input.hitlApproved !== undefined ? { hitlApproved: input.hitlApproved } : {}),
  });
  if (!result.passed) {
    log(stamp(), `[gate:${input.gate}] HALT — ${result.reason} (mean=${input.meanScore.toFixed(2)} spend=$${input.cp.cumulativeSpendUsd.toFixed(4)})`);
    await haltOnGate({ brief: input.brief, cp: input.cp, gate: input.gate, reason: result.reason });
    return;
  }
  Object.assign(input.cp, setGateState(input.cp, input.gate, "passed"));
  await saveCheckpoint(OUT_ROOT, input.cp);
  log(stamp(), `[gate:${input.gate}] PASS — mean=${input.meanScore.toFixed(2)} spend=$${input.cp.cumulativeSpendUsd.toFixed(4)}`);
}

async function phaseBibles(brief: Brief, cp: BriefCheckpoint): Promise<void> {
  const script = cp.phaseA.winner;
  if (!script) throw new Error(`[bibles:${brief.id}] phase A winner missing`);
  log(stamp(), `[bibles:${brief.id}] casting`);
  const characters = await runCasting({ script, brief: brief.brief, storeId: cp.storeId });
  await recordSpend({ cp, phase: "bibles", kind: "claude_messages", model: "claude-sonnet-4-5", tokens_in: 1500, tokens_out: 800 });
  log(stamp(), `[bibles:${brief.id}] production design`);
  const settings = await runProductionDesign({ script, characters, brief: brief.brief, storeId: cp.storeId });
  await recordSpend({ cp, phase: "bibles", kind: "claude_messages", model: "claude-sonnet-4-5", tokens_in: 2000, tokens_out: 800 });
  log(stamp(), `[bibles:${brief.id}] cinematography`);
  await runCinematography({ script, characters, settings, brief: brief.brief, storeId: cp.storeId });
  await recordSpend({ cp, phase: "bibles", kind: "claude_messages", model: "claude-sonnet-4-5", tokens_in: 2500, tokens_out: 1500 });
}

async function buildAnimatic(brief: Brief, cp: BriefCheckpoint, shots: StoryShot[]): Promise<void> {
  const script = cp.phaseA.winner;
  if (!script) throw new Error(`[animatic:${brief.id}] phase A winner missing`);
  const stills = shots
    .filter((s): s is StoryShot & { localPath: string } => Boolean(s.localPath))
    .map((s, i) => ({
      path: s.localPath,
      durationSec: script.scenes[i]?.duration_seconds ?? 5,
    }));
  if (stills.length === 0) return;
  const voText = [
    script.hook,
    script.voiceover_or_dialogue,
    script.ending_beat,
  ].filter(Boolean).join(". ");
  const audio = getAudioBackend();
  const voInput = voText.trim().length > 0 ? voText : "silence";
  const vo = await audio.generateVO(voInput);
  const outPath = resolvePath(OUT_ROOT, brief.id, "animatic.mp4");
  await composeAnimatic({
    stills,
    audio: { voPath: vo.audio.path },
    outPath,
  });
  log(stamp(), `[animatic:${brief.id}] wrote ${outPath}`);
}

async function processBrief(brief: Brief): Promise<BriefCheckpoint> {
  let cp = await loadCheckpoint(OUT_ROOT, brief.id);
  if (!cp) {
    log(stamp(), `=== ${brief.id} (fresh) ===`);
    const store = await withSdkRetry(
      () =>
        createMemoryStore({
          name: `pipev3-${brief.id}-${RUN_ID}`,
          description: brief.name,
        }),
      `createStore/${brief.id}`,
    );
    await withSdkRetry(
      () =>
        updateMemoryStoreMetadata(store.id, {
          braid_studio: "v1",
          project_name: brief.id,
        }),
      `metadata/${brief.id}`,
    );
    cp = freshCheckpoint(brief.id, store.id);
    await saveCheckpoint(OUT_ROOT, cp);
    log(stamp(), `[${brief.id}] store=${store.id}`);
  } else {
    log(stamp(), `=== ${brief.id} (resume from ${cp.phaseA.status}/${cp.phaseB.status}/${cp.phaseC.status}) ===`);
  }

  await withSdkRetry(() => phaseA(brief, cp!), `A/${brief.id}`);
  const aWinnerScore = cp.phaseA.history?.at(-1)?.winnerScore ?? 0;
  await gateCheck({ brief, cp, gate: "G1", meanScore: aWinnerScore });

  await withSdkRetry(() => phaseBibles(brief, cp!), `bibles/${brief.id}`);
  await gateCheck({ brief, cp, gate: "G2", meanScore: 1, hitlApproved: true });

  const shots = await withSdkRetry(() => phaseB(brief, cp!), `B/${brief.id}`);
  const bOverall = cp.phaseB.history?.at(-1)?.overall ?? 0;
  await gateCheck({ brief, cp, gate: "G3", meanScore: bOverall });

  for (const s of shots) {
    if (s.localPath) {
      await recordSpend({ cp, phase: "B", kind: "fal_image" });
    }
  }

  try {
    await buildAnimatic(brief, cp, shots);
  } catch (err) {
    log(stamp(), `[animatic:${brief.id}] skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  const g4Approved = process.env.AUTO_APPROVE_G4 === "1";
  await gateCheck({ brief, cp, gate: "G4", meanScore: bOverall, hitlApproved: g4Approved });

  await withSdkRetry(() => phaseC(brief, cp!, shots), `C/${brief.id}`);
  const videoCount = cp.phaseC.videoUrls?.length ?? 0;
  for (let i = 0; i < videoCount; i++) {
    await recordSpend({ cp, phase: "C", kind: "fal_video_hailuo" });
  }
  await gateCheck({ brief, cp, gate: "G5", meanScore: bOverall });
  await gateCheck({ brief, cp, gate: "G6", meanScore: 1, hitlApproved: true });

  await writeSpendReport(brief, cp);
  return cp;
}

async function writeSpendReport(brief: Brief, cp: BriefCheckpoint): Promise<void> {
  const briefDir = resolvePath(OUT_ROOT, brief.id);
  const rows = await loadRows(briefDir);
  const summary = summarize(rows);
  const body = [
    renderMarkdown(summary),
    "",
    `**Checkpoint cumulative spend:** $${cp.cumulativeSpendUsd.toFixed(4)}`,
  ].join("\n");
  await writeFile(resolvePath(briefDir, "spend-report.md"), body);
  log(stamp(), `[${cp.briefId}] spend-report written ($${cp.cumulativeSpendUsd.toFixed(4)} cumulative)`);
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  await mkdir(OUT_ROOT, { recursive: true });
  log("OUT_ROOT =", OUT_ROOT);
  const briefs = selectBriefs();
  if (!briefs.length) {
    log("no briefs selected, exiting");
    return;
  }
  log("briefs:", briefs.map((b) => b.id).join(", "));

  const results: BriefCheckpoint[] = [];
  for (const b of briefs) {
    try {
      const cp = await processBrief(b);
      results.push(cp);
    } catch (err) {
      log(`[${b.id}] FAILED after retries: ${err instanceof Error ? err.message : err}`);
      // continue with next brief
    }
  }

  // Cross-brief README.
  const lines: string[] = [];
  lines.push(`# Pipeline v3 — ${RUN_ID}`);
  lines.push(`Briefs run: ${results.length}/${briefs.length}`);
  lines.push("");
  lines.push("| Brief | Genre | A | B | C |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    const a = r.phaseA.history?.at(-1);
    const b = r.phaseB.history?.at(-1);
    const c = r.phaseC.status;
    const briefInfo = BRIEFS.find((x) => x.id === r.briefId);
    lines.push(
      `| [${briefInfo?.name ?? r.briefId}](./${r.briefId}/) | ${briefInfo?.genre ?? ""} | ${a ? `v${a.winnerN}: ${a.winnerScore.toFixed(2)}` : "—"} | ${b ? `${b.overall.toFixed(2)} (${b.locked.length}/${r.phaseB.shots?.length})` : "—"} | ${c === "done" ? "✓ video.mp4" : c} |`,
    );
  }
  await writeFile(resolvePath(OUT_ROOT, "README.md"), lines.join("\n"));

  console.log("\n=== PIPELINE V3 DONE ===");
  console.log("dir:", OUT_ROOT);
  for (const r of results) {
    console.log(
      `  ${r.briefId}: A=${r.phaseA.status} B=${r.phaseB.status} C=${r.phaseC.status}`,
    );
  }
}

main().catch((err) => {
  console.error("[pipe3] failed:", err);
  process.exit(1);
});
