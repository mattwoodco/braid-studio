import { describe, expect, it } from "bun:test";
import type { BriefCheckpoint } from "@/lib/checkpoint";
import {
  analyzeAll,
  probeBinetField,
  probeNelsonField,
  probePacing,
  probeSharpDBAs,
  probeSystem1ThreeKeys,
  renderMarkdown,
} from "./conformance-check";

const BASE_WINNER = {
  n: 1,
  title: "Watch Time",
  hook: "A craftsman holds the watch under golden light",
  scenes: [
    { description: "An old man stands in a workshop lifting a watch to the light", duration_seconds: 4 },
    { description: "Close on the dial, hands sweep across a mountain backdrop", duration_seconds: 3 },
  ],
  voiceover_or_dialogue: "Time, perfected.",
  ending_beat: "Watch logo fades in over dark velvet",
};

const BASE_CP: BriefCheckpoint = {
  briefId: "luxury-timepiece-cinematic",
  storeId: "store-1",
  startedAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T01:00:00Z",
  phaseA: { status: "done", winner: BASE_WINNER, history: [] },
  phaseB: {
    status: "done",
    history: [{ version: "v1", overall: 0.9, locked: [1, 2], perCand: { 1: 0.9, 2: 0.8, 3: 0.7 } }],
  },
  phaseC: { status: "done", durationSeconds: 30 },
};

describe("probeNelsonField", () => {
  it("passes when duration > 0 and hook is non-empty", () => {
    const result = probeNelsonField(BASE_CP, 30);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("duration=30");
  });

  it("fails when hook is missing", () => {
    const cp: BriefCheckpoint = {
      ...BASE_CP,
      phaseA: { status: "done", winner: { ...BASE_WINNER, hook: "" } },
    };
    const result = probeNelsonField(cp, 30);
    expect(result.passed).toBe(false);
  });

  it("fails when duration is 0", () => {
    const result = probeNelsonField(BASE_CP, 0);
    expect(result.passed).toBe(false);
  });
});

describe("probeSystem1ThreeKeys", () => {
  it("passes when scenes contain character, location, and action", () => {
    const result = probeSystem1ThreeKeys(BASE_CP);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("character=true");
  });

  it("fails when no winner", () => {
    const cp: BriefCheckpoint = { ...BASE_CP, phaseA: { status: "pending" } };
    const result = probeSystem1ThreeKeys(cp);
    expect(result.passed).toBe(false);
  });
});

describe("probeBinetField", () => {
  it("passes and tags luxury as emotional", () => {
    const result = probeBinetField(BASE_CP);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain('tag="emotional"');
  });

  it("fails when briefId not in BRIEFS", () => {
    const cp: BriefCheckpoint = { ...BASE_CP, briefId: "luxury-timepiece-ugc" };
    const result = probeBinetField(cp);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain("not found");
  });
});

describe("probeSharpDBAs", () => {
  it("passes when brand tokens appear in hook and ending_beat", () => {
    const result = probeSharpDBAs(BASE_CP);
    expect(result.passed).toBe(true);
  });

  it("fails when no winner", () => {
    const cp: BriefCheckpoint = { ...BASE_CP, phaseA: { status: "pending" } };
    const result = probeSharpDBAs(cp);
    expect(result.passed).toBe(false);
  });
});

describe("probePacing", () => {
  it("passes when mean shot length is in [3, 5]", () => {
    const result = probePacing(BASE_CP, 9);
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain("3.00s");
  });

  it("fails when mean shot length is outside [3, 5]", () => {
    const result = probePacing(BASE_CP, 30);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain("10.00s");
  });

  it("falls back to cp.phaseC.durationSeconds when durationSeconds param is 0", () => {
    const result = probePacing(BASE_CP, 0);
    expect(result.evidence).toContain("30s total");
  });
});

describe("analyzeAll + renderMarkdown", () => {
  it("returns 5 probes and renders a markdown table", () => {
    const results = analyzeAll(BASE_CP, 9);
    expect(results).toHaveLength(5);
    const md = renderMarkdown(results);
    expect(md).toContain("# Conformance Report");
    expect(md).toContain("| Probe |");
    expect(md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Probe") && !l.startsWith("|---"))).toHaveLength(5);
  });
});
