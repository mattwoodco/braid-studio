/**
 * Managed-Agent contract tests. These pin that production code uses the
 * createSession / sendEvent / streamSession seam — i.e. videos actually go
 * through Managed Agents, not a side-channel.
 */
import { test, expect, beforeEach } from "bun:test";
import {
  type IncomingSessionEvent,
  type ManagedAgentClient,
  type OutgoingSessionEvent,
  createSession,
  resetManagedAgentClient,
  sendEvent,
  setManagedAgentClient,
  streamSession,
} from "./anthropic";

type Recorded =
  | { kind: "create"; params: Parameters<ManagedAgentClient["createSession"]>[0] }
  | { kind: "send"; sessionId: string; event: OutgoingSessionEvent }
  | { kind: "stream-open"; sessionId: string };

function makeRecordingClient(): {
  client: ManagedAgentClient;
  log: Recorded[];
} {
  const log: Recorded[] = [];
  let id = 0;
  const client: ManagedAgentClient = {
    async createSession(params) {
      log.push({ kind: "create", params });
      id++;
      return { sessionId: `sess_${id}` };
    },
    async sendEvent(sessionId, event) {
      log.push({ kind: "send", sessionId, event });
    },
    streamSession(sessionId) {
      log.push({ kind: "stream-open", sessionId });
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<IncomingSessionEvent> {
          // no events for these contract tests
        },
      };
    },
  };
  return { client, log };
}

let rec: ReturnType<typeof makeRecordingClient>;

beforeEach(() => {
  rec = makeRecordingClient();
  setManagedAgentClient(rec.client);
});

test("createSession forwards multiagent.coordinator config", async () => {
  await createSession({
    agentId: "agent_x",
    environmentId: "env_x",
    multiagent: {
      type: "coordinator",
      agents: [
        { id: "agent_x", type: "self" },
        { id: "agent_x", type: "self" },
      ],
    },
  });
  const create = rec.log.find((r) => r.kind === "create");
  expect(create).toBeDefined();
  if (create?.kind !== "create") throw new Error("unreachable");
  expect(create.params.multiagent?.type).toBe("coordinator");
  expect(create.params.multiagent?.agents.length).toBeGreaterThanOrEqual(2);
});

test("user.define_outcome carries rubric and maxIterations", async () => {
  await sendEvent("sess_1", {
    type: "user.define_outcome",
    rubric: "rubric body",
    maxIterations: 3,
  });
  const sent = rec.log.find((r) => r.kind === "send");
  expect(sent).toBeDefined();
  if (sent?.kind !== "send") throw new Error("unreachable");
  expect(sent.event.type).toBe("user.define_outcome");
  if (sent.event.type !== "user.define_outcome") throw new Error("unreachable");
  expect(sent.event.rubric).toBe("rubric body");
  expect(sent.event.maxIterations).toBe(3);
});

test("define_outcome can be sent before user.message (caller-controlled order)", async () => {
  await sendEvent("sess_1", {
    type: "user.define_outcome",
    rubric: "r",
    maxIterations: 3,
  });
  await sendEvent("sess_1", { type: "user.message", content: "go" });
  const sends = rec.log.filter((r) => r.kind === "send");
  expect(sends).toHaveLength(2);
  expect((sends[0] as Recorded & { kind: "send" }).event.type).toBe(
    "user.define_outcome",
  );
  expect((sends[1] as Recorded & { kind: "send" }).event.type).toBe("user.message");
});

test("streamSession can be opened before any sendEvent call", async () => {
  // Open stream first; only iterate once at least one event would arrive (none here).
  const iter = streamSession("sess_1")[Symbol.asyncIterator]();
  // Force the stream-open to register before the send.
  // (Stream is lazy on .next(); pull once to materialize the open record.)
  await iter.next();
  await sendEvent("sess_1", { type: "user.message", content: "hi" });

  const openIdx = rec.log.findIndex((r) => r.kind === "stream-open");
  const sendIdx = rec.log.findIndex((r) => r.kind === "send");
  expect(openIdx).toBeGreaterThanOrEqual(0);
  expect(sendIdx).toBeGreaterThanOrEqual(0);
  expect(openIdx).toBeLessThan(sendIdx);
});

test("resetManagedAgentClient restores default (smoke)", () => {
  resetManagedAgentClient();
  // Calling createSession with no API key would now throw if invoked, which is fine —
  // we just assert reset is callable.
  expect(() => resetManagedAgentClient()).not.toThrow();
});
