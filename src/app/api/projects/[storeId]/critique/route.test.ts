import { test, expect, beforeEach } from "bun:test";
import {
  type ManagedAgentClient,
  type IncomingSessionEvent,
  type OutgoingSessionEvent,
  setManagedAgentClient,
} from "@/lib/anthropic";
import { CRITIQUE_ASPECTS } from "@/lib/critique";
import {
  type DraftEnvelope,
  type DraftsStorage,
  setDraftsStorage,
  writeDraft,
  writeHead,
} from "@/lib/drafts";
import { setTasteStoreId } from "@/lib/taste";
import { VIDEO_RUBRIC_TEMPLATE } from "@/lib/video-rubric";
import { POST } from "./route";

process.env.AGENT_ID ??= "agent_test";
process.env.ENV_ID ??= "env_test";
process.env.VAULT_ID ??= "vault_test";
process.env.ANTHROPIC_API_KEY ??= "test_key";
process.env.FAL_API_KEY ??= "test_fal";

type Recorded =
  | { kind: "create"; params: Parameters<ManagedAgentClient["createSession"]>[0] }
  | { kind: "send"; sessionId: string; event: OutgoingSessionEvent };

function makeRecordingClient() {
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
    streamSession(): AsyncIterable<IncomingSessionEvent> {
      return { async *[Symbol.asyncIterator]() {} };
    },
  };
  return { client, log };
}

type StoredEntry = { id: string; path: string; content: string };
function makeFakeStorage(): { storage: DraftsStorage; entries: Map<string, StoredEntry> } {
  const entries = new Map<string, StoredEntry>();
  let idCounter = 0;
  const storage: DraftsStorage = {
    async create(storeId, path, content) {
      idCounter++;
      const key = `${storeId}::${path}`;
      if (entries.has(key)) throw new Error("exists");
      const entry = { id: `mem_${idCounter}`, path, content };
      entries.set(key, entry);
      return entry;
    },
    async update(storeId, memoryId, content) {
      for (const [key, e] of entries) {
        if (e.id === memoryId && key.startsWith(`${storeId}::`)) {
          e.content = content;
          return e;
        }
      }
      throw new Error("not found");
    },
    async list(storeId, prefix) {
      const out: { id: string; path: string }[] = [];
      for (const [k, e] of entries) {
        if (!k.startsWith(`${storeId}::`)) continue;
        if (prefix && !e.path.startsWith(prefix)) continue;
        out.push({ id: e.id, path: e.path });
      }
      return out;
    },
    async read(_s, memoryId) {
      for (const e of entries.values()) if (e.id === memoryId) return e;
      throw new Error("not found");
    },
  };
  return { storage, entries };
}

function envelope(version: string): DraftEnvelope {
  return {
    version,
    parent: null,
    reason: "create",
    locked_shots: [],
    shots: [
      { n: 0, prompt: `prompt-0-${version}`, video_url: "https://example/v.mp4" },
      { n: 1, prompt: `prompt-1-${version}`, video_url: "https://example/v.mp4" },
    ],
    mp4_filename: `${version}.mp4`,
    duration_seconds: 5,
    file_bytes: 100,
    wall_ms: 50,
    model_used: "test",
    updated_at: "t",
  };
}

const STORE = "store_x";
let rec: ReturnType<typeof makeRecordingClient>;

beforeEach(() => {
  rec = makeRecordingClient();
  setManagedAgentClient(rec.client);
  const fake = makeFakeStorage();
  setDraftsStorage(fake.storage);
  setTasteStoreId(null);
});

function post(body?: object): Promise<Response> {
  return POST(
    new Request(`http://test/critique`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
    { params: Promise.resolve({ storeId: STORE }) },
  );
}

test("404 when no draft exists", async () => {
  const res = await post();
  expect(res.status).toBe(404);
});

test("uses HEAD when draftVersion omitted, and writes correct Managed-Agent calls", async () => {
  await writeDraft(STORE, envelope("v1"));
  await writeHead(STORE, { version: "v1", updated_at: "t" });

  const res = await post();
  expect(res.status).toBe(200);
  const json = (await res.json()) as { sessionId: string };
  expect(json.sessionId).toBe("sess_1");

  // Exactly one createSession call.
  const creates = rec.log.filter((r) => r.kind === "create");
  expect(creates).toHaveLength(1);
  const create = creates[0]!;
  if (create.kind !== "create") throw new Error("unreachable");

  // multiagent coordinator with one sub-agent per aspect.
  expect(create.params.multiagent?.type).toBe("coordinator");
  expect(create.params.multiagent?.agents.length).toBe(CRITIQUE_ASPECTS.length);

  // Project store mounted read_write.
  const projectResource = create.params.resources?.find(
    (r) => r.memory_store_id === STORE,
  );
  expect(projectResource?.access).toBe("read_write");

  // Title mentions the draft version.
  expect(create.params.title).toContain("v1");

  // Outgoing events in order: define_outcome then user.message.
  const sends = rec.log.filter((r) => r.kind === "send");
  expect(sends.length).toBe(2);
  const first = sends[0]!;
  const second = sends[1]!;
  if (first.kind !== "send" || second.kind !== "send") throw new Error("unreachable");
  expect(first.event.type).toBe("user.define_outcome");
  if (first.event.type === "user.define_outcome") {
    expect(first.event.rubric).toBe(VIDEO_RUBRIC_TEMPLATE);
    expect(first.event.maxIterations).toBe(3);
  }
  expect(second.event.type).toBe("user.message");
  if (second.event.type === "user.message") {
    expect(second.event.content).toContain("v1");
    expect(second.event.content).toContain("prompt-0-v1");
  }
});

test("attaches taste store as read_only resource when present", async () => {
  await writeDraft(STORE, envelope("v1"));
  await writeHead(STORE, { version: "v1", updated_at: "t" });
  setTasteStoreId("store_taste_99");

  const res = await post();
  expect(res.status).toBe(200);
  const create = rec.log.find((r) => r.kind === "create");
  if (create?.kind !== "create") throw new Error("unreachable");
  const tasteResource = create.params.resources?.find(
    (r) => r.memory_store_id === "store_taste_99",
  );
  expect(tasteResource).toBeDefined();
  expect(tasteResource?.access).toBe("read_only");
});

test("does NOT attach taste store when absent", async () => {
  await writeDraft(STORE, envelope("v1"));
  await writeHead(STORE, { version: "v1", updated_at: "t" });
  setTasteStoreId(null);

  await post();
  const create = rec.log.find((r) => r.kind === "create");
  if (create?.kind !== "create") throw new Error("unreachable");
  const resources = create.params.resources ?? [];
  expect(resources.length).toBe(1);
  expect(resources[0]?.memory_store_id).toBe(STORE);
});

test("uses provided draftVersion over HEAD", async () => {
  await writeDraft(STORE, envelope("v1"));
  await writeDraft(STORE, envelope("v2"));
  await writeHead(STORE, { version: "v2", updated_at: "t" });

  await post({ draftVersion: "v1" });
  const send = rec.log.find(
    (r) => r.kind === "send" && r.event.type === "user.message",
  );
  if (send?.kind !== "send" || send.event.type !== "user.message")
    throw new Error("unreachable");
  expect(send.event.content).toContain("prompt-0-v1");
  expect(send.event.content).not.toContain("prompt-0-v2");
});
