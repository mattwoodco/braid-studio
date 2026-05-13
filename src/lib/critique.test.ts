import { test, expect, beforeEach, describe } from "bun:test";
import {
  type CritiqueEnvelope,
  type CritiqueStorage,
  aggregate,
  CRITIQUE_THRESHOLD,
  listCritiques,
  setCritiqueStorage,
  summarize,
  writeCritique,
} from "./critique";
import type { DraftsStorage } from "./drafts";

type StoredEntry = { id: string; path: string; content: string };

function makeFakeStorage() {
  const entries = new Map<string, StoredEntry>();
  let idCounter = 0;
  const storage: DraftsStorage = {
    async create(storeId, path, content) {
      idCounter++;
      const key = `${storeId}::${path}`;
      if (entries.has(key)) throw new Error(`exists: ${path}`);
      const entry: StoredEntry = { id: `mem_${idCounter}`, path, content };
      entries.set(key, entry);
      return entry;
    },
    async update(storeId, memoryId, content) {
      for (const [key, entry] of entries) {
        if (entry.id === memoryId && key.startsWith(`${storeId}::`)) {
          entry.content = content;
          return entry;
        }
      }
      throw new Error("not found");
    },
    async list(storeId, prefix) {
      const out: { id: string; path: string }[] = [];
      for (const [key, entry] of entries) {
        if (!key.startsWith(`${storeId}::`)) continue;
        if (prefix && !entry.path.startsWith(prefix)) continue;
        out.push({ id: entry.id, path: entry.path });
      }
      return out;
    },
    async read(_storeId, memoryId) {
      for (const entry of entries.values()) {
        if (entry.id === memoryId) return entry;
      }
      throw new Error("not found");
    },
  };
  return { storage: storage as CritiqueStorage, entries };
}

function envelope(
  aspect: CritiqueEnvelope["aspect"],
  scoresByShot: Record<number, number>,
  draftVersion = "v1",
): CritiqueEnvelope {
  return {
    version: `c-${aspect}-${draftVersion}`,
    parent_draft: draftVersion,
    aspect,
    shot_scores: Object.entries(scoresByShot).map(([n, score]) => ({
      n: Number(n),
      score,
      issues: score < 0.7 ? [`${aspect} weak`] : [],
      suggestion: score < 0.7 ? `improve ${aspect} on shot ${n}` : undefined,
    })),
    overall: avg(Object.values(scoresByShot)),
    summary: `${aspect} summary`,
    created_at: new Date().toISOString(),
  };
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

describe("aggregate", () => {
  test("empty input returns empty partition and zero overall", () => {
    const out = aggregate([]);
    expect(out.locked).toEqual([]);
    expect(out.regen).toEqual([]);
    expect(out.overall).toBe(0);
  });

  test("threshold constant is 0.7", () => {
    expect(CRITIQUE_THRESHOLD).toBe(0.7);
  });

  test("partitions 5 shots across 3 aspects at threshold 0.7", () => {
    // Shots 0,1,3: per-aspect averages >= 0.7 → locked
    // Shots 2,4: per-aspect averages < 0.7 → regen
    const envs = [
      envelope("cinematography", { 0: 0.9, 1: 0.8, 2: 0.5, 3: 0.9, 4: 0.4 }),
      envelope("pacing", { 0: 0.8, 1: 0.75, 2: 0.6, 3: 0.85, 4: 0.5 }),
      envelope("color", { 0: 0.95, 1: 0.9, 2: 0.55, 3: 0.8, 4: 0.45 }),
    ];
    const out = aggregate(envs);
    expect(out.locked.sort()).toEqual([0, 1, 3]);
    expect(out.regen.map((r) => r.n).sort()).toEqual([2, 4]);
    expect(out.overall).toBeGreaterThan(0);
    expect(out.overall).toBeLessThan(1);
  });

  test("regen entries carry suggestions merged across aspects", () => {
    const envs = [
      envelope("cinematography", { 0: 0.3 }),
      envelope("pacing", { 0: 0.5 }),
    ];
    const out = aggregate(envs);
    expect(out.regen).toHaveLength(1);
    expect(out.regen[0]!.n).toBe(0);
    expect(out.regen[0]!.suggestion).toContain("cinematography");
    expect(out.regen[0]!.suggestion).toContain("pacing");
  });

  test("shot scored by only some aspects still averages correctly", () => {
    const envs = [
      envelope("cinematography", { 0: 0.9, 1: 0.9 }),
      envelope("pacing", { 0: 0.9 }), // shot 1 missing
    ];
    const out = aggregate(envs);
    expect(out.locked).toContain(1);
  });
});

describe("summarize", () => {
  test("produces reason string starting with 'critique:' and <= 80 chars", () => {
    const envs = [envelope("cinematography", { 0: 0.9, 1: 0.4 })];
    const s = summarize(envs);
    expect(s.startsWith("critique:")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(80);
  });

  test("deterministic for same input", () => {
    const envs = [envelope("color", { 0: 0.8, 1: 0.6 })];
    expect(summarize(envs)).toBe(summarize(envs));
  });
});

describe("storage", () => {
  let fake: ReturnType<typeof makeFakeStorage>;
  const STORE = "store_1";

  beforeEach(() => {
    fake = makeFakeStorage();
    setCritiqueStorage(fake.storage);
  });

  test("writeCritique writes to /memory/critiques/{version}/{aspect}.json", async () => {
    const env = envelope("cinematography", { 0: 0.9 }, "v1");
    await writeCritique(STORE, env);
    const stored = fake.entries.get(
      `${STORE}::/memory/critiques/v1/cinematography.json`,
    );
    expect(stored).toBeDefined();
    expect(JSON.parse(stored?.content ?? "{}").aspect).toBe("cinematography");
  });

  test("listCritiques returns all aspects for a version, ignores other versions", async () => {
    await writeCritique(STORE, envelope("cinematography", { 0: 0.9 }, "v1"));
    await writeCritique(STORE, envelope("pacing", { 0: 0.8 }, "v1"));
    await writeCritique(STORE, envelope("color", { 0: 0.7 }, "v2"));
    const out = await listCritiques(STORE, "v1");
    expect(out.map((e) => e.aspect).sort()).toEqual(["cinematography", "pacing"]);
  });

  test("listCritiques returns [] when no critiques exist", async () => {
    const out = await listCritiques(STORE, "v99");
    expect(out).toEqual([]);
  });
});

describe("improvement invariants", () => {
  test("monotonic: a higher-scored fixture produces higher overall", () => {
    const v1 = [envelope("cinematography", { 0: 0.5, 1: 0.5 })];
    const v2 = [envelope("cinematography", { 0: 0.8, 1: 0.7 })];
    expect(aggregate(v2).overall).toBeGreaterThan(aggregate(v1).overall);
  });

  test("locked-shot count non-decreasing across iterations under non-regression", () => {
    // v1: only shot 0 passes
    const v1 = [envelope("cinematography", { 0: 0.9, 1: 0.4, 2: 0.3 })];
    // v2: shot 0 still passes (no regression), shot 1 also now passes
    const v2 = [envelope("cinematography", { 0: 0.9, 1: 0.8, 2: 0.4 })];
    // v3: shots 0,1 still pass, shot 2 now passes
    const v3 = [envelope("cinematography", { 0: 0.9, 1: 0.8, 2: 0.75 })];
    const a = aggregate(v1).locked.length;
    const b = aggregate(v2).locked.length;
    const c = aggregate(v3).locked.length;
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
  });
});
