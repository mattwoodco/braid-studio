import { test, expect, beforeEach } from "bun:test";
import {
  type DraftEnvelope,
  type DraftsStorage,
  type Head,
  listDrafts,
  nextVersion,
  readDraft,
  readHead,
  setDraftsStorage,
  writeDraft,
  writeHead,
} from "./drafts";

type StoredEntry = { id: string; path: string; content: string; updatedAt: string };

function makeFakeStorage(): {
  storage: DraftsStorage;
  entries: Map<string, StoredEntry>;
  calls: { create: number; update: number; list: number; read: number };
} {
  const entries = new Map<string, StoredEntry>();
  const calls = { create: 0, update: 0, list: 0, read: 0 };
  let idCounter = 0;
  const storage: DraftsStorage = {
    async create(storeId, path, content) {
      calls.create++;
      if (entries.has(`${storeId}::${path}`)) {
        throw new Error(`already exists: ${path}`);
      }
      idCounter++;
      const entry: StoredEntry = {
        id: `mem_${idCounter}`,
        path,
        content,
        updatedAt: new Date().toISOString(),
      };
      entries.set(`${storeId}::${path}`, entry);
      return { id: entry.id, path: entry.path, content: entry.content };
    },
    async update(storeId, memoryId, content) {
      calls.update++;
      for (const [key, entry] of entries) {
        if (entry.id === memoryId && key.startsWith(`${storeId}::`)) {
          entry.content = content;
          entry.updatedAt = new Date().toISOString();
          return { id: entry.id, path: entry.path, content: entry.content };
        }
      }
      throw new Error(`not found: ${memoryId}`);
    },
    async list(storeId, prefix) {
      calls.list++;
      const out: { id: string; path: string }[] = [];
      for (const [key, entry] of entries) {
        if (!key.startsWith(`${storeId}::`)) continue;
        if (prefix && !entry.path.startsWith(prefix)) continue;
        out.push({ id: entry.id, path: entry.path });
      }
      return out;
    },
    async read(storeId, memoryId) {
      calls.read++;
      for (const [key, entry] of entries) {
        if (entry.id === memoryId && key.startsWith(`${storeId}::`)) {
          return { id: entry.id, path: entry.path, content: entry.content };
        }
      }
      throw new Error(`not found: ${memoryId}`);
    },
  };
  return { storage, entries, calls };
}

function makeEnvelope(version: string, parent: string | null = null): DraftEnvelope {
  return {
    version,
    parent,
    reason: "create",
    locked_shots: [],
    shots: [{ n: 0, prompt: "p", video_url: null }],
    mp4_filename: `${version}.mp4`,
    duration_seconds: 1,
    file_bytes: 100,
    wall_ms: 50,
    model_used: "test",
    updated_at: new Date().toISOString(),
  };
}

let fake: ReturnType<typeof makeFakeStorage>;
const STORE = "store_1";

beforeEach(() => {
  fake = makeFakeStorage();
  setDraftsStorage(fake.storage);
});

test("nextVersion returns v1 for empty array", () => {
  expect(nextVersion([])).toBe("v1");
});

test("nextVersion sorts numerically not lexicographically", () => {
  expect(nextVersion(["v1", "v2", "v10"])).toBe("v11");
});

test("nextVersion handles unordered input", () => {
  expect(nextVersion(["v10", "v1", "v3", "v9"])).toBe("v11");
});

test("nextVersion ignores invalid version strings", () => {
  expect(nextVersion(["v1", "v2", "garbage", "HEAD.json"])).toBe("v3");
});

test("writeDraft writes envelope to /memory/drafts/{version}.json", async () => {
  const env = makeEnvelope("v1");
  await writeDraft(STORE, env);
  const stored = fake.entries.get(`${STORE}::/memory/drafts/v1.json`);
  expect(stored).toBeDefined();
  expect(JSON.parse(stored?.content ?? "")).toEqual(env);
});

test("writeDraft rejects duplicate version", async () => {
  const env = makeEnvelope("v1");
  await writeDraft(STORE, env);
  await expect(writeDraft(STORE, makeEnvelope("v1"))).rejects.toThrow();
});

test("listDrafts returns ascending by numeric suffix", async () => {
  await writeDraft(STORE, makeEnvelope("v1"));
  await writeDraft(STORE, makeEnvelope("v2"));
  await writeDraft(STORE, makeEnvelope("v10"));
  const list = await listDrafts(STORE);
  expect(list.map((d) => d.version)).toEqual(["v1", "v2", "v10"]);
});

test("listDrafts ignores HEAD.json and non-matching paths", async () => {
  await writeDraft(STORE, makeEnvelope("v1"));
  // Inject HEAD and stray file directly
  await fake.storage.create(
    STORE,
    "/memory/drafts/HEAD.json",
    JSON.stringify({ version: "v1", updated_at: "x" }),
  );
  await fake.storage.create(STORE, "/memory/drafts/notes.txt", "stray");
  const list = await listDrafts(STORE);
  expect(list.map((d) => d.version)).toEqual(["v1"]);
});

test("listDrafts skips malformed envelope JSON silently", async () => {
  await writeDraft(STORE, makeEnvelope("v1"));
  await fake.storage.create(STORE, "/memory/drafts/v2.json", "{not json");
  await writeDraft(STORE, makeEnvelope("v3"));
  const list = await listDrafts(STORE);
  expect(list.map((d) => d.version)).toEqual(["v1", "v3"]);
});

test("readDraft returns envelope by version", async () => {
  const env = makeEnvelope("v1");
  await writeDraft(STORE, env);
  const got = await readDraft(STORE, "v1");
  expect(got).toEqual(env);
});

test("readDraft returns null for unknown version", async () => {
  const got = await readDraft(STORE, "v99");
  expect(got).toBeNull();
});

test("writeHead creates HEAD.json when not present", async () => {
  const head: Head = { version: "v1", updated_at: new Date().toISOString() };
  await writeHead(STORE, head);
  const stored = fake.entries.get(`${STORE}::/memory/drafts/HEAD.json`);
  expect(stored).toBeDefined();
  expect(JSON.parse(stored?.content ?? "")).toEqual(head);
  expect(fake.calls.create).toBeGreaterThanOrEqual(1);
  expect(fake.calls.update).toBe(0);
});

test("writeHead updates HEAD.json when it already exists", async () => {
  await writeHead(STORE, { version: "v1", updated_at: "t1" });
  const createsAfterFirst = fake.calls.create;
  await writeHead(STORE, { version: "v2", updated_at: "t2" });
  expect(fake.calls.update).toBe(1);
  expect(fake.calls.create).toBe(createsAfterFirst);
  const stored = fake.entries.get(`${STORE}::/memory/drafts/HEAD.json`);
  expect(JSON.parse(stored?.content ?? "")).toEqual({ version: "v2", updated_at: "t2" });
});

test("readHead returns null when not present", async () => {
  const head = await readHead(STORE);
  expect(head).toBeNull();
});

test("readHead returns Head when present", async () => {
  const head: Head = { version: "v3", updated_at: "t3" };
  await writeHead(STORE, head);
  const got = await readHead(STORE);
  expect(got).toEqual(head);
});

test("readHead returns null on malformed HEAD.json", async () => {
  await fake.storage.create(STORE, "/memory/drafts/HEAD.json", "{bad");
  const got = await readHead(STORE);
  expect(got).toBeNull();
});
