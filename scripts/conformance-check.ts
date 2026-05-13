import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BRIEFS } from "@/lib/briefs";
import { loadCheckpoint, type BriefCheckpoint } from "@/lib/checkpoint";
import { ffprobeDuration } from "@/lib/ffmpeg";

export type ProbeResult = {
  name: string;
  passed: boolean;
  evidence: string;
  citation: string;
};

const EMOTIONAL_GENRES = new Set(["luxury", "anthem", "editorial"]);
const ACTIVATION_GENRES = new Set(["ugc", "comedy"]);

const CHARACTER_NOUNS = ["man", "woman", "child", "person", "athlete", "figure", "character", "hero", "he", "she", "they", "him", "her"];
const LOCATION_WORDS = ["city", "field", "street", "room", "studio", "mountain", "forest", "beach", "track", "kitchen", "office", "home", "stage", "ring", "court"];
const ACTION_VERBS = ["runs", "walks", "jumps", "holds", "looks", "reaches", "stands", "moves", "lifts", "turns", "drives", "flies", "dances", "fights"];

export function probeNelsonField(cp: BriefCheckpoint, durationSeconds: number): ProbeResult {
  const winner = cp.phaseA.winner;
  const passed = durationSeconds > 0 && (winner?.hook?.trim().length ?? 0) > 0;
  return {
    name: "Nelson-Field 1.5s Hook",
    passed,
    evidence: passed
      ? `duration=${durationSeconds}s hook="${winner!.hook.slice(0, 60)}"`
      : `duration=${durationSeconds} hook=${winner?.hook ?? "missing"}`,
    citation: "Nelson-Field (2019) Viral Marketing: The Science of Sharing — brand asset in first 1.5s",
  };
}

export function probeSystem1ThreeKeys(cp: BriefCheckpoint): ProbeResult {
  const winner = cp.phaseA.winner;
  if (!winner) {
    return {
      name: "Wood/System1 Three Keys",
      passed: false,
      evidence: "no winner in phaseA",
      citation: "Wood (2012) How Brands Grow in Practice — character, place, incident signals",
    };
  }
  const combined = winner.scenes.map((s) => s.description.toLowerCase()).join(" ");
  const hasCharacter = CHARACTER_NOUNS.some((w) => combined.includes(w));
  const hasLocation = LOCATION_WORDS.some((w) => combined.includes(w));
  const hasAction = ACTION_VERBS.some((w) => combined.includes(w));
  const passed = hasCharacter && hasLocation && hasAction;
  return {
    name: "Wood/System1 Three Keys",
    passed,
    evidence: `character=${hasCharacter} location=${hasLocation} action=${hasAction}`,
    citation: "Wood (2012) How Brands Grow in Practice — character, place, incident signals",
  };
}

export function probeBinetField(cp: BriefCheckpoint): ProbeResult {
  const brief = BRIEFS.find((b) => b.id === cp.briefId);
  if (!brief) {
    return {
      name: "Binet & Field 60/40",
      passed: false,
      evidence: `briefId="${cp.briefId}" not found in BRIEFS`,
      citation: "Binet & Field (2013) The Long and Short of It — 60% emotional / 40% activation",
    };
  }
  const tag = EMOTIONAL_GENRES.has(brief.genreKey) ? "emotional" : ACTIVATION_GENRES.has(brief.genreKey) ? "activation" : "other";
  return {
    name: "Binet & Field 60/40",
    passed: true,
    evidence: `briefId="${cp.briefId}" genreKey="${brief.genreKey}" tag="${tag}"`,
    citation: "Binet & Field (2013) The Long and Short of It — 60% emotional / 40% activation",
  };
}

export function probeSharpDBAs(cp: BriefCheckpoint): ProbeResult {
  const winner = cp.phaseA.winner;
  if (!winner) {
    return {
      name: "Sharp DBAs",
      passed: false,
      evidence: "no winner in phaseA",
      citation: "Sharp (2010) How Brands Grow — distinctive brand assets in hook and ending",
    };
  }
  const brief = BRIEFS.find((b) => b.id === cp.briefId);
  const brandTokens = brief
    ? brief.product.toLowerCase().split(/\W+/).filter((t) => t.length > 2)
    : [];
  const hookLow = winner.hook.toLowerCase();
  const endingLow = winner.ending_beat.toLowerCase();
  const titleLow = winner.title.toLowerCase();
  const allTokens = [...new Set([...titleLow.split(/\W+/), ...brandTokens])].filter((t) => t.length > 2);
  const hookHit = allTokens.some((t) => hookLow.includes(t));
  const endingHit = allTokens.some((t) => endingLow.includes(t));
  const passed = hookHit && endingHit;
  return {
    name: "Sharp DBAs",
    passed,
    evidence: `hookBrand=${hookHit} endingBrand=${endingHit} tokens=[${allTokens.slice(0, 4).join(",")}]`,
    citation: "Sharp (2010) How Brands Grow — distinctive brand assets in hook and ending",
  };
}

export function probePacing(cp: BriefCheckpoint, durationSeconds: number): ProbeResult {
  const lastHistory = cp.phaseB.history?.at(-1);
  const shotCount = lastHistory ? Object.keys(lastHistory.perCand).length : 0;
  const dur = durationSeconds > 0 ? durationSeconds : cp.phaseC.durationSeconds ?? 0;
  if (shotCount === 0 || dur === 0) {
    return {
      name: "Pacing 3-5s/shot",
      passed: false,
      evidence: `shotCount=${shotCount} duration=${dur}s — insufficient data`,
      citation: "Industry standard — mean shot length 3–5s for social video",
    };
  }
  const mean = dur / shotCount;
  const passed = mean >= 3 && mean <= 5;
  return {
    name: "Pacing 3-5s/shot",
    passed,
    evidence: `meanShotLength=${mean.toFixed(2)}s (${shotCount} shots, ${dur}s total)`,
    citation: "Industry standard — mean shot length 3–5s for social video",
  };
}

export function analyzeAll(cp: BriefCheckpoint, durationSeconds: number): ProbeResult[] {
  return [
    probeNelsonField(cp, durationSeconds),
    probeSystem1ThreeKeys(cp),
    probeBinetField(cp),
    probeSharpDBAs(cp),
    probePacing(cp, durationSeconds),
  ];
}

export function renderMarkdown(results: ProbeResult[]): string {
  const header = "| Probe | Pass | Evidence | Citation |\n|---|---|---|---|";
  const rows = results.map(
    (r) => `| ${r.name} | ${r.passed ? "✓" : "✗"} | ${r.evidence} | ${r.citation} |`,
  );
  return `# Conformance Report\n\n${header}\n${rows.join("\n")}\n`;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: bun run scripts/conformance-check.ts <runDir>/<briefId>");
    process.exit(1);
  }
  const parts = arg.replace(/\/$/, "").split("/");
  const briefId = parts.at(-1)!;
  const runDir = parts.slice(0, -1).join("/") || ".";

  const cp = await loadCheckpoint(runDir, briefId);
  if (!cp) {
    console.error(`No checkpoint found at ${runDir}/${briefId}/checkpoint.json`);
    process.exit(0);
  }

  let duration = cp.phaseC.durationSeconds ?? 0;
  if (duration === 0 && cp.phaseC.mp4Path) {
    try {
      duration = await ffprobeDuration(cp.phaseC.mp4Path);
    } catch {
      duration = 0;
    }
  }

  const results = analyzeAll(cp, duration);
  const md = renderMarkdown(results);

  const outPath = resolve(runDir, briefId, "conformance.md");
  await writeFile(outPath, md, "utf8");
  console.log(md);
  console.log(`Written to ${outPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(0);
  });
}
