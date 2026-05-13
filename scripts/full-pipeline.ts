/**
 * Full three-phase Managed-Agent pipeline.
 *
 *   For each brief in BRIEFS:
 *     PHASE A — Script: generate N variants with Claude; critic panel scores them
 *               (hook/arc/brand-fit/pacing/surprise/dialogue); iterate up to 3 times
 *               keeping winners and regenerating losers. Pick the highest-scored.
 *     PHASE B — Storyboard: parse approved script into N scenes; generate Flux schnell
 *               stills; critic panel scores scene PROMPTS (composition/color/continuity/
 *               mood/variety/brand); iterate with prompt rewrites + best-of-N visual
 *               picks for failing scenes. Up to 3 iterations.
 *
 *   For top 2 briefs by Phase B overall:
 *     PHASE C — Video: render text-to-video for approved scene prompts; critic panel
 *               scores motion/pacing/transition/continuity; iterate up to 3 times.
 *               Compose final mp4.
 *
 *   Deliverable per brief in data/full-pipeline/<runId>/<brief.id>/:
 *     script.md (winning script + scores per iteration)
 *     storyboard.md (scene prompts + still URLs/paths + scores)
 *     v{N}.mp4 (top winners only)
 *     scorecard.md
 *
 *   Cross-brief leaderboard at data/full-pipeline/<runId>/README.md.
 */
import Anthropic from "@anthropic-ai/sdk";
import { BRIEFS, type Brief } from "@/lib/briefs";
import {
  applyCarryForward,
  extractPerAspectShot,
  loadConsensus,
  overallOf,
  perCandidateAvg,
  runPanel,
} from "@/lib/critic-panel";
import { createMemoryStore, updateMemoryStoreMetadata } from "@/lib/anthropic";
import { submitTextToImage } from "@/lib/fal-image";
import { submitTextToVideo } from "@/lib/fal";
import { composeClips, ffprobeDuration } from "@/lib/ffmpeg";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";

const RUN_ID = `pipe-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
const OUT_ROOT = resolvePath(process.cwd(), "data/full-pipeline", RUN_ID);

const SCRIPT_ASPECTS = ["hook", "arc", "brand_fit", "pacing_intent", "surprise", "dialogue"] as const;
const STORY_ASPECTS = ["composition", "color", "subject_continuity", "mood", "shot_variety", "brand_alignment"] as const;
const VIDEO_ASPECTS = ["motion_quality", "pacing", "transition", "continuity"] as const;

type ScriptAspect = (typeof SCRIPT_ASPECTS)[number];
type StoryAspect = (typeof STORY_ASPECTS)[number];
type VideoAspect = (typeof VIDEO_ASPECTS)[number];

const SEATS = 3;
const VARIANTS_PER_ITER = 5;
const ITER_CAP = 3;
const LOCK_THRESHOLD = 0.7;
const CONVERGED_THRESHOLD = 0.8;

const log = (...a: unknown[]): void => console.log("[pipe]", ...a);
const stamp = (): string => new Date().toISOString().slice(11, 19);

let _client: Anthropic | null = null;
function anth(): Anthropic {
  if (_client) return _client;
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error("ANTHROPIC_API_KEY");
  _client = new Anthropic({ apiKey: k });
  return _client;
}

async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    const t = opts.timeoutMs
      ? setTimeout(() => {
          p.kill("SIGKILL");
          reject(new Error("timeout"));
        }, opts.timeoutMs)
      : null;
    p.on("close", (c) => {
      if (t) clearTimeout(t);
      resolve({ code: c ?? 1, stderr });
    });
    p.on("error", reject);
  });
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
  seedFromCritic?: { variant: ScriptVariant; issues: string[]; suggestions: string[] }[];
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
        "Previous variants were critiqued. Generate NEW variants that take wildly different angles. For each new variant:",
        "  - Differ in tone, opening shot type, and narrative structure",
        "  - Address these recurring critic issues:",
        ...input.seedFromCritic
          .flatMap((s) => s.issues)
          .slice(0, 10)
          .map((i) => `    - ${i}`),
        "  - Apply these suggestions:",
        ...input.seedFromCritic
          .flatMap((s) => s.suggestions)
          .slice(0, 8)
          .map((s) => `    - ${s}`),
      ].join("\n")
    : `Generate ${input.k} maximally DIFFERENT variants. Vary: hook type (in-medias-res / VO / silent), tonal register, opening shot, narrative arc.`;

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
              `Return ONLY a JSON array of ${input.k} variant objects matching this exact shape (do not include code fences):`,
              `[${JSON.stringify(exemplar)}]`,
              "",
              "Rules:",
              `  - exactly ${input.brief.shotCount} scenes per variant`,
              "  - each scene.description is a SHOOTABLE prompt for a text-to-video model: setting, subject, camera motion, lighting, action",
              "  - n is the variant index 0..K-1",
              "  - do NOT add commentary or markdown",
            ].join("\n"),
          },
        ],
      },
    ],
  });
  const block = msg.content[0];
  if (!block || block.type !== "text") throw new Error("script gen: no text");
  const text = block.text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log("script gen raw:", text.slice(0, 500));
    throw new Error(`script gen: invalid JSON: ${err}`);
  }
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
    "",
    "SCENES:",
    ...v.scenes.map((s, i) => `  [${i}] (${s.duration_seconds}s) ${s.description}`),
    "",
    `VO/DIALOGUE: ${v.voiceover_or_dialogue}`,
    `ENDING: ${v.ending_beat}`,
  ].join("\n");
}

function buildScriptRubric(aspect: ScriptAspect, seat: number, version: string): string {
  return [
    `You are CRITIC SEAT ${seat} on the "${aspect}" panel for AD-SCRIPT evaluation.`,
    `${VARIANTS_PER_ITER} script variants will be shown. Score each variant 0.0-1.0 on ${aspect}.`,
    "",
    "OUTPUT PROTOCOL.",
    "STEP 0: `bash` `ls /mnt/memory/` to find STORE_DIR.",
    `STEP 1: write EXACTLY ONE file at /mnt/memory/$STORE_DIR/memory/critiques/script/${version}/${aspect}-seat${seat}.json`,
    "",
    "JSON shape (no markdown, no commentary, must start with `{` end with `}`):",
    "{",
    `  "version": "c-${aspect}-${version}-seat${seat}",`,
    `  "parent_draft": "${version}",`,
    `  "aspect": "${aspect}",`,
    '  "candidate_scores": [',
    ...Array.from(
      { length: VARIANTS_PER_ITER },
      (_, i) => `    { "n": ${i}, "score": 0.0, "issues": ["..."], "suggestion": "minimal targeted fix" }${i < VARIANTS_PER_ITER - 1 ? "," : ""}`,
    ),
    "  ],",
    '  "overall": 0.0,',
    `  "summary": "one short sentence",`,
    '  "created_at": "<ISO>"',
    "}",
    "",
    "Rules:",
    "  - score honestly, baseline 0.6-0.8",
    `  - When done, emit \`DONE ${aspect} seat ${seat}\` and end turn.`,
  ].join("\n");
}

function buildScriptMessage(brief: Brief, variants: ScriptVariant[]): string {
  return [
    `BRIEF: ${brief.brief}`,
    `Genre/format: ${brief.genre} — ${brief.format}, ${brief.angle}`,
    "",
    `${variants.length} script variants to score:`,
    "",
    ...variants.flatMap((v) => [`=== VARIANT ${v.n} ===`, scriptToText(v), ""]),
  ].join("\n");
}

async function phaseA(brief: Brief, storeId: string): Promise<{
  winner: ScriptVariant;
  history: { version: string; winnerN: number; winnerOverall: number; perCand: Record<number, number> }[];
}> {
  log(stamp(), `[A:${brief.id}] start`);
  let variants = await generateScriptVariants({ brief, k: VARIANTS_PER_ITER });
  log(stamp(), `[A:${brief.id}] v1: ${variants.length} variants generated`);

  const history: { version: string; winnerN: number; winnerOverall: number; perCand: Record<number, number> }[] = [];
  let prevWinnerOverall = -1;

  for (let iter = 1; iter <= ITER_CAP; iter++) {
    const version = `v${iter}`;
    const consensus = await runPanel<ScriptAspect>({
      storeId,
      draftVersion: version,
      aspects: SCRIPT_ASPECTS,
      seatsPerAspect: SEATS,
      pathPrefix: `script/${version}`,
      tag: `${brief.id}/A-${version}`,
      buildRubric: (a, s) => buildScriptRubric(a, s, version),
      buildMessage: () => buildScriptMessage(brief, variants),
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
    history.push({ version, winnerN, winnerOverall: winnerScore, perCand });
    log(stamp(), `[A:${brief.id}] ${version} winner=variant${winnerN} score=${winnerScore.toFixed(2)} (per-variant: ${JSON.stringify(perCand)})`);

    // Convergence: ≥ threshold OR plateau (delta <= 0.02)
    if (winnerScore >= CONVERGED_THRESHOLD) {
      log(stamp(), `[A:${brief.id}] converged at ${version}`);
      const winner = variants.find((v) => v.n === winnerN) ?? variants[0]!;
      return { winner, history };
    }
    if (prevWinnerOverall >= 0 && winnerScore - prevWinnerOverall < 0.02) {
      log(stamp(), `[A:${brief.id}] plateau at ${version} — stopping`);
      const winner = variants.find((v) => v.n === winnerN) ?? variants[0]!;
      return { winner, history };
    }
    prevWinnerOverall = winnerScore;

    if (iter === ITER_CAP) break;

    // Regenerate: keep top-2, generate 3 new variants seeded by critic feedback.
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
      const variant = variants.find((v) => v.n === n)!;
      return { variant, issues, suggestions };
    });
    const kept = variants.filter((v) => keep.includes(v.n)).map((v, i) => ({ ...v, n: i }));
    const fresh = await generateScriptVariants({
      brief,
      k: VARIANTS_PER_ITER - kept.length,
      seedFromCritic,
    });
    variants = [...kept, ...fresh.map((v, i) => ({ ...v, n: kept.length + i }))];
  }
  const finalScores = history[history.length - 1]!;
  const winner = variants.find((v) => v.n === finalScores.winnerN) ?? variants[0]!;
  return { winner, history };
}

// ============================================================
// Phase B — STORYBOARD (stills)
// ============================================================

type StoryShot = {
  n: number;
  prompt: string;
  imageUrl: string | null;
  localPath: string | null;
  locked: boolean;
};

function buildStoryRubric(
  aspect: StoryAspect,
  seat: number,
  version: string,
  brief: Brief,
): string {
  return [
    `You are CRITIC SEAT ${seat} on the "${aspect}" panel for an AD STORYBOARD.`,
    `${brief.shotCount} scene prompts will be shown. Score each scene's PROMPT 0.0-1.0 on ${aspect}.`,
    `Brief: ${brief.brief.slice(0, 300)}...`,
    "",
    "OUTPUT PROTOCOL.",
    "STEP 0: `bash` `ls /mnt/memory/` to find STORE_DIR.",
    `STEP 1: write to /mnt/memory/$STORE_DIR/memory/critiques/story/${version}/${aspect}-seat${seat}.json`,
    "",
    "JSON shape:",
    "{",
    `  "version": "c-${aspect}-${version}-seat${seat}",`,
    `  "parent_draft": "${version}",`,
    `  "aspect": "${aspect}",`,
    '  "candidate_scores": [',
    ...Array.from(
      { length: brief.shotCount },
      (_, i) => `    { "n": ${i}, "score": 0.0, "issues": ["..."], "suggestion": "minimal targeted fix to scene prompt" }${i < brief.shotCount - 1 ? "," : ""}`,
    ),
    "  ],",
    '  "overall": 0.0,',
    '  "summary": "...",',
    '  "created_at": "<ISO>"',
    "}",
    "",
    `Rules: candidate_scores has exactly ${brief.shotCount} entries; honest scoring; minimal targeted suggestions; emit \`DONE ${aspect} seat ${seat}\` to end.`,
  ].join("\n");
}

function buildStoryMessage(brief: Brief, shots: StoryShot[]): string {
  return [
    `BRIEF: ${brief.brief}`,
    `Genre/format: ${brief.genre} — ${brief.format}, ${brief.angle}`,
    "",
    `${shots.length} scene prompts to score:`,
    "",
    ...shots.map((s) => `  [${s.n}] ${s.prompt}`),
  ].join("\n");
}

async function rewriteScenePrompt(input: {
  brief: Brief;
  parentPrompt: string;
  sceneIndex: number;
  issues: string[];
  suggestions: string[];
}): Promise<string> {
  const msg = await anth().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `BRIEF: ${input.brief.brief}`,
              `Original scene ${input.sceneIndex} prompt: "${input.parentPrompt}"`,
              "",
              "Critics flagged:",
              ...input.issues.slice(0, 10).map((i) => `  - ${i}`),
              "",
              "Suggestions:",
              ...input.suggestions.slice(0, 8).map((s) => `  - ${s}`),
              "",
              "MINIMAL TARGETED REWRITE: preserve subject/scene/era; change at most 1-2 attributes (camera, lighting, color, composition). No new subjects.",
              "Output ONLY the new prompt, one paragraph, no labels.",
            ].join("\n"),
          },
        ],
      },
    ],
  });
  const block = msg.content[0];
  if (!block || block.type !== "text") throw new Error("rewrite: no text");
  return block.text.trim().replace(/^["']|["']$/g, "");
}

async function fetchTo(url: string, p: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await writeFile(p, buf);
}

async function judgeBestImage(input: {
  brief: string;
  originalPrompt: string;
  paths: string[];
}): Promise<number> {
  const labels = "ABCDEFGH";
  const imgs = await Promise.all(input.paths.map((p) => readFile(p)));
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }
  > = [
    {
      type: "text",
      text: [
        "Pick the candidate that BEST serves the brief:",
        `BRIEF: ${input.brief}`,
        `Scene intent: ${input.originalPrompt}`,
        `${input.paths.length} candidates labelled ${labels.slice(0, input.paths.length).split("").join(", ")}.`,
        `Reply with exactly one character: ${labels.slice(0, input.paths.length).split("").join(" or ")}.`,
      ].join("\n"),
    },
  ];
  for (const img of imgs) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") },
    });
  }
  const msg = await anth().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 50,
    messages: [{ role: "user", content }],
  });
  const t = msg.content[0]?.type === "text" ? msg.content[0].text.trim().toUpperCase() : "A";
  const idx = labels.indexOf(t[0] ?? "A");
  return idx >= 0 && idx < input.paths.length ? idx : 0;
}

async function generateStillBestOf(input: {
  brief: string;
  prompt: string;
  n: number;
  workDir: string;
  sceneIndex: number;
}): Promise<{ url: string; localPath: string }> {
  const results = await Promise.all(
    Array.from({ length: input.n }, () => submitTextToImage({ prompt: input.prompt })),
  );
  const labels = "ABCDEFGH";
  const paths = results.map(
    (_, i) => `${input.workDir}/scene${input.sceneIndex}-${labels[i]}.jpg`,
  );
  await Promise.all(results.map((r, i) => fetchTo(r.imageUrl, paths[i]!)));
  const pick = input.n === 1 ? 0 : await judgeBestImage({
    brief: input.brief,
    originalPrompt: input.prompt,
    paths,
  });
  return { url: results[pick]!.imageUrl, localPath: paths[pick]! };
}

async function phaseB(brief: Brief, script: ScriptVariant, storeId: string): Promise<{
  shots: StoryShot[];
  history: { version: string; perCand: Record<number, number>; overall: number; locked: number[] }[];
}> {
  log(stamp(), `[B:${brief.id}] start`);
  const briefDir = resolvePath(OUT_ROOT, brief.id, "storyboard");
  await mkdir(briefDir, { recursive: true });

  // v1: render fresh stills from script scene prompts.
  let shots: StoryShot[] = await Promise.all(
    script.scenes.slice(0, brief.shotCount).map(async (sc, i) => {
      const stillRes = await generateStillBestOf({
        brief: brief.brief,
        prompt: sc.description,
        n: 2,
        workDir: briefDir,
        sceneIndex: i,
      });
      // promote winner to a stable name v1
      const stablePath = resolvePath(briefDir, `v1-scene${i}.jpg`);
      await copyFile(stillRes.localPath, stablePath);
      return {
        n: i,
        prompt: sc.description,
        imageUrl: stillRes.url,
        localPath: stablePath,
        locked: false,
      };
    }),
  );
  log(stamp(), `[B:${brief.id}] v1: ${shots.length} stills generated`);

  const history: { version: string; perCand: Record<number, number>; overall: number; locked: number[] }[] = [];
  let priorPerAspect = new Map<string, Record<number, number>>();
  let priorLocked = new Set<number>();

  for (let iter = 1; iter <= ITER_CAP; iter++) {
    const version = `v${iter}`;
    let consensus = await runPanel<StoryAspect>({
      storeId,
      draftVersion: version,
      aspects: STORY_ASPECTS,
      seatsPerAspect: SEATS,
      pathPrefix: `story/${version}`,
      tag: `${brief.id}/B-${version}`,
      buildRubric: (a, s) => buildStoryRubric(a, s, version, brief),
      buildMessage: () => buildStoryMessage(brief, shots),
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
    history.push({ version, perCand, overall, locked });
    log(stamp(), `[B:${brief.id}] ${version}: overall ${overall.toFixed(2)}, locked ${locked.length}/${shots.length}`);

    if (locked.length === shots.length && overall >= CONVERGED_THRESHOLD) {
      log(stamp(), `[B:${brief.id}] converged at ${version}`);
      shots = shots.map((s) => ({ ...s, locked: true }));
      break;
    }
    if (iter === ITER_CAP) break;

    // Regen failing: rewrite prompt + best-of-2 still.
    const failing = Object.entries(perCand)
      .filter(([, s]) => s < LOCK_THRESHOLD)
      .map(([n]) => Number(n));
    log(stamp(), `[B:${brief.id}] ${version}→v${iter + 1}: regen scenes [${failing.join(",")}]`);
    await Promise.all(
      failing.map(async (n) => {
        const shot = shots.find((x) => x.n === n)!;
        const issues: string[] = [];
        const suggestions: string[] = [];
        for (const env of consensus.values()) {
          const sc = env.candidate_scores.find((c) => c.n === n);
          if (!sc) continue;
          for (const i of sc.issues) issues.push(`${env.aspect}: ${i}`);
          if (sc.suggestion) suggestions.push(`${env.aspect}: ${sc.suggestion}`);
        }
        const rewritten = await rewriteScenePrompt({
          brief,
          parentPrompt: shot.prompt,
          sceneIndex: n,
          issues,
          suggestions,
        });
        const stillRes = await generateStillBestOf({
          brief: brief.brief,
          prompt: rewritten,
          n: 2,
          workDir: briefDir,
          sceneIndex: n,
        });
        const stablePath = resolvePath(briefDir, `v${iter + 1}-scene${n}.jpg`);
        await copyFile(stillRes.localPath, stablePath);
        shot.prompt = rewritten;
        shot.imageUrl = stillRes.url;
        shot.localPath = stablePath;
      }),
    );
    priorPerAspect = extractPerAspectShot(consensus);
    priorLocked = new Set(locked);
  }
  return { shots, history };
}

// ============================================================
// Phase C — VIDEO
// ============================================================

function buildVideoRubric(
  aspect: VideoAspect,
  seat: number,
  version: string,
  brief: Brief,
): string {
  return [
    `You are CRITIC SEAT ${seat} on the "${aspect}" panel for video shots.`,
    `${brief.shotCount} shot prompts will be shown. Score each shot's PROMPT 0.0-1.0 on ${aspect}.`,
    "",
    "STEP 0: `bash` `ls /mnt/memory/` to find STORE_DIR.",
    `STEP 1: write to /mnt/memory/$STORE_DIR/memory/critiques/video/${version}/${aspect}-seat${seat}.json`,
    "",
    "{",
    `  "version": "c-${aspect}-${version}-seat${seat}",`,
    `  "parent_draft": "${version}", "aspect": "${aspect}",`,
    '  "candidate_scores": [',
    ...Array.from(
      { length: brief.shotCount },
      (_, i) => `    { "n": ${i}, "score": 0.0, "issues": [], "suggestion": "" }${i < brief.shotCount - 1 ? "," : ""}`,
    ),
    "  ],",
    '  "overall": 0.0, "summary": "...", "created_at": "<ISO>"',
    "}",
    "",
    `Honest scoring; emit \`DONE ${aspect} seat ${seat}\` to end turn.`,
  ].join("\n");
}

async function phaseC(brief: Brief, shots: StoryShot[], storeId: string): Promise<{
  mp4Path: string;
  history: { version: string; perCand: Record<number, number>; overall: number; locked: number[] }[];
}> {
  log(stamp(), `[C:${brief.id}] start`);
  const briefDir = resolvePath(OUT_ROOT, brief.id);
  await mkdir(briefDir, { recursive: true });

  // v1: generate one video take per shot.
  let videoUrls: (string | null)[] = await Promise.all(
    shots.map(async (s) => {
      const r = await submitTextToVideo({ prompt: s.prompt });
      return r.videoUrl;
    }),
  );
  log(stamp(), `[C:${brief.id}] v1: ${videoUrls.length} videos rendered`);

  const history: { version: string; perCand: Record<number, number>; overall: number; locked: number[] }[] = [];
  let priorPerAspect = new Map<string, Record<number, number>>();
  let priorLocked = new Set<number>();
  let mp4Path = "";

  for (let iter = 1; iter <= ITER_CAP; iter++) {
    const version = `v${iter}`;
    // compose
    const scratchOut = `/tmp/${RUN_ID}-${brief.id}-${version}.mp4`;
    await composeClips({
      clipUrls: videoUrls.filter((u): u is string => !!u),
      outPath: scratchOut,
    });
    mp4Path = resolvePath(briefDir, `${version}.mp4`);
    await copyFile(scratchOut, mp4Path);
    await ffprobeDuration(mp4Path);

    // panel
    let consensus = await runPanel<VideoAspect>({
      storeId,
      draftVersion: version,
      aspects: VIDEO_ASPECTS,
      seatsPerAspect: SEATS,
      pathPrefix: `video/${version}`,
      tag: `${brief.id}/C-${version}`,
      buildRubric: (a, s) => buildVideoRubric(a, s, version, brief),
      buildMessage: () =>
        [
          `BRIEF: ${brief.brief}`,
          `${shots.length} shot prompts:`,
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
    history.push({ version, perCand, overall, locked });
    log(stamp(), `[C:${brief.id}] ${version}: overall ${overall.toFixed(2)}, locked ${locked.length}/${shots.length}`);

    if (locked.length === shots.length && overall >= CONVERGED_THRESHOLD) {
      log(stamp(), `[C:${brief.id}] converged at ${version}`);
      break;
    }
    if (iter === ITER_CAP) break;

    // regen failing shots (keep prompts; nudge regen for simplicity)
    const failing = Object.entries(perCand)
      .filter(([, s]) => s < LOCK_THRESHOLD)
      .map(([n]) => Number(n));
    log(stamp(), `[C:${brief.id}] regen shots [${failing.join(",")}]`);
    await Promise.all(
      failing.map(async (n) => {
        const r = await submitTextToVideo({ prompt: shots[n]!.prompt });
        videoUrls[n] = r.videoUrl;
      }),
    );
    priorPerAspect = extractPerAspectShot(consensus);
    priorLocked = new Set(locked);
  }
  return { mp4Path, history };
}

// ============================================================
// Per-brief deliverables
// ============================================================

async function writeBriefDeliverables(input: {
  brief: Brief;
  storeId: string;
  phaseA: Awaited<ReturnType<typeof phaseA>>;
  phaseB: Awaited<ReturnType<typeof phaseB>>;
  phaseC?: Awaited<ReturnType<typeof phaseC>>;
}): Promise<{ phaseBOverall: number }> {
  const dir = resolvePath(OUT_ROOT, input.brief.id);
  await mkdir(dir, { recursive: true });

  // script.md
  const sLines: string[] = [];
  sLines.push(`# Script — ${input.brief.name}`);
  sLines.push(`Brief: ${input.brief.brief}`);
  sLines.push("");
  sLines.push("## Iterations");
  for (const h of input.phaseA.history) {
    sLines.push(
      `- **${h.version}** winner=variant${h.winnerN}, score=${h.winnerOverall.toFixed(2)} (all: ${Object.entries(
        h.perCand,
      )
        .map(([n, s]) => `${n}=${s.toFixed(2)}`)
        .join(" ")})`,
    );
  }
  sLines.push("");
  sLines.push("## Winning script");
  sLines.push("");
  sLines.push("```");
  sLines.push(scriptToText(input.phaseA.winner));
  sLines.push("```");
  await writeFile(resolvePath(dir, "script.md"), sLines.join("\n"));

  // storyboard.md
  const bLines: string[] = [];
  bLines.push(`# Storyboard — ${input.brief.name}`);
  bLines.push("");
  bLines.push("## Iterations");
  for (const h of input.phaseB.history) {
    bLines.push(`- **${h.version}** overall ${h.overall.toFixed(2)}, locked ${h.locked.length}/${input.phaseB.shots.length}`);
  }
  bLines.push("");
  bLines.push("## Final scenes");
  for (const s of input.phaseB.shots) {
    bLines.push(`### Scene ${s.n}`);
    bLines.push(`Prompt: ${s.prompt}`);
    if (s.localPath) bLines.push(`Image: \`${basename(s.localPath)}\``);
    if (s.imageUrl) bLines.push(`URL: ${s.imageUrl}`);
    bLines.push("");
  }
  await writeFile(resolvePath(dir, "storyboard.md"), bLines.join("\n"));

  // Build a contact-sheet jpg from the final stills (no text overlay).
  if (input.phaseB.shots.every((s) => s.localPath)) {
    const stillPaths = input.phaseB.shots.map((s) => s.localPath!);
    const sheet = resolvePath(dir, "storyboard-sheet.jpg");
    const args = ["-y", ...stillPaths.flatMap((p) => ["-i", p])];
    const filter = `${stillPaths
      .map((_, i) => `[${i}:v]scale=480:270,setsar=1[v${i}]`)
      .join(";")};${stillPaths
      .map((_, i) => `[v${i}]`)
      .join("")}hstack=inputs=${stillPaths.length}[out]`;
    args.push("-filter_complex", filter, "-map", "[out]", "-q:v", "3", sheet);
    await run("ffmpeg", args, { timeoutMs: 60_000 }).catch(() => {});
  }

  // scorecard.md
  const lastA = input.phaseA.history.at(-1)!;
  const lastB = input.phaseB.history.at(-1)!;
  const lastC = input.phaseC?.history.at(-1);
  const sc: string[] = [];
  sc.push(`# Scorecard — ${input.brief.name}`);
  sc.push(`Store: \`${input.storeId}\``);
  sc.push("");
  sc.push(`| Phase | Final overall | Locked |`);
  sc.push(`|---|---|---|`);
  sc.push(`| A (script)     | ${lastA.winnerOverall.toFixed(2)} | winner = variant${lastA.winnerN} |`);
  sc.push(`| B (storyboard) | ${lastB.overall.toFixed(2)} | ${lastB.locked.length}/${input.phaseB.shots.length} |`);
  if (lastC) sc.push(`| C (video)      | ${lastC.overall.toFixed(2)} | ${lastC.locked.length}/${input.phaseB.shots.length} |`);
  await writeFile(resolvePath(dir, "scorecard.md"), sc.join("\n"));

  return { phaseBOverall: lastB.overall };
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  await mkdir(OUT_ROOT, { recursive: true });
  log("OUT_ROOT =", OUT_ROOT);

  const results: Array<{
    brief: Brief;
    storeId: string;
    phaseBOverall: number;
    phaseA: Awaited<ReturnType<typeof phaseA>>;
    phaseB: Awaited<ReturnType<typeof phaseB>>;
    phaseC?: Awaited<ReturnType<typeof phaseC>>;
  }> = [];

  // --- Phase A + B for every brief ---
  for (const brief of BRIEFS) {
    log(stamp(), `=== BRIEF: ${brief.id} (${brief.name}) ===`);
    const store = await createMemoryStore({
      name: `pipeline-${brief.id}-${RUN_ID}`,
      description: brief.name,
    });
    await updateMemoryStoreMetadata(store.id, {
      braid_studio: "v1",
      project_name: brief.id,
    });
    log(stamp(), `store: ${store.id}`);

    const a = await phaseA(brief, store.id);
    const b = await phaseB(brief, a.winner, store.id);
    const { phaseBOverall } = await writeBriefDeliverables({
      brief,
      storeId: store.id,
      phaseA: a,
      phaseB: b,
    });
    results.push({ brief, storeId: store.id, phaseBOverall, phaseA: a, phaseB: b });
  }

  // --- Phase C for top 2 by Phase B overall ---
  const sorted = [...results].sort((a, b) => b.phaseBOverall - a.phaseBOverall);
  const topK = sorted.slice(0, 2);
  log(
    stamp(),
    `Top by Phase B: ${topK.map((r) => `${r.brief.id}=${r.phaseBOverall.toFixed(2)}`).join(", ")}`,
  );
  for (const top of topK) {
    const c = await phaseC(top.brief, top.phaseB.shots, top.storeId);
    top.phaseC = c;
    await writeBriefDeliverables({
      brief: top.brief,
      storeId: top.storeId,
      phaseA: top.phaseA,
      phaseB: top.phaseB,
      phaseC: c,
    });
  }

  // --- Cross-brief README ---
  const readme: string[] = [];
  readme.push(`# Full pipeline run — ${RUN_ID}`);
  readme.push("");
  readme.push("Three-phase Managed-Agent loop across multiple briefs.");
  readme.push("");
  readme.push("| Brief | Genre/angle | Phase A | Phase B | Phase C |");
  readme.push("|---|---|---|---|---|");
  for (const r of results) {
    const lastA = r.phaseA.history.at(-1)!;
    const lastB = r.phaseB.history.at(-1)!;
    const lastC = r.phaseC?.history.at(-1);
    readme.push(
      `| [${r.brief.name}](./${r.brief.id}/) | ${r.brief.genre} / ${r.brief.angle} | ${lastA.winnerOverall.toFixed(2)} | ${lastB.overall.toFixed(2)} (${lastB.locked.length}/${r.phaseB.shots.length}) | ${lastC ? `${lastC.overall.toFixed(2)} (${lastC.locked.length}/${r.phaseB.shots.length})` : "—"} |`,
    );
  }
  readme.push("");
  readme.push("Open each brief directory for `script.md`, `storyboard.md`, `storyboard-sheet.jpg`, and (top winners) `v{N}.mp4`.");
  await writeFile(resolvePath(OUT_ROOT, "README.md"), readme.join("\n"));

  console.log("\n=== PIPELINE COMPLETE ===");
  console.log("dir:", OUT_ROOT);
  for (const r of results) {
    const lastA = r.phaseA.history.at(-1)!;
    const lastB = r.phaseB.history.at(-1)!;
    const lastC = r.phaseC?.history.at(-1);
    console.log(
      `  ${r.brief.id}: A=${lastA.winnerOverall.toFixed(2)} B=${lastB.overall.toFixed(2)}${lastC ? ` C=${lastC.overall.toFixed(2)}` : ""}`,
    );
  }
}

main().catch((err) => {
  console.error("[pipe] failed:", err);
  process.exit(1);
});
