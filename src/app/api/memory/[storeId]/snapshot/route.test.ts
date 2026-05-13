import { beforeEach, expect, test } from "bun:test";
import {
  type DraftEnvelope,
  type DraftsStorage,
  type Head,
  setDraftsStorage,
} from "@/lib/drafts";
import type { MemoryEntry } from "@/lib/anthropic";
import {
  GET,
  setSnapshotMemoryLister,
  resetSnapshotMemoryLister,
} from "./route";

type StoredEntry = {
  id: string;
  path: string;
  content: string;
  updatedAt: string;
};

const STORE = "store_test";

function makeFakeStorage(): {
  storage: DraftsStorage;
  entries: Map<string, StoredEntry>;
} {
  const entries = new Map<string, StoredEntry>();
  let idCounter = 0;
  const storage: DraftsStorage = {
    async create(storeId, path, content) {
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

function envelope(
  version: string,
  overrides: Partial<DraftEnvelope> = {},
): DraftEnvelope {
  return {
    version,
    parent: null,
    reason: "create",
    locked_shots: [],
    shots: [
      { n: 0, prompt: "a", video_url: `https://example/${version}/0.mp4` },
      { n: 1, prompt: "b", video_url: `https://example/${version}/1.mp4` },
    ],
    mp4_filename: `${version}.mp4`,
    duration_seconds: 4,
    file_bytes: 1024,
    wall_ms: 1500,
    model_used: "sonnet-4.6",
    updated_at: `2026-05-12T17:00:00Z`,
    ...overrides,
  };
}

async function seedDrafts(
  storage: DraftsStorage,
  envs: DraftEnvelope[],
  head: Head | null,
): Promise<void> {
  for (const e of envs) {
    await storage.create(
      STORE,
      `/memory/drafts/${e.version}.json`,
      JSON.stringify(e),
    );
  }
  if (head) {
    await storage.create(
      STORE,
      "/memory/drafts/HEAD.json",
      JSON.stringify(head),
    );
  }
}

function memoryEntries(input: { path: string; content: string }[]): MemoryEntry[] {
  return input.map((e, i) => ({
    id: `entry_${i}`,
    path: e.path,
    content: e.content,
    updatedAt: "2026-05-12T17:00:00Z",
  }));
}

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/memory/store_test/snapshot", {
    headers,
  });
}

function ctxFor(storeId: string): { params: Promise<{ storeId: string }> } {
  return { params: Promise.resolve({ storeId }) };
}

beforeEach(() => {
  resetSnapshotMemoryLister();
});

test("snapshot returns drafts ascending and head when both present", async () => {
  const { storage } = makeFakeStorage();
  setDraftsStorage(storage);
  const head: Head = { version: "v2", updated_at: "2026-05-12T17:05:00Z" };
  await seedDrafts(
    storage,
    [envelope("v2"), envelope("v1"), envelope("v10")],
    head,
  );
  setSnapshotMemoryLister(async () => memoryEntries([]));

  const res = await GET(makeReq(), ctxFor(STORE));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    drafts: DraftEnvelope[];
    head: Head | null;
  };
  expect(body.drafts.map((d) => d.version)).toEqual(["v1", "v2", "v10"]);
  expect(body.head).toEqual(head);
});

test("snapshot legacy `draft` mirrors HEAD envelope when HEAD exists", async () => {
  const { storage } = makeFakeStorage();
  setDraftsStorage(storage);
  const head: Head = { version: "v1", updated_at: "2026-05-12T17:05:00Z" };
  const env = envelope("v1", {
    mp4_filename: "head.mp4",
    duration_seconds: 7,
    file_bytes: 999,
    wall_ms: 222,
    model_used: "sonnet-4.6",
    updated_at: "2026-05-12T17:01:00Z",
  });
  await seedDrafts(storage, [env], head);
  setSnapshotMemoryLister(async () => memoryEntries([]));

  const res = await GET(makeReq(), ctxFor(STORE));
  const body = (await res.json()) as {
    draft: {
      mp4_filename: string;
      shot_urls: string[];
      duration_seconds: number;
      file_bytes: number;
      wall_ms: number;
      model_used: string | null;
      updated_at: string;
    } | null;
  };
  expect(body.draft).not.toBeNull();
  expect(body.draft?.mp4_filename).toBe("head.mp4");
  expect(body.draft?.shot_urls).toEqual([
    "https://example/v1/0.mp4",
    "https://example/v1/1.mp4",
  ]);
  expect(body.draft?.duration_seconds).toBe(7);
  expect(body.draft?.file_bytes).toBe(999);
  expect(body.draft?.wall_ms).toBe(222);
  expect(body.draft?.model_used).toBe("sonnet-4.6");
  expect(body.draft?.updated_at).toBe("2026-05-12T17:01:00Z");
});

test("snapshot falls back to legacy /memory/draft.json when HEAD absent", async () => {
  const { storage } = makeFakeStorage();
  setDraftsStorage(storage);
  // no drafts, no HEAD
  setSnapshotMemoryLister(async () =>
    memoryEntries([
      {
        path: "/memory/draft.json",
        content: JSON.stringify({
          mp4_filename: "legacy.mp4",
          shot_urls: ["u0", "u1"],
          duration_seconds: 3,
          file_bytes: 42,
          wall_ms: 100,
          model_used: null,
          updated_at: "2026-05-12T16:00:00Z",
        }),
      },
    ]),
  );

  const res = await GET(makeReq(), ctxFor(STORE));
  const body = (await res.json()) as {
    draft: { mp4_filename: string; shot_urls: string[] } | null;
    head: Head | null;
    drafts: DraftEnvelope[];
  };
  expect(body.head).toBeNull();
  expect(body.drafts).toEqual([]);
  expect(body.draft?.mp4_filename).toBe("legacy.mp4");
  expect(body.draft?.shot_urls).toEqual(["u0", "u1"]);
});

test("ETag is stable when state is unchanged across calls", async () => {
  const { storage } = makeFakeStorage();
  setDraftsStorage(storage);
  await seedDrafts(storage, [envelope("v1")], {
    version: "v1",
    updated_at: "2026-05-12T17:00:00Z",
  });
  setSnapshotMemoryLister(async () => memoryEntries([]));

  const r1 = await GET(makeReq(), ctxFor(STORE));
  const r2 = await GET(makeReq(), ctxFor(STORE));
  const e1 = r1.headers.get("ETag");
  const e2 = r2.headers.get("ETag");
  expect(e1).not.toBeNull();
  expect(e1).toBe(e2);
});

test("ETag changes when a new draft envelope is appended", async () => {
  const { storage } = makeFakeStorage();
  setDraftsStorage(storage);
  await seedDrafts(storage, [envelope("v1")], {
    version: "v1",
    updated_at: "2026-05-12T17:00:00Z",
  });
  setSnapshotMemoryLister(async () => memoryEntries([]));

  const r1 = await GET(makeReq(), ctxFor(STORE));
  const e1 = r1.headers.get("ETag");

  // Append v2 and advance HEAD.
  await storage.create(
    STORE,
    "/memory/drafts/v2.json",
    JSON.stringify(envelope("v2", { updated_at: "2026-05-12T17:10:00Z" })),
  );
  // Update HEAD in place — find existing HEAD entry id.
  const all = await storage.list(STORE, "/memory/drafts/");
  const headEntry = all.find((e) => e.path === "/memory/drafts/HEAD.json");
  if (!headEntry) throw new Error("seed: HEAD entry missing");
  await storage.update(
    STORE,
    headEntry.id,
    JSON.stringify({ version: "v2", updated_at: "2026-05-12T17:10:00Z" }),
  );

  const r2 = await GET(makeReq(), ctxFor(STORE));
  const e2 = r2.headers.get("ETag");

  expect(e1).not.toBeNull();
  expect(e2).not.toBeNull();
  expect(e1).not.toBe(e2);
});

test("If-None-Match returns 304 when ETag matches", async () => {
  const { storage } = makeFakeStorage();
  setDraftsStorage(storage);
  await seedDrafts(storage, [envelope("v1")], {
    version: "v1",
    updated_at: "2026-05-12T17:00:00Z",
  });
  setSnapshotMemoryLister(async () => memoryEntries([]));

  const r1 = await GET(makeReq(), ctxFor(STORE));
  const etag = r1.headers.get("ETag");
  expect(etag).not.toBeNull();
  if (etag === null) return;

  const r2 = await GET(makeReq({ "if-none-match": etag }), ctxFor(STORE));
  expect(r2.status).toBe(304);
});
