import { processBrief } from "./full-pipeline-v3";
import { BRIEFS } from "@/lib/briefs";
import { readFile, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve as resolvePath, join } from "node:path";

process.env.AUTO_APPROVE_G4 = "1";

const briefId = process.argv[2] ?? "comedy-bank-app-ugc";
const OUTPUT_DIR = resolvePath(process.cwd(), "data/regression-baseline-2026-05-13", briefId);
const PIPELINE_RUN_DIR = resolvePath(process.cwd(), "data/full-pipeline-v3");
process.env.BRAID_BRIEFS = briefId;
process.env.BRAID_DEBUG_DIR = PIPELINE_RUN_DIR;

async function readDebugJsonl(briefDir: string): Promise<Array<Record<string, unknown>>> {
  try {
    const content = await readFile(join(briefDir, "debug.jsonl"), "utf8");
    return content
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function findBriefDebugDir(briefRunId: string): Promise<string> {
  try {
    const runs = await readdir(PIPELINE_RUN_DIR);
    for (const run of runs.slice().reverse()) {
      const candidate = join(PIPELINE_RUN_DIR, run, briefRunId);
      try {
        await readFile(join(candidate, "debug.jsonl"));
        return candidate;
      } catch {
        continue;
      }
    }
  } catch {
    // directory may not exist yet
  }
  return "";
}

function populationVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

async function main(): Promise<void> {
  const brief = BRIEFS.find((b) => b.id === briefId);
  if (!brief) {
    console.error(`Brief not found: ${briefId}`);
    process.exit(1);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const wallStart = Date.now();
  const cp = await processBrief(brief);
  const wallMs = Date.now() - wallStart;

  const briefDebugDir = await findBriefDebugDir(briefId);
  const debugRows = briefDebugDir ? await readDebugJsonl(briefDebugDir) : [];
  const retryCount = debugRows.filter((r) => r["kind"] === "retry").length;

  const lastPhaseBHistory = cp.phaseB.history?.at(-1);
  const phaseBPerCand = lastPhaseBHistory?.perCand ?? {};
  const phaseBValues = Object.values(phaseBPerCand) as number[];
  const subjectContinuityVariance = populationVariance(phaseBValues);
  const scoreFloor = phaseBValues.length > 0 ? Math.min(...phaseBValues) : 0;

  const cpRaw = cp as Record<string, unknown>;
  const cumulativeSpendUsd = typeof cpRaw["cumulativeSpendUsd"] === "number"
    ? cpRaw["cumulativeSpendUsd"]
    : 0;
  const gateStateRaw = cpRaw["gateState"];
  const gateState: Record<string, unknown> =
    gateStateRaw && typeof gateStateRaw === "object"
      ? (gateStateRaw as Record<string, unknown>)
      : {};

  const gateVerdicts = debugRows.filter((r) => r["kind"] === "gate_verdict");

  const summaryLines: string[] = [
    `# Regression Baseline — ${briefId}`,
    `Date: 2026-05-13`,
    `Wall time: ${(wallMs / 1000).toFixed(1)}s`,
    "",
    "## Phase B — Subject Continuity (last iteration)",
    `- Variance: ${subjectContinuityVariance.toFixed(4)}`,
    `- Score floor: ${scoreFloor.toFixed(4)}`,
    `- Per-candidate scores: ${JSON.stringify(phaseBPerCand)}`,
    "",
    "## Cost",
    `- Cumulative spend USD: ${cumulativeSpendUsd.toFixed(6)}`,
    "",
    "## Performance",
    `- Wall time: ${(wallMs / 1000).toFixed(1)}s`,
    `- Retry count: ${retryCount}`,
    `- Debug rows total: ${debugRows.length}`,
    "",
    "## Gate Verdicts",
    ...(gateVerdicts.length > 0
      ? gateVerdicts.map((v) => `- ${JSON.stringify(v)}`)
      : ["- (no gate verdicts recorded)"]),
    "",
    "## Gate State",
    JSON.stringify(gateState, null, 2),
    "",
    "## Pipeline Status",
    `- Phase A: ${cp.phaseA.status}`,
    `- Phase B: ${cp.phaseB.status}`,
    `- Phase C: ${cp.phaseC.status}`,
  ];

  await writeFile(join(OUTPUT_DIR, "SUMMARY.md"), summaryLines.join("\n") + "\n");

  if (briefDebugDir) {
    await Promise.all(
      (["checkpoint.json", "spend.jsonl", "debug.jsonl"] as const).map(async (filename) => {
        try {
          await copyFile(join(briefDebugDir, filename), join(OUTPUT_DIR, filename));
        } catch {
          // file may not exist
        }
      }),
    );
  }

  console.log("=== REGRESSION BASELINE COMPLETE ===");
  console.log("Output:", OUTPUT_DIR);
  console.log("SUMMARY.md written");
  console.log(`Wall time: ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`Phase A: ${cp.phaseA.status}`);
  console.log(`Phase B: ${cp.phaseB.status}`);
  console.log(`Phase C: ${cp.phaseC.status}`);
}

main().catch((err) => {
  console.error("[regression] failed:", err);
  process.exit(1);
});
