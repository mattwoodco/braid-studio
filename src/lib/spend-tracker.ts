import { mkdir, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SpendKind =
  | "claude_messages"
  | "agent_session"
  | "fal_image"
  | "fal_video_hailuo"
  | "fal_video_kling_std"
  | "fal_video_veo3"
  | "dream";

export type SpendRow = {
  ts: string;
  briefId: string;
  phase?: string;
  version?: string;
  aspect?: string;
  seat?: number;
  kind: SpendKind;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  cached_tokens_in?: number;
  duration_ms?: number;
  cost_usd: number;
};

const ANTHROPIC_PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-7": { in: 15, out: 75 },
};

const FAL_PRICES: Partial<Record<SpendKind, number>> = {
  fal_image: 0.025,
  fal_video_hailuo: 0.56,
  fal_video_kling_std: 0.8,
  fal_video_veo3: 1.5,
};

export function computeCost(
  kind: SpendKind,
  model?: string,
  tokens_in = 0,
  tokens_out = 0,
  cached_tokens_in = 0,
  _durationMs?: number,
): number {
  const fal = FAL_PRICES[kind];
  if (fal !== undefined) return fal;
  if (kind === "claude_messages" || kind === "agent_session") {
    const price = model ? ANTHROPIC_PRICES[model] : undefined;
    if (!price) return 0;
    const fresh = Math.max(0, tokens_in - cached_tokens_in);
    return (
      (fresh * price.in) / 1_000_000 +
      (cached_tokens_in * price.in * 0.1) / 1_000_000 +
      (tokens_out * price.out) / 1_000_000
    );
  }
  return 0;
}

function resolveRunDir(override?: string): string {
  if (override) return override;
  const envDir = process.env.RUN_DIR;
  if (envDir) return envDir;
  throw new Error("spend-tracker: runDir not provided and RUN_DIR unset");
}

export async function recordCall(row: SpendRow, runDir?: string): Promise<void> {
  const base = resolveRunDir(runDir);
  const dir = join(base, row.briefId);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "spend.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
}

export async function cumulativeSpend(
  runDir: string,
  briefId: string,
): Promise<number> {
  const path = join(runDir, briefId, "spend.jsonl");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as { cost_usd?: number };
    if (typeof parsed.cost_usd === "number") total += parsed.cost_usd;
  }
  return total;
}
