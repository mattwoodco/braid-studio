/**
 * Resume Phase C: for each brief directory that has storyboard stills,
 * caption the FINAL iteration's stills with Claude vision → text-to-video
 * prompts → submitTextToVideo → composeClips → final mp4 + scorecard.
 *
 * Usage:
 *   bun scripts/phase-c-from-stills.ts <runDir> [brief1 brief2 ...]
 *
 * If no briefs specified, processes every brief subdirectory.
 */
import Anthropic from "@anthropic-ai/sdk";
import { BRIEFS, type Brief } from "@/lib/briefs";
import { submitTextToVideo } from "@/lib/fal";
import { composeClips, ffprobeDuration } from "@/lib/ffmpeg";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath, basename } from "node:path";

const RUN_DIR = process.argv[2];
const BRIEF_FILTER = process.argv.slice(3);
if (!RUN_DIR) {
  console.error("usage: bun scripts/phase-c-from-stills.ts <runDir> [briefIds...]");
  process.exit(1);
}

let _anth: Anthropic | null = null;
function anth(): Anthropic {
  if (_anth) return _anth;
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error("ANTHROPIC_API_KEY");
  _anth = new Anthropic({ apiKey: k });
  return _anth;
}

const log = (...a: unknown[]): void => console.log("[phaseC]", ...a);
const stamp = (): string => new Date().toISOString().slice(11, 19);

/** From a brief's storyboard dir, find the latest version per scene. */
async function pickFinalStills(storyDir: string): Promise<string[]> {
  const files = await readdir(storyDir);
  // pattern: v{N}-scene{S}-{X}.jpg ; pick highest N per scene S, prefer earlier candidate (A)
  const byScene = new Map<number, { version: number; path: string; label: string }>();
  for (const f of files) {
    const m = /^v(\d+)-scene(\d+)-([A-Z])\.jpg$/.exec(f);
    if (!m || !m[1] || !m[2] || !m[3]) continue;
    const v = Number(m[1]);
    const s = Number(m[2]);
    const label = m[3];
    const cur = byScene.get(s);
    if (!cur || v > cur.version || (v === cur.version && label < cur.label)) {
      byScene.set(s, { version: v, path: resolvePath(storyDir, f), label });
    }
  }
  const scenes = [...byScene.entries()].sort((a, b) => a[0] - b[0]);
  return scenes.map(([, v]) => v.path);
}

async function captionStillAsVideoPrompt(input: {
  stillPath: string;
  brief: Brief;
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
              "Write a SHOOTABLE text-to-video prompt that would produce a 5-second cinematic clip matching this image:",
              "  - subject, framing, lighting, color, ONE specific camera motion (push-in/dolly/pan/static), ONE specific action.",
              "  - Concrete, not abstract. No quotes, no labels, one paragraph, ≤ 60 words.",
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
  if (!block || block.type !== "text") throw new Error("caption: no text");
  return block.text.trim().replace(/^["']|["']$/g, "");
}

async function processBrief(brief: Brief, runDir: string): Promise<{
  briefId: string;
  prompts: string[];
  shotUrls: string[];
  mp4Path: string;
  fileBytes: number;
  durationSeconds: number;
} | null> {
  const briefDir = resolvePath(runDir, brief.id);
  const storyDir = resolvePath(briefDir, "storyboard");
  let stills: string[] = [];
  try {
    stills = await pickFinalStills(storyDir);
  } catch (err) {
    log(`[${brief.id}] no storyboard dir found, skipping (${err instanceof Error ? err.message : err})`);
    return null;
  }
  if (stills.length === 0) {
    log(`[${brief.id}] no stills found, skipping`);
    return null;
  }
  log(stamp(), `[${brief.id}] ${stills.length} final stills → captioning`);

  const prompts = await Promise.all(
    stills.map(async (s, i) => {
      const p = await captionStillAsVideoPrompt({ stillPath: s, brief, sceneIndex: i });
      log(`  [${i}] ${basename(s)}: ${p.slice(0, 120)}...`);
      return p;
    }),
  );

  log(stamp(), `[${brief.id}] rendering ${prompts.length} text-to-video clips`);
  const videos = await Promise.all(prompts.map((p) => submitTextToVideo({ prompt: p })));
  const shotUrls = videos.map((v) => v.videoUrl);

  log(stamp(), `[${brief.id}] composing mp4`);
  const scratch = `/tmp/phaseC-resume-${brief.id}-${Date.now()}.mp4`;
  await composeClips({ clipUrls: shotUrls, outPath: scratch });
  const duration = await ffprobeDuration(scratch);
  const mp4Path = resolvePath(briefDir, `video.mp4`);
  await copyFile(scratch, mp4Path);
  const fileBytes = (await Bun.file(mp4Path).size) ?? 0;

  // Write the per-brief deliverables that the crashed orchestrator never got to.
  const lines: string[] = [];
  lines.push(`# ${brief.name}`);
  lines.push("");
  lines.push(`**Brief:** ${brief.brief}`);
  lines.push("");
  lines.push("## Final scene prompts (vision-captioned from approved storyboard)");
  for (let i = 0; i < prompts.length; i++) {
    lines.push(`### Scene ${i}`);
    lines.push(`Image: \`storyboard/${basename(stills[i] ?? "")}\``);
    lines.push(`Prompt: ${prompts[i]}`);
    lines.push(`Video URL: ${shotUrls[i]}`);
    lines.push("");
  }
  lines.push("## Final video");
  lines.push(`\`video.mp4\` (${fileBytes.toLocaleString()} bytes, ${duration.toFixed(1)}s)`);
  await writeFile(resolvePath(briefDir, "deliverable.md"), lines.join("\n"));

  return { briefId: brief.id, prompts, shotUrls, mp4Path, fileBytes, durationSeconds: duration };
}

async function main(): Promise<void> {
  const runDir = resolvePath(RUN_DIR!);
  log("runDir =", runDir);
  const briefs = BRIEFS.filter((b) => BRIEF_FILTER.length === 0 || BRIEF_FILTER.includes(b.id));
  log(`processing ${briefs.length} brief(s): ${briefs.map((b) => b.id).join(", ")}`);

  const results: Awaited<ReturnType<typeof processBrief>>[] = [];
  for (const b of briefs) {
    const r = await processBrief(b, runDir);
    if (r) results.push(r);
  }

  // Cross-brief README addendum
  const lines: string[] = [];
  lines.push(`# Phase C resume — ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Videos rendered by captioning the FINAL approved storyboard stills with Claude vision, then text-to-video on the captions.");
  lines.push("");
  lines.push("| Brief | Shots | mp4 bytes | Duration |");
  lines.push("|---|---|---|---|");
  for (const r of results) {
    if (!r) continue;
    lines.push(
      `| [${r.briefId}](./${r.briefId}/deliverable.md) | ${r.prompts.length} | ${r.fileBytes.toLocaleString()} | ${r.durationSeconds.toFixed(1)}s |`,
    );
  }
  await mkdir(runDir, { recursive: true });
  await writeFile(resolvePath(runDir, "PHASE_C.md"), lines.join("\n"));

  console.log("\n=== PHASE C RESUME DONE ===");
  for (const r of results) {
    if (!r) continue;
    console.log(`  ${r.briefId}: ${r.mp4Path}`);
  }
}

main().catch((err) => {
  console.error("[phaseC] failed:", err);
  process.exit(1);
});
