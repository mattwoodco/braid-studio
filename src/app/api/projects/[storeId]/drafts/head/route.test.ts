import { beforeEach, expect, test } from "bun:test";
import {
  type DraftEnvelope,
  type DraftsStorage,
  setDraftsStorage,
} from "@/lib/drafts";
import { GET, POST } from "./route";

type StoredEntry = { id: string; path: string; content: string };

function makeFakeStorage(): {
  storage: DraftsStorage;
  entries: Map<string, StoredEntry>;
} {
  const entries = new Map<string, StoredEntry>();
  let idCounter = 0;
  const storage: DraftsStorage = {
    async create(storeId, path, content) {
      const key = `${storeId}::${path}`;
      if (entries.has(key)) throw new Error(`already exists: ${path}`);
      idCounter++;
      const entry: StoredEntry = { id: `mem_${idCounter}`, path, content };
      entries.set(key, entry);
      return { id: entry.id, path: entry.path, content: entry.content };
    },
    async update(storeId, memoryId, content) {
      for (const [key, entry] of entries) {
        if (entry.id === memoryId && key.startsWith(`${storeId}::`)) {
          entry.content = content;
          return { id: entry.id, path: entry.path, content: entry.content };
        }
      }
      throw new Error(`not found: ${memoryId}`);
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
    async read(storeId, memoryId) {
      for (const [key, entry] of entries) {
        if (entry.id === memoryId && key.startsWith(`${storeId}::`)) {
          return { id: entry.id, path: entry.path, content: entry.content };
        }
      }
      throw new Error(`not found: ${memoryId}`);
    },
  };
  return { storage, entries };
}

function makeEnvelope(version: string): DraftEnvelope {
  return {
    version,
    parent: null,
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

function seedDraft(
  fake: ReturnType<typeof makeFakeStorage>,
  storeId: string,
  version: string,
): void {
  const env = makeEnvelope(version);
  const path = `/memory/drafts/${version}.json`;
  fake.storage.create(storeId, path, JSON.stringify(env));
}

const STORE = "store_1";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetReq(): Request {
  return new Request("http://localhost/x", { method: "GET" });
}

function makeCtx(storeId: string): { params: Promise<{ storeId: string }> } {
  return { params: Promise.resolve({ storeId }) };
}

let fake: ReturnType<typeof makeFakeStorage>;

beforeEach(() => {
  fake = makeFakeStorage();
  setDraftsStorage(fake.storage);
});

test("POST promote existing version returns 200 with head", async () => {
  await seedDraft(fake, STORE, "v1");
  await seedDraft(fake, STORE, "v2");
  const res = await POST(makeReq({ version: "v2" }), makeCtx(STORE));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { head: { version: string; updated_at: string } };
  expect(body.head.version).toBe("v2");
  expect(typeof body.head.updated_at).toBe("string");
});

test("POST unknown version returns 404", async () => {
  await seedDraft(fake, STORE, "v1");
  const res = await POST(makeReq({ version: "v99" }), makeCtx(STORE));
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("version not found");
});

test("POST current HEAD again is idempotent", async () => {
  await seedDraft(fake, STORE, "v1");
  const first = await POST(makeReq({ version: "v1" }), makeCtx(STORE));
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { head: { version: string } };
  const second = await POST(makeReq({ version: "v1" }), makeCtx(STORE));
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { head: { version: string } };
  expect(secondBody.head.version).toBe(firstBody.head.version);
  expect(secondBody.head.version).toBe("v1");
});

test("GET returns null head when none set", async () => {
  const res = await GET(makeGetReq(), makeCtx(STORE));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { head: null | { version: string } };
  expect(body.head).toBeNull();
});

test("GET after promote returns the head", async () => {
  await seedDraft(fake, STORE, "v1");
  await seedDraft(fake, STORE, "v2");
  await POST(makeReq({ version: "v2" }), makeCtx(STORE));
  const res = await GET(makeGetReq(), makeCtx(STORE));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { head: { version: string; updated_at: string } | null };
  expect(body.head).not.toBeNull();
  expect(body.head?.version).toBe("v2");
});

test("POST invalid body returns 400", async () => {
  const res = await POST(makeReq({}), makeCtx(STORE));
  expect(res.status).toBe(400);
});
