/**
 * Pipeline v2 — drops in the upgraded resilient patterns:
 *
 *   1. Craft-grounded rubrics (14 operational aspects with anchors)
 *      replace the 16 generic aspects.
 *   2. JSON contract helper guarantees parseable envelopes.
 *   3. Brief-grounded vision judge (claude-judge.ts).
 *   4. Minimal-rewrite hard guard.
 *   5. Convergence smoothing (2 consecutive passing versions).
 *   6. Adaptive best-of-N (closer-to-threshold = smaller N).
 *
 * Other behaviour identical to full-pipeline.ts. New runs land in
 * data/full-pipeline-v2/<runId>/. Stores stay isolated per brief.
 */
import { BRIEFS, type Brief } from "@/lib/briefs";
import {
  applyCarryForward,
  type ConsensusEnvelope,
  convergedSmoothed,
  extractPerAspectShot,
  overallOf,
  perCandidateAvg,
  runPanel,
} from "@/lib/critic-panel";
import {
  createMemoryStore,
  updateMemoryStoreMetadata,
} from "@/lib/anthropic";
import {
  SCRIPT_CRAFT,
  STORY_CRAFT,
  VIDEO_CRAFT,
  renderAspectRubric,
  type AspectDefinition,
} from "@/lib/craft-rubrics";
import { adaptiveN, anth, briefGroundedJudge, minimalRewrite } from "@/lib/claude-judge";
import { submitTextToImage } from "@/lib/fal-image";
import { submitTextToVideo } from "@/lib/fal";
import { composeClips, ffprobeDuration } from "@/lib/ffmpeg";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";

const RUN_ID = `pipev2-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
const OUT_ROOT = resolvePath(process.cwd(), "data/full-pipeline-v2", RUN_ID);

const SEATS = 3;
const VARIANTS_PER_ITER = 5;
const ITER_CAP = 4; // smoothed convergence may need 1 extra hold
const LOCK_THRESHOLD = 0.7;
const CONVERGED_OVERALL = 0.78; // slightly more permissive since 14 aspects are harder
const BEST_OF_MIN = 2;
const BEST_OF_MAX = 4;

const log = (...a: unknown[]): void => console.log("[pipe2]", ...a);
const stamp = (): string => new Date().toISOString().slice(11, 19);

const SCRIPT_ASPECT_IDS = SCRIPT_CRAFT.map((d) => d.id);
const STORY_ASPECT_IDS = STORY_CRAFT.map((d) => d.id);
const VIDEO_ASPECT_IDS = VIDEO_CRAFT.map((d) => d.id);

const SCRIPT_DEF_BY_ID = Object.fromEntries(SCRIPT_CRAFT.map((d) => [d.id, d]));
const STORY_DEF_BY_ID = Object.fromEntries(STORY_CRAFT.map((d) => [d.id, d]));
const VIDEO_DEF_BY_ID = Object.fromEntries(VIDEO_CRAFT.map((d) => [d.id, d]));

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

async function fetchTo(url: string, p: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  await writeFile(p, new Uint8Array(await res.arrayBuffer()));
}

// ============================================================
// Phase A — SCRIPT (craft rubric)
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
        "  - vary hook type (in-medias-res / VO / silent), opening shot type, narrative structure",
        "  - address these recurring issues:",
        ...input.seedFromCritic
          .flatMap((s) => s.issues)
          .slice(0, 10)
          .map((i) => `    - ${i}`),
        "  - apply these suggestions:",
        ...input.seedFromCritic
          .flatMap((s) => s.suggestions)
          .slice(0, 8)
          .map((s) => `    - ${s}`),
      ].join("\n")
    : `Generate ${input.k} maximally DIFFERENT variants. Vary: hook type (in-medias-res / VO / silent / surprise-image), tonal register, opening focal length, narrative arc.`;
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
              "Each scene.description must be a SHOOTABLE prompt: concrete subject, camera, lighting, motion, action.",
              "n is the variant index 0..K-1. No markdown.",
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
  if (!Array.isArray(parsed)) throw new Error("not an array");
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

async function phaseA(brief: Brief, storeId: string): Promise<{
  winner: ScriptVariant;
  history: { version: string; perCand: Record<number, number>; winnerN: number; winnerScore: number }[];
}> {
  log(stamp(), `[A:${brief.id}] start`);
  let variants = await generateScriptVariants({ brief, k: VARIANTS_PER_ITER });

  const history: { version: string; perCand: Record<number, number>; winnerN: number; winnerScore: number }[] = [];
  let prevWinner = -1;
  for (let iter = 1; iter <= ITER_CAP; iter++) {
    const version = `v${iter}`;
    const consensus = await runPanel({
      storeId,
      draftVersion: version,
      aspects: SCRIPT_ASPECT_IDS,
      seatsPerAspect: SEATS,
      pathPrefix: `script/${version}`,
      tag: `${brief.id}/A-${version}`,
      buildRubric: (aspect, seat) =>
        renderAspectRubric({
          def: SCRIPT_DEF_BY_ID[aspect]!,
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
    history.push({ version, perCand, winnerN, winnerScore });
    log(stamp(), `[A:${brief.id}] ${version} winner=variant${winnerN} score=${winnerScore.toFixed(2)}`);

    if (winnerScore >= CONVERGED_OVERALL) {
      log(stamp(), `[A:${brief.id}] converged at ${version}`);
      return { winner: variants.find((v) => v.n === winnerN) ?? variants[0]!, history };
    }
    if (prevWinner >= 0 && winnerScore - prevWinner < 0.02) {
      log(stamp(), `[A:${brief.id}] plateau`);
      return { winner: variants.find((v) => v.n === winnerN) ?? variants[0]!, history };
    }
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
  const last = history.at(-1)!;
  return { winner: variants.find((v) => v.n === last.winnerN) ?? variants[0]!, history };
}

// ============================================================
// Phase B — STORYBOARD (craft rubric + adaptive best-of-N)
// ============================================================

type StoryShot = {
  n: number;
  prompt: string;
  imageUrl: string | null;
  localPath: string | null;
};

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
  const pick = input.n === 1 ? 0 : await briefGroundedJudge({
    brief: input.brief,
    intent: input.prompt,
    thumbPaths: paths,
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
  let shots: StoryShot[] = await Promise.all(
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

  const history: { version: string; perCand: Record<number, number>; overall: number; locked: number[] }[] = [];
  let priorPerAspect = new Map<string, Record<number, number>>();
  let priorLocked = new Set<number>();
  const smoothing: { allLocked: boolean; overall: number }[] = [];

  for (let iter = 1; iter <= ITER_CAP; iter++) {
    const version = `v${iter}`;
    let consensus = await runPanel({
      storeId,
      draftVersion: version,
      aspects: STORY_ASPECT_IDS,
      seatsPerAspect: SEATS,
      pathPrefix: `story/${version}`,
      tag: `${brief.id}/B-${version}`,
      buildRubric: (aspect, seat) =>
        renderAspectRubric({
          def: STORY_DEF_BY_ID[aspect]!,
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
    history.push({ version, perCand, overall, locked });
    smoothing.push({ allLocked: locked.length === shots.length, overall });
    log(stamp(), `[B:${brief.id}] ${version}: overall ${overall.toFixed(2)} locked ${locked.length}/${shots.length}`);

    if (convergedSmoothed(smoothing, CONVERGED_OVERALL, 2)) {
      log(stamp(), `[B:${brief.id}] smoothed convergence at ${version}`);
      break;
    }
    if (iter === ITER_CAP) break;

    // Adaptive best-of-N for each failing scene.
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
        const N = adaptiveN({ shotScore: s, lockThreshold: LOCK_THRESHOLD, minN: BEST_OF_MIN, maxN: BEST_OF_MAX });
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
    priorPerAspect = extractPerAspectShot(consensus);
    priorLocked = new Set(locked);
  }
  return { shots, history };
}

// ============================================================
// Phase C — VIDEO (craft rubric)
// ============================================================

async function phaseC(brief: Brief, shots: StoryShot[], storeId: string): Promise<{
  mp4Path: string;
  history: { version: string; perCand: Record<number, number>; overall: number; locked: number[] }[];
}> {
  log(stamp(), `[C:${brief.id}] start`);
  const briefDir = resolvePath(OUT_ROOT, brief.id);
  await mkdir(briefDir, { recursive: true });
  let videoUrls: string[] = await Promise.all(
    shots.map(async (s) => (await submitTextToVideo({ prompt: s.prompt })).videoUrl),
  );
  const history: { version: string; perCand: Record<number, number>; overall: number; locked: number[] }[] = [];
  let priorPerAspect = new Map<string, Record<number, number>>();
  let priorLocked = new Set<number>();
  let mp4Path = "";
  const smoothing: { allLocked: boolean; overall: number }[] = [];

  for (let iter = 1; iter <= ITER_CAP; iter++) {
    const version = `v${iter}`;
    const scratch = `/tmp/${RUN_ID}-${brief.id}-${version}.mp4`;
    await composeClips({ clipUrls: videoUrls, outPath: scratch });
    mp4Path = resolvePath(briefDir, `${version}.mp4`);
    await copyFile(scratch, mp4Path);
    await ffprobeDuration(mp4Path);

    let consensus = await runPanel({
      storeId,
      draftVersion: version,
      aspects: VIDEO_ASPECT_IDS,
      seatsPerAspect: SEATS,
      pathPrefix: `video/${version}`,
      tag: `${brief.id}/C-${version}`,
      buildRubric: (aspect, seat) =>
        renderAspectRubric({
          def: VIDEO_DEF_BY_ID[aspect]!,
          seat,
          version,
          candidateCount: shots.length,
          unit: "shot",
          pathPrefix: `video/${version}`,
        }),
      buildMessage: () =>
        [
          `BRIEF: ${brief.brief}`,
          `${shots.length} shot prompts to score on the one aspect above:`,
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
    smoothing.push({ allLocked: locked.length === shots.length, overall });
    log(stamp(), `[C:${brief.id}] ${version}: overall ${overall.toFixed(2)} locked ${locked.length}/${shots.length}`);
    if (convergedSmoothed(smoothing, CONVERGED_OVERALL, 2)) {
      log(stamp(), `[C:${brief.id}] smoothed convergence at ${version}`);
      break;
    }
    if (iter === ITER_CAP) break;

    const failing = Object.entries(perCand)
      .filter(([, s]) => s < LOCK_THRESHOLD)
      .map(([n]) => Number(n));
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
// Main
// ============================================================

async function main(): Promise<void> {
  await mkdir(OUT_ROOT, { recursive: true });
  log("OUT_ROOT =", OUT_ROOT);
  const results: Array<{
    brief: Brief;
    storeId: string;
    phaseA: Awaited<ReturnType<typeof phaseA>>;
    phaseB: Awaited<ReturnType<typeof phaseB>>;
    phaseC?: Awaited<ReturnType<typeof phaseC>>;
    phaseBOverall: number;
  }> = [];

  for (const brief of BRIEFS) {
    log(stamp(), `=== ${brief.id} ===`);
    const store = await createMemoryStore({
      name: `pipev2-${brief.id}-${RUN_ID}`,
      description: brief.name,
    });
    await updateMemoryStoreMetadata(store.id, { braid_studio: "v1", project_name: brief.id });
    log(stamp(), "store:", store.id);

    const a = await phaseA(brief, store.id);
    const b = await phaseB(brief, a.winner, store.id);
    results.push({
      brief,
      storeId: store.id,
      phaseA: a,
      phaseB: b,
      phaseBOverall: b.history.at(-1)?.overall ?? 0,
    });
  }

  // Phase C for top 2 by Phase B overall.
  const top = [...results].sort((a, b) => b.phaseBOverall - a.phaseBOverall).slice(0, 2);
  for (const t of top) {
    t.phaseC = await phaseC(t.brief, t.phaseB.shots, t.storeId);
  }

  // README
  const lines: string[] = [];
  lines.push(`# Pipeline v2 — ${RUN_ID}`);
  lines.push("");
  lines.push("Resilient patterns applied: craft-grounded 16-aspect rubric, JSON contract helper, brief-grounded judge, minimal-rewrite guard, convergence smoothing (2-version), adaptive best-of-N.");
  lines.push("");
  lines.push("| Brief | Phase A winner | Phase B overall | Phase C overall |");
  lines.push("|---|---|---|---|");
  for (const r of results) {
    const a = r.phaseA.history.at(-1);
    const b = r.phaseB.history.at(-1);
    const c = r.phaseC?.history.at(-1);
    lines.push(
      `| [${r.brief.name}](./${r.brief.id}/) | v${a?.winnerN}: ${a?.winnerScore.toFixed(2)} | ${b?.overall.toFixed(2)} (${b?.locked.length}/${r.phaseB.shots.length}) | ${c ? `${c.overall.toFixed(2)} (${c.locked.length}/${r.phaseB.shots.length})` : "—"} |`,
    );
  }
  lines.push("");
  lines.push("## Stores (for pattern miner)");
  for (const r of results) lines.push(`- ${r.brief.id}: \`${r.storeId}\``);
  lines.push("");
  lines.push("After this run completes:");
  lines.push("```");
  lines.push(`bun scripts/mine-patterns.ts ${results.map((r) => r.storeId).join(" ")} --out=${OUT_ROOT}/patterns.md`);
  lines.push("```");
  await writeFile(resolvePath(OUT_ROOT, "README.md"), lines.join("\n"));

  console.log("\n=== PIPELINE V2 DONE ===");
  console.log("dir:", OUT_ROOT);
  for (const r of results) console.log(`  ${r.brief.id}: store=${r.storeId}`);
}

main().catch((err) => {
  console.error("[pipe2] failed:", err);
  process.exit(1);
});
