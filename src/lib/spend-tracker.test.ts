import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordCall,
  cumulativeSpend,
  computeCost,
  type SpendRow,
} from "./spend-tracker";

async function makeRunDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "spend-tracker-"));
}

describe("computeCost", () => {
  test("anthropic haiku 4.5 token pricing", () => {
    const c = computeCost("claude_messages", "claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(c).toBeCloseTo(6, 6);
  });

  test("anthropic sonnet 4.6 pricing", () => {
    const c = computeCost("claude_messages", "claude-sonnet-4-6", 1_000_000, 0);
    expect(c).toBeCloseTo(3, 6);
  });

  test("anthropic opus 4.7 pricing with cached input at 10%", () => {
    const c = computeCost(
      "claude_messages",
      "claude-opus-4-7",
      1_000_000,
      1_000_000,
      1_000_000,
    );
    expect(c).toBeCloseTo(1.5 + 75, 6);
  });

  test("fal flat prices", () => {
    expect(computeCost("fal_image", "any")).toBeCloseTo(0.025, 6);
    expect(computeCost("fal_video_hailuo", "any")).toBeCloseTo(0.56, 6);
    expect(computeCost("fal_video_kling_std", "any")).toBeCloseTo(0.8, 6);
    expect(computeCost("fal_video_veo3", "any")).toBeCloseTo(1.5, 6);
  });

  test("unknown model returns 0", () => {
    expect(computeCost("claude_messages", "unknown-model", 1000, 1000)).toBe(0);
  });
});

describe("recordCall + cumulativeSpend", () => {
  test("appends jsonl and sums cost_usd", async () => {
    const runDir = await makeRunDir();
    const briefId = "brief-1";

    const row1: SpendRow = {
      ts: new Date().toISOString(),
      briefId,
      kind: "claude_messages",
      model: "claude-haiku-4-5",
      tokens_in: 1000,
      tokens_out: 1000,
      cost_usd: computeCost("claude_messages", "claude-haiku-4-5", 1000, 1000),
    };
    const row2: SpendRow = {
      ts: new Date().toISOString(),
      briefId,
      kind: "fal_image",
      cost_usd: computeCost("fal_image", "any"),
    };

    await recordCall(row1, runDir);
    await recordCall(row2, runDir);

    const path = join(runDir, briefId, "spend.jsonl");
    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);

    const total = await cumulativeSpend(runDir, briefId);
    expect(total).toBeCloseTo(row1.cost_usd + row2.cost_usd, 9);
  });

  test("cumulativeSpend returns 0 when file missing", async () => {
    const runDir = await makeRunDir();
    const total = await cumulativeSpend(runDir, "missing");
    expect(total).toBe(0);
  });
});
