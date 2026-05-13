import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSpend,
  checkpointPath,
  freshCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  setGateState,
} from "./checkpoint";

async function makeRunDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cp-test-"));
}

describe("checkpoint extension", () => {
  test("freshCheckpoint includes default cumulativeSpendUsd and gateState", () => {
    const cp = freshCheckpoint("brief-1", "store-1");
    expect(cp.cumulativeSpendUsd).toBe(0);
    expect(cp.gateState).toEqual({
      G1: "pending",
      G2: "pending",
      G3: "pending",
      G4: "pending",
      G5: "pending",
      G6: "pending",
    });
  });

  test("loading an old checkpoint without new fields fills defaults", async () => {
    const runDir = await makeRunDir();
    const briefId = "old-brief";
    const now = new Date().toISOString();
    const legacy = {
      briefId,
      storeId: "s",
      startedAt: now,
      updatedAt: now,
      phaseA: { status: "pending" as const },
      phaseB: { status: "pending" as const },
      phaseC: { status: "pending" as const },
    };
    await mkdir(join(runDir, briefId), { recursive: true });
    await writeFile(
      checkpointPath(runDir, briefId),
      JSON.stringify(legacy, null, 2),
    );
    const loaded = await loadCheckpoint(runDir, briefId);
    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error("loaded null");
    expect(loaded.cumulativeSpendUsd).toBe(0);
    expect(loaded.gateState.G1).toBe("pending");
    expect(loaded.gateState.G6).toBe("pending");
  });

  test("setGateState returns new object with updated gate and bumped updatedAt", async () => {
    const cp = freshCheckpoint("b", "s");
    cp.updatedAt = "2020-01-01T00:00:00.000Z";
    const next = setGateState(cp, "G2", "passed");
    expect(next).not.toBe(cp);
    expect(next.gateState.G2).toBe("passed");
    expect(cp.gateState.G2).toBe("pending");
    expect(next.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("addSpend returns new object with summed spend and bumped updatedAt", () => {
    const cp = freshCheckpoint("b", "s");
    cp.updatedAt = "2020-01-01T00:00:00.000Z";
    const next = addSpend(cp, 1.25);
    const next2 = addSpend(next, 0.75);
    expect(next).not.toBe(cp);
    expect(next.cumulativeSpendUsd).toBe(1.25);
    expect(next2.cumulativeSpendUsd).toBe(2);
    expect(cp.cumulativeSpendUsd).toBe(0);
    expect(next.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("round-trip persists new fields", async () => {
    const runDir = await makeRunDir();
    let cp = freshCheckpoint("rt", "store");
    cp = setGateState(cp, "G3", "passed");
    cp = setGateState(cp, "G4", "halted");
    cp = addSpend(cp, 3.5);
    await saveCheckpoint(runDir, cp);

    const raw = JSON.parse(
      await readFile(checkpointPath(runDir, "rt"), "utf8"),
    );
    expect(raw.cumulativeSpendUsd).toBe(3.5);
    expect(raw.gateState.G3).toBe("passed");
    expect(raw.gateState.G4).toBe("halted");

    const loaded = await loadCheckpoint(runDir, "rt");
    if (!loaded) throw new Error("null");
    expect(loaded.cumulativeSpendUsd).toBe(3.5);
    expect(loaded.gateState.G3).toBe("passed");
    expect(loaded.gateState.G4).toBe("halted");
    expect(loaded.gateState.G1).toBe("pending");
  });
});
