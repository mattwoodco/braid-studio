import { test, expect, beforeEach } from "bun:test";
import {
  type ManagedAgentClient,
  setManagedAgentClient,
} from "./anthropic";
import { CRITIQUE_THRESHOLD, aggregate, type CritiqueEnvelope } from "./critique";
import { getTasteStoreId, setTasteStoreId } from "./taste";

beforeEach(() => {
  setTasteStoreId(null);
});

test("taste store id round-trips via set/get", () => {
  expect(getTasteStoreId()).toBeNull();
  setTasteStoreId("store_taste_42");
  expect(getTasteStoreId()).toBe("store_taste_42");
  setTasteStoreId(null);
  expect(getTasteStoreId()).toBeNull();
});

/**
 * Cross-project taste-memory lift:
 *
 * We model the "critic looks at taste memory" contract by giving the fake
 * managed-agent client a per-session bias: if the session was created with a
 * read_only memory_store resource matching the taste store id, the critic
 * emits scores +0.2 higher across the board. The test then asserts that the
 * aggregate overall score of project B (with taste memory) is higher than
 * project A (without).
 */
test("v1 of project B has higher overall when taste memory is attached", async () => {
  setTasteStoreId("store_taste_winners");

  function fakeCritic(sessionHasTasteResource: boolean): CritiqueEnvelope {
    const bias = sessionHasTasteResource ? 0.25 : 0;
    return {
      version: "c1",
      parent_draft: "v1",
      aspect: "cinematography",
      shot_scores: [0, 1, 2].map((n) => ({
        n,
        score: Math.min(1, 0.5 + bias),
        issues: [],
      })),
      overall: Math.min(1, 0.5 + bias),
      summary: "",
      created_at: "t",
    };
  }

  // Track which sessions had taste resource attached.
  const sessionHasTaste = new Map<string, boolean>();
  let id = 0;
  const client: ManagedAgentClient = {
    async createSession(input) {
      id++;
      const sid = `sess_${id}`;
      const hasTaste =
        input.resources?.some(
          (r) =>
            r.memory_store_id === "store_taste_winners" && r.access === "read_only",
        ) ?? false;
      sessionHasTaste.set(sid, hasTaste);
      return { sessionId: sid };
    },
    async sendEvent() {},
    streamSession(): AsyncIterable<never> {
      return {
        async *[Symbol.asyncIterator]() {},
      };
    },
  };
  setManagedAgentClient(client);

  // Project A: critique session created WITHOUT taste resource.
  const { createSession } = await import("./anthropic");
  const a = await createSession({
    agentId: "agent_x",
    environmentId: "env_x",
    resources: [{ type: "memory_store", memory_store_id: "store_A" }],
  });
  // Project B: critique session created WITH taste resource attached read_only.
  const b = await createSession({
    agentId: "agent_x",
    environmentId: "env_x",
    resources: [
      { type: "memory_store", memory_store_id: "store_B" },
      {
        type: "memory_store",
        memory_store_id: "store_taste_winners",
        access: "read_only",
      },
    ],
  });

  const envA = fakeCritic(sessionHasTaste.get(a.sessionId) ?? false);
  const envB = fakeCritic(sessionHasTaste.get(b.sessionId) ?? false);

  const overallA = aggregate([envA]).overall;
  const overallB = aggregate([envB]).overall;
  expect(overallB).toBeGreaterThan(overallA);
  // And taste memory should push B over the lock threshold.
  expect(overallB).toBeGreaterThanOrEqual(CRITIQUE_THRESHOLD);
  expect(overallA).toBeLessThan(CRITIQUE_THRESHOLD);
});
