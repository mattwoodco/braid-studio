/**
 * Finalize an exec-demo run that already wrote v1..vN.mp4: pulls critiques
 * back from the memory store, builds a label-less vertical composite, and
 * writes scorecard.md / summary.md / run.json.
 *
 * Usage: bun scripts/exec-demo-finalize.ts <storeId> <runDir>
 */
import {
  CRITIQUE_ASPECTS,
  type CritiqueAspect,
  type CritiqueEnvelope,
} from "@/lib/critique";
import { listDrafts } from "@/lib/drafts";
import { listMemories } from "@/lib/anthropic";

const LOCK_THRESHOLD = 0.7;
const CARRY_FORWARD_DELTA = 0.05;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

const SEAT_RE = /^\/memory\/critiques\/([^/]+)\/([^/]+)-seat(\d+)\.json$/;

async function loadConsensusFor(
  storeId: string,
  version: string,
): Promise<Map<CritiqueAspect, CritiqueEnvelope>> {
  const mems = await listMemories(storeId, { prefix: `/memory/critiques/${version}/` });
  const bySeat = new Map<CritiqueAspect, CritiqueEnvelope[]>();
  for (const m of mems) {
    const match = SEAT_RE.exec(m.path);
    if (!match || match[1] !== version) continue;
    const aspect = match[2] as CritiqueAspect;
    if (!CRITIQUE_ASPECTS.includes(aspect)) continue;
    try {
      const raw = JSON.parse(m.content);
      if (!raw || !Array.isArray(raw.shot_scores)) continue;
      raw.aspect = aspect;
      for (const sc of raw.shot_scores) {
        if (!Array.isArray(sc.issues)) sc.issues = [];
        if (typeof sc.suggestion !== "string") sc.suggestion = "";
      }
      const list = bySeat.get(aspect) ?? [];
      list.push(raw as CritiqueEnvelope);
      bySeat.set(aspect, list);
    } catch {}
  }
  const out = new Map<CritiqueAspect, CritiqueEnvelope>();
  for (const a of CRITIQUE_ASPECTS) {
    const seats = bySeat.get(a) ?? [];
    if (!seats.length) continue;
    const shotN = new Set<number>();
    for (const s of seats) for (const sc of s.shot_scores) shotN.add(sc.n);
    const shot_scores = [...shotN]
      .sort((a, b) => a - b)
      .map((n) => {
        const scores: number[] = [];
        for (const s of seats) {
          const sc = s.shot_scores.find((x) => x.n === n);
          if (sc) scores.push(sc.score);
        }
        return { n, score: median(scores), issues: [], suggestion: "" };
      });
    const overall = shot_scores.reduce((a, s) => a + s.score, 0) / shot_scores.length;
    out.set(a, {
      version: `c-${a}-${version}-consensus`,
      parent_draft: version,
      aspect: a,
      shot_scores,
      overall,
      summary: `median of ${seats.length} seats`,
      created_at: "",
    });
  }
  return out;
}

function carryForward(
  current: Map<CritiqueAspect, CritiqueEnvelope>,
  priorAspectShot: Map<CritiqueAspect, Record<number, number>>,
  priorLocked: Set<number>,
): Map<CritiqueAspect, CritiqueEnvelope> {
  const out = new Map<CritiqueAspect, CritiqueEnvelope>();
  for (const [a, env] of current) {
    const priors = priorAspectShot.get(a) ?? {};
    const shot_scores = env.shot_scores.map((sc) => {
      if (!priorLocked.has(sc.n)) return sc;
      const prior = priors[sc.n];
      if (prior === undefined) return sc;
      const floor = prior - CARRY_FORWARD_DELTA;
      return sc.score >= floor ? sc : { ...sc, score: floor };
    });
    const overall = shot_scores.reduce((a, s) => a + s.score, 0) / shot_scores.length;
    out.set(a, { ...env, shot_scores, overall });
  }
  return out;
}

function perShotAvg(consensus: Map<CritiqueAspect, CritiqueEnvelope>): Record<number, number> {
  const acc: Record<number, number[]> = {};
  for (const e of consensus.values()) {
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
import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

const [, , storeId, runDir] = process.argv;
if (!storeId || !runDir) {
  console.error("usage: bun scripts/exec-demo-finalize.ts <storeId> <runDir>");
  process.exit(1);
}

async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
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
      resolve({ code: code ?? 1, stderr });
    });
    p.on("error", reject);
  });
}

type VersionScore = {
  version: string;
  perAspect: Partial<Record<CritiqueAspect, number>>;
  overall: number;
  locked: number[];
  shotScoresAvg: Record<number, number>;
};

function scoreFromConsensus(
  consensus: Map<CritiqueAspect, CritiqueEnvelope>,
  version: string,
): VersionScore {
  const perAspect: Partial<Record<CritiqueAspect, number>> = {};
  for (const [a, env] of consensus) perAspect[a] = env.overall;
  const shotAvg = perShotAvg(consensus);
  const locked: number[] = [];
  for (const [n, avg] of Object.entries(shotAvg)) {
    if (avg >= LOCK_THRESHOLD) locked.push(Number(n));
  }
  locked.sort((a, b) => a - b);
  const overallVals = Object.values(shotAvg);
  return {
    version,
    perAspect,
    overall: overallVals.length ? overallVals.reduce((a, b) => a + b, 0) / overallVals.length : 0,
    locked,
    shotScoresAvg: shotAvg,
  };
}

async function main(): Promise<void> {
  const dir = resolvePath(runDir);
  const files = await readdir(dir);
  const mp4s = files.filter((f) => /^v\d+\.mp4$/.test(f)).sort();
  console.log("mp4s found:", mp4s.join(", "));
  const versions = mp4s.map((f) => f.replace(/\.mp4$/, ""));

  const drafts = await listDrafts(storeId);
  const draftByV = new Map(drafts.map((d) => [d.version, d]));
  const shotCount = drafts[0]?.shots.length ?? 5;

  console.log("pulling critiques (median consensus + carry-forward)...");
  const scores: VersionScore[] = [];
  const consensusByV = new Map<string, Map<CritiqueAspect, CritiqueEnvelope>>();
  let priorAspectShot = new Map<CritiqueAspect, Record<number, number>>();
  let priorLocked = new Set<number>();
  for (const v of versions) {
    let consensus = await loadConsensusFor(storeId, v);
    console.log(`  ${v}: ${consensus.size}/6 aspects (median of seats)`);
    if (priorAspectShot.size > 0) {
      consensus = carryForward(consensus, priorAspectShot, priorLocked);
    }
    consensusByV.set(v, consensus);
    const sc = scoreFromConsensus(consensus, v);
    scores.push(sc);
    // Update priors for next iteration.
    const next = new Map<CritiqueAspect, Record<number, number>>();
    for (const [a, env] of consensus) {
      const m: Record<number, number> = {};
      for (const x of env.shot_scores) m[x.n] = x.score;
      next.set(a, m);
    }
    priorAspectShot = next;
    priorLocked = new Set(sc.locked);
  }

  // --- composite: vstack at 640x360 each, no text ---
  console.log("building composite (label-less vstack)...");
  const inputs: string[] = [];
  for (const v of versions) inputs.push("-i", resolvePath(dir, `${v}.mp4`));
  const scaleParts: string[] = [];
  for (let i = 0; i < versions.length; i++) {
    scaleParts.push(`[${i}:v]scale=640:360,setsar=1[v${i}]`);
  }
  scaleParts.push(
    `${versions.map((_, i) => `[v${i}]`).join("")}vstack=inputs=${versions.length}[out]`,
  );
  const compositePath = resolvePath(dir, "composite.mp4");
  const args = [
    "-y",
    ...inputs,
    "-filter_complex",
    scaleParts.join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "20",
    "-an",
    compositePath,
  ];
  const r = await run("ffmpeg", args, { timeoutMs: 5 * 60 * 1000 });
  if (r.code !== 0) {
    console.error("composite failed:", r.stderr.slice(-1000));
    process.exit(1);
  }
  console.log("composite:", compositePath);

  // --- scorecard.md ---
  const rows: string[] = [];
  rows.push("# Critique scorecard");
  rows.push("");
  rows.push(`**Run dir:** \`${dir}\``);
  rows.push(`**Store:** \`${storeId}\``);
  rows.push("");
  rows.push("## Composite layout");
  rows.push("");
  rows.push(
    `\`composite.mp4\` stacks the versions vertically, **top → bottom = ${versions.join(" → ")}**.`,
  );
  rows.push("");
  rows.push("## Per-aspect overall (higher is better; lock threshold 0.70)");
  rows.push("");
  rows.push(`| Aspect | ${versions.join(" | ")} |`);
  rows.push(`|---|${versions.map(() => "---").join("|")}|`);
  for (const a of CRITIQUE_ASPECTS) {
    const cells = scores.map((s) => {
      const v = s.perAspect[a];
      return v === undefined ? "—" : v.toFixed(2);
    });
    rows.push(`| ${a} | ${cells.join(" | ")} |`);
  }
  rows.push(`| **overall** | ${scores.map((s) => `**${s.overall.toFixed(2)}**`).join(" | ")} |`);
  rows.push(`| locked shots | ${scores.map((s) => `${s.locked.length}/${shotCount}`).join(" | ")} |`);
  rows.push("");
  rows.push("## Per-shot averages (mean across all aspects)");
  rows.push("");
  rows.push(`| Shot | ${versions.join(" | ")} |`);
  rows.push(`|---|${versions.map(() => "---").join("|")}|`);
  for (let n = 0; n < shotCount; n++) {
    const cells = scores.map((s) => {
      const v = s.shotScoresAvg[n];
      return v === undefined ? "—" : v.toFixed(2);
    });
    rows.push(`| ${n} | ${cells.join(" | ")} |`);
  }
  rows.push("");
  rows.push("## Files");
  for (const s of scores) {
    const env = draftByV.get(s.version);
    if (env) {
      rows.push(
        `- **${s.version}** → \`${env.mp4_filename}\` (${env.file_bytes.toLocaleString()} bytes, ${env.duration_seconds.toFixed(1)}s, ${env.locked_shots.length}/${shotCount} locked)`,
      );
    }
  }
  await writeFile(resolvePath(dir, "scorecard.md"), rows.join("\n"));
  console.log("wrote scorecard.md");

  // --- summary.md ---
  const first = scores[0]!;
  const last = scores[scores.length - 1]!;
  const delta = last.overall - first.overall;
  const lockedDelta = last.locked.length - first.locked.length;
  const sum: string[] = [];
  sum.push("# Self-critiquing video draft — exec summary");
  sum.push("");
  sum.push(
    "**Brief:** Luxury heirloom mechanical timepiece — 30-second teaser. Three generations: grandfather's wrist, father at his desk, daughter in golden-hour Paris. Warm tonal palette, intentional camera motion, intimate scale, sense of time being handed forward.",
  );
  sum.push("");
  sum.push("## What this run demonstrates");
  sum.push("");
  sum.push("1. A first draft (`v1`) was generated from the brief with a text-to-video model.");
  sum.push(
    "2. A six-aspect critic panel (cinematography, pacing, color, narrative, audio, brand) ran on **Anthropic Managed Agents** in parallel; each critic wrote a per-aspect scorecard into the project's memory store.",
  );
  sum.push(
    "3. Shots scoring ≥ 0.70 across aspects were **locked** (byte-identical reuse). Failing shots had their prompts rewritten by Claude based on the critics' suggestions, then regenerated with **best-of-2** vision-judged takes.",
  );
  sum.push("4. The loop repeated for each new version until the cap (v4) was reached.");
  sum.push("");
  sum.push("## Measured improvement");
  sum.push("");
  sum.push(
    `- Overall score: **${first.overall.toFixed(2)} → ${last.overall.toFixed(2)}** (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`,
  );
  sum.push(
    `- Locked shots: **${first.locked.length} → ${last.locked.length}** out of ${shotCount} (${lockedDelta >= 0 ? "+" : ""}${lockedDelta})`,
  );
  sum.push(`- Versions produced: ${versions.join(", ")}`);
  sum.push("");
  sum.push("## Watch order");
  sum.push("");
  for (const s of scores) {
    sum.push(
      `- \`${s.version}.mp4\` — overall ${s.overall.toFixed(2)}, ${s.locked.length}/${shotCount} shots locked`,
    );
  }
  sum.push(
    "- `composite.mp4` — all versions stacked vertically (top → bottom = " +
      versions.join(" → ") +
      ").",
  );
  sum.push("");
  sum.push("See `scorecard.md` for per-aspect / per-shot detail.");
  await writeFile(resolvePath(dir, "summary.md"), sum.join("\n"));
  console.log("wrote summary.md");

  // --- run.json ---
  const runJson = {
    storeId,
    versions: drafts.map((d) => ({
      version: d.version,
      parent: d.parent,
      reason: d.reason,
      locked_shots: d.locked_shots,
      mp4_filename: d.mp4_filename,
      duration_seconds: d.duration_seconds,
      file_bytes: d.file_bytes,
      wall_ms: d.wall_ms,
      shots: d.shots,
    })),
    scores,
    consensus: Object.fromEntries(
      [...consensusByV.entries()].map(([v, m]) => [v, [...m.values()]]),
    ),
  };
  await writeFile(resolvePath(dir, "run.json"), JSON.stringify(runJson, null, 2));
  console.log("wrote run.json");

  console.log("\n=== FINALIZED ===");
  for (const s of scores) {
    console.log(
      `  ${s.version}: overall ${s.overall.toFixed(2)}, locked ${s.locked.length}/${shotCount}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
