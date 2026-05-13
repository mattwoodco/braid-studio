import { describe, expect, test } from "bun:test";
import type { Dream } from "./anthropic";
import {
  DEFAULT_INSTRUCTIONS,
  TasteDreamEmptyInputError,
  TasteDreamFailedError,
  TasteDreamNoOutputError,
  type TasteDreamCreateInput,
  type TasteDreamDeps,
  runTasteDream,
} from "./taste-dream";

function makeDream(overrides: Partial<Dream> = {}): Dream {
  return {
    id: "dream_1",
    status: "pending",
    model: "claude-sonnet-4-6",
    inputs: [],
    outputs: [],
    sessionId: null,
    createdAt: null,
    updatedAt: null,
    usage: null,
    raw: null,
    ...overrides,
  };
}

type Call = { kind: "create"; input: TasteDreamCreateInput } | { kind: "get"; id: string };

function makeDeps(scriptedStatuses: ReadonlyArray<Dream>): {
  deps: TasteDreamDeps;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const deps: TasteDreamDeps = {
    pollIntervalMs: 0,
    maxPolls: 50,
    async createDream(input) {
      calls.push({ kind: "create", input });
      const first = scriptedStatuses[0];
      if (!first) throw new Error("test: no scripted dream provided");
      index = 1;
      return first;
    },
    async getDream(id) {
      calls.push({ kind: "get", id });
      const next = scriptedStatuses[index];
      index++;
      if (!next) throw new Error("test: exhausted scripted dreams");
      return next;
    },
  };
  return { deps, calls };
}

describe("runTasteDream", () => {
  test("polls until completed and returns output memory store id", async () => {
    const { deps, calls } = makeDeps([
      makeDream({ id: "d1", status: "running" }),
      makeDream({ id: "d1", status: "running" }),
      makeDream({
        id: "d1",
        status: "completed",
        outputs: [{ type: "memory_store", memory_store_id: "memstore_taste_v2" }],
      }),
    ]);

    const result = await runTasteDream(
      { briefStoreIds: ["memstore_brief_a", "memstore_brief_b"] },
      deps,
    );

    expect(result.tasteStoreId).toBe("memstore_taste_v2");
    const creates = calls.filter((c) => c.kind === "create");
    expect(creates).toHaveLength(1);
    const create = creates[0];
    if (!create || create.kind !== "create") throw new Error("unreachable");
    expect(create.input.memory_store_ids).toEqual(["memstore_brief_a", "memstore_brief_b"]);
    expect(create.input.instructions).toBe(DEFAULT_INSTRUCTIONS);
    expect(calls.filter((c) => c.kind === "get")).toHaveLength(2);
  });

  test("forwards previousTasteStoreId as the last memory_store_ids entry", async () => {
    const { deps, calls } = makeDeps([
      makeDream({
        id: "d2",
        status: "completed",
        outputs: [{ type: "memory_store", memory_store_id: "memstore_taste_v3" }],
      }),
    ]);

    await runTasteDream(
      {
        briefStoreIds: ["memstore_brief_a"],
        previousTasteStoreId: "memstore_taste_v1",
      },
      deps,
    );

    const create = calls.find((c) => c.kind === "create");
    if (!create || create.kind !== "create") throw new Error("unreachable");
    expect(create.input.memory_store_ids).toEqual([
      "memstore_brief_a",
      "memstore_taste_v1",
    ]);
  });

  test("uses override instructions when provided", async () => {
    const { deps, calls } = makeDeps([
      makeDream({
        id: "d3",
        status: "completed",
        outputs: [{ type: "memory_store", memory_store_id: "memstore_taste_v4" }],
      }),
    ]);

    await runTasteDream(
      { briefStoreIds: ["memstore_brief_a"], instructions: "custom curation" },
      deps,
    );

    const create = calls.find((c) => c.kind === "create");
    if (!create || create.kind !== "create") throw new Error("unreachable");
    expect(create.input.instructions).toBe("custom curation");
  });

  test("throws TasteDreamFailedError when dream status becomes failed", async () => {
    const { deps } = makeDeps([
      makeDream({ id: "d4", status: "running" }),
      makeDream({ id: "d4", status: "failed" }),
    ]);

    await expect(
      runTasteDream({ briefStoreIds: ["memstore_brief_a"] }, deps),
    ).rejects.toBeInstanceOf(TasteDreamFailedError);
  });

  test("throws TasteDreamNoOutputError when completed but outputs empty", async () => {
    const { deps } = makeDeps([
      makeDream({ id: "d5", status: "completed", outputs: [] }),
    ]);

    await expect(
      runTasteDream({ briefStoreIds: ["memstore_brief_a"] }, deps),
    ).rejects.toBeInstanceOf(TasteDreamNoOutputError);
  });

  test("rejects empty briefStoreIds", async () => {
    const { deps } = makeDeps([]);
    await expect(runTasteDream({ briefStoreIds: [] }, deps)).rejects.toBeInstanceOf(
      TasteDreamEmptyInputError,
    );
  });

  test("returns immediately when first response is already completed", async () => {
    const { deps, calls } = makeDeps([
      makeDream({
        id: "d6",
        status: "completed",
        outputs: [{ type: "memory_store", memory_store_id: "memstore_taste_v5" }],
      }),
    ]);
    const result = await runTasteDream({ briefStoreIds: ["memstore_brief_a"] }, deps);
    expect(result.tasteStoreId).toBe("memstore_taste_v5");
    expect(calls.filter((c) => c.kind === "get")).toHaveLength(0);
  });
});
