import { describe, expect, it } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { debugLog, withTiming, type DebugRow } from "./debug-log";

const TMP_ROOT = resolvePath(import.meta.dir, "../../.tmp-debug-log-test");

async function cleanup(): Promise<void> {
  await rm(TMP_ROOT, { recursive: true, force: true });
}

describe("debugLog", () => {
  it("appends a round-trip JSON line", async () => {
    await cleanup();
    const row: DebugRow = {
      ts: "2026-01-01T00:00:00.000Z",
      briefId: "test-brief",
      phase: "A",
      kind: "claude_create",
      model: "claude-sonnet-4-5",
      durMs: 123,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
      retry: 0,
      extra: { foo: "bar" },
    };
    await debugLog(row, TMP_ROOT);
    const content = await readFile(resolvePath(TMP_ROOT, "test-brief", "debug.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as DebugRow;
    expect(parsed.briefId).toBe("test-brief");
    expect(parsed.phase).toBe("A");
    expect(parsed.kind).toBe("claude_create");
    expect(parsed.model).toBe("claude-sonnet-4-5");
    expect(parsed.durMs).toBe(123);
    expect(parsed.tokensIn).toBe(100);
    expect(parsed.tokensOut).toBe(50);
    expect(parsed.costUsd).toBe(0.001);
    expect(parsed.retry).toBe(0);
    expect(parsed.extra).toEqual({ foo: "bar" });
    await cleanup();
  });

  it("auto-creates the dir when it does not exist", async () => {
    await cleanup();
    const row: DebugRow = {
      ts: new Date().toISOString(),
      briefId: "new-brief",
      phase: "B",
      kind: "fal_submit",
    };
    await debugLog(row, TMP_ROOT);
    const content = await readFile(resolvePath(TMP_ROOT, "new-brief", "debug.jsonl"), "utf8");
    expect(content.trim().length).toBeGreaterThan(0);
    await cleanup();
  });

  it("appends multiple rows sequentially", async () => {
    await cleanup();
    const rows: DebugRow[] = [
      { ts: "t1", briefId: "seq-brief", phase: "A", kind: "start" },
      { ts: "t2", briefId: "seq-brief", phase: "A", kind: "end" },
      { ts: "t3", briefId: "seq-brief", phase: "B", kind: "gate" },
    ];
    for (const row of rows) {
      await debugLog(row, TMP_ROOT);
    }
    const content = await readFile(resolvePath(TMP_ROOT, "seq-brief", "debug.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);
    await cleanup();
  });
});

describe("withTiming", () => {
  it("returns elapsed time >= 0", async () => {
    const { result, durMs } = await withTiming(async () => 42);
    expect(result).toBe(42);
    expect(durMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates errors cleanly from malformed dir path (debugLog error path)", async () => {
    const row: DebugRow = {
      ts: new Date().toISOString(),
      briefId: "bad\x00brief",
      phase: "A",
      kind: "test",
    };
    await expect(debugLog(row, "/nonexistent-root-path-that-cannot-be-created/x")).rejects.toThrow();
  });
});
