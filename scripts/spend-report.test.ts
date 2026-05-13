import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SpendRow,
  main,
  renderMarkdown,
  summarize,
} from "./spend-report";

function row(partial: Partial<SpendRow>): SpendRow {
  return {
    ts: "2026-05-13T00:00:00Z",
    briefId: "brief-a",
    phase: "G1",
    kind: "anthropic",
    model: "claude-opus-4-7",
    tokens: 1000,
    durationMs: 500,
    cost: 0.01,
    ...partial,
  };
}

test("summarize groups by brief, phase, kind and totals", () => {
  const rows: SpendRow[] = [
    row({ briefId: "brief-a", phase: "G1", kind: "anthropic", cost: 0.10 }),
    row({ briefId: "brief-a", phase: "G1", kind: "anthropic", cost: 0.20 }),
    row({ briefId: "brief-a", phase: "G3", kind: "fal", cost: 1.50 }),
    row({ briefId: "brief-b", phase: "G1", kind: "anthropic", cost: 0.05 }),
  ];
  const s = summarize(rows);
  expect(s.byBrief).toHaveLength(2);
  expect(s.grandTotal).toBeCloseTo(1.85, 6);
  const a = s.byBrief.find((b) => b.briefId === "brief-a");
  const b = s.byBrief.find((b) => b.briefId === "brief-b");
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  if (!a || !b) return;
  expect(a.total).toBeCloseTo(1.80, 6);
  expect(a.byPhase.G1).toBeCloseTo(0.30, 6);
  expect(a.byPhase.G3).toBeCloseTo(1.50, 6);
  expect(a.byKind.anthropic).toBeCloseTo(0.30, 6);
  expect(a.byKind.fal).toBeCloseTo(1.50, 6);
  expect(b.total).toBeCloseTo(0.05, 6);
});

test("summarize handles empty input", () => {
  const s = summarize([]);
  expect(s.byBrief).toHaveLength(0);
  expect(s.grandTotal).toBe(0);
});

test("summarize ignores non-finite costs", () => {
  const rows: SpendRow[] = [
    row({ cost: Number.NaN }),
    row({ cost: 0.5 }),
  ];
  const s = summarize(rows);
  expect(s.grandTotal).toBeCloseTo(0.5, 6);
});

test("renderMarkdown produces brief sections and grand total", () => {
  const md = renderMarkdown({
    byBrief: [
      {
        briefId: "brief-a",
        total: 1.5,
        byPhase: { G1: 0.5, G3: 1.0 },
        byKind: { anthropic: 0.5, fal: 1.0 },
      },
    ],
    grandTotal: 1.5,
  });
  expect(md).toContain("# Spend Report");
  expect(md).toContain("## brief-a");
  expect(md).toContain("$1.5000");
  expect(md).toContain("| Phase | Cost |");
  expect(md).toContain("| G1 | $0.5000 |");
  expect(md).toContain("| Kind | Cost |");
  expect(md).toContain("| fal | $1.0000 |");
  expect(md).toContain("**Grand total:** $1.5000");
});

test("renderMarkdown handles empty summary", () => {
  const md = renderMarkdown({ byBrief: [], grandTotal: 0 });
  expect(md).toContain("no spend records found");
  expect(md).toContain("**Grand total:** $0.0000");
});

test("main globs spend.jsonl and prints markdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spend-report-"));
  try {
    const briefDir = join(dir, "brief-a");
    await mkdir(briefDir, { recursive: true });
    const rows = [
      {
        ts: "2026-05-13T00:00:00Z",
        briefId: "brief-a",
        phase: "G1",
        kind: "anthropic",
        model: "claude",
        tokens: 100,
        durationMs: 10,
        cost: 0.25,
      },
      {
        ts: "2026-05-13T00:00:01Z",
        briefId: "brief-a",
        phase: "G3",
        kind: "fal",
        model: "kling",
        tokens: 0,
        durationMs: 20,
        cost: 0.75,
      },
    ];
    await writeFile(
      join(briefDir, "spend.jsonl"),
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    const nestedDir = join(dir, "brief-b", "sub");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, "spend.jsonl"),
      `${JSON.stringify({
        ts: "2026-05-13T00:00:02Z",
        phase: "G1",
        kind: "anthropic",
        model: "claude",
        tokens: 50,
        durationMs: 5,
        cost: 0.10,
      })}\n\n`,
    );
    const captured: string[] = [];
    await main([dir], (s) => {
      captured.push(s);
    });
    expect(captured).toHaveLength(1);
    const out = captured[0] ?? "";
    expect(out).toContain("## brief-a");
    expect(out).toContain("## brief-b");
    expect(out).toContain("$1.0000");
    expect(out).toContain("$0.1000");
    expect(out).toContain("**Grand total:** $1.1000");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("main with missing arg prints usage", async () => {
  const captured: string[] = [];
  await main([], (s) => {
    captured.push(s);
  });
  expect(captured[0] ?? "").toContain("usage:");
});

test("main with non-existent dir prints empty report", async () => {
  const captured: string[] = [];
  await main([join(tmpdir(), `does-not-exist-${Date.now()}`)], (s) => {
    captured.push(s);
  });
  expect(captured[0] ?? "").toContain("no spend records found");
});
