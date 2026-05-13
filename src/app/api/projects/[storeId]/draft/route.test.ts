/**
 * Unit 4 — Draft route mode router tests.
 *
 * Covers the red/green items in SPEC.md §"Unit 4".
 * Fakes injected via setDraftsStorage, setVideoBackend, and setShotPlanner.
 * No SDK/network calls.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type DraftEnvelope,
  type DraftsStorage,
  listDrafts,
  readDraft,
  readHead,
  setDraftsStorage,
} from "@/lib/drafts";
import {
  type GenerateInput,
  type GenerateOutput,
  type VideoBackend,
  setVideoBackend,
} from "@/lib/video-backend";
import { POST, setShotPlanner } from "./route";

// ---------- Fake drafts storage (reused from drafts.test.ts pattern) ----------

type StoredEntry = { id: string; path: string; content: string; updatedAt: string };

function makeFakeStorage(): {
  storage: DraftsStorage;
  entries: Map<string, StoredEntry>;
} {
  const entries = new Map<string, StoredEntry>();
  let idCounter = 0;
  const storage: DraftsStorage = {
    async create(storeId, path, content) {
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

// ---------- Fake video backend ----------

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Invocation = {
  input: GenerateInput;
  resolve: (v: GenerateOutput) => void;
  reject: (e: unknown) => void;
  promise: Promise<GenerateOutput>;
};

function makeDeferredBackend(): { backend: VideoBackend; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const backend: VideoBackend = {
    generateAndCompose(input: GenerateInput): Promise<GenerateOutput> {
      const d = deferred<GenerateOutput>();
      invocations.push({
        input,
        resolve: d.resolve,
        reject: d.reject,
        promise: d.promise,
      });
      return d.promise;
    },
  };
  return { backend, invocations };
}

function makeImmediateBackend(
  output: (input: GenerateInput) => GenerateOutput,
): {
  backend: VideoBackend;
  calls: GenerateInput[];
} {
  const calls: GenerateInput[] = [];
  const backend: VideoBackend = {
    async generateAndCompose(input: GenerateInput): Promise<GenerateOutput> {
      calls.push(input);
      return output(input);
    },
  };
  return { backend, calls };
}

function defaultOutput(input: GenerateInput): GenerateOutput {
  const locked = input.lockedUrls ?? {};
  const shotUrls: (string | null)[] = [];
  for (let i = 0; i < input.prompts.length; i++) {
    const l = locked[i];
    shotUrls.push(l ?? `gen-${input.outputBasename}-${i}`);
  }
  return {
    shotUrls,
    mp4LocalPath: `/tmp/${input.outputBasename}.mp4`,
    durationSeconds: input.prompts.length * 2,
    fileBytes: 1024,
    modelUsed: "fake-model",
  };
}

// ---------- Helpers ----------

const STORE = "store_test";

function req(body: unknown): Request {
  return new Request("http://localhost/api/projects/store_test/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(): { params: Promise<{ storeId: string }> } {
  return { params: Promise.resolve({ storeId: STORE }) };
}

async function callPOST(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await POST(req(body), ctx());
  const json = (await res.json()) as unknown;
  return { status: res.status, json };
}

// ---------- Fixtures ----------

let fakeStorage: ReturnType<typeof makeFakeStorage>;

beforeEach(() => {
  fakeStorage = makeFakeStorage();
  setDraftsStorage(fakeStorage.storage);
  setShotPlanner(async (_brief, n) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(`prompt-${i}`);
    return out;
  });
});

afterEach(() => {
  setVideoBackend(null);
  setShotPlanner(null);
});

// ---------- create ----------

describe("mode=create", () => {
  test("first call writes v1 and advances HEAD to v1", async () => {
    const { backend } = makeImmediateBackend(defaultOutput);
    setVideoBackend(backend);

    const { status, json } = await callPOST({ brief: "a brief here", shots: 3 });
    expect(status).toBe(200);
    const body = json as { version: string; head: { version: string }; envelope: DraftEnvelope };
    expect(body.version).toBe("v1");
    expect(body.head.version).toBe("v1");
    expect(body.envelope.reason).toBe("create");
    expect(body.envelope.parent).toBeNull();
    expect(body.envelope.shots).toHaveLength(3);

    const drafts = await listDrafts(STORE);
    expect(drafts.map((d) => d.version)).toEqual(["v1"]);
    const head = await readHead(STORE);
    expect(head?.version).toBe("v1");
  });

  test("second call writes v2 and advances HEAD to v2; parent=v1", async () => {
    const { backend } = makeImmediateBackend(defaultOutput);
    setVideoBackend(backend);

    await callPOST({ brief: "first brief here", shots: 2 });
    const { json } = await callPOST({ brief: "second brief here", shots: 2 });
    const body = json as { version: string; head: { version: string }; envelope: DraftEnvelope };
    expect(body.version).toBe("v2");
    expect(body.head.version).toBe("v2");
    expect(body.envelope.parent).toBe("v1");

    const drafts = await listDrafts(STORE);
    expect(drafts.map((d) => d.version)).toEqual(["v1", "v2"]);
  });

  test("defaults mode to create when omitted", async () => {
    const { backend, calls } = makeImmediateBackend(defaultOutput);
    setVideoBackend(backend);
    const { status } = await callPOST({ brief: "a brief here" });
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

// ---------- sweep ----------

describe("mode=sweep", () => {
  test("writes 3 envelopes sharing one sweep_run_id; HEAD unchanged", async () => {
    const { backend } = makeImmediateBackend(defaultOutput);
    setVideoBackend(backend);

    // Seed with one create so HEAD=v1
    await callPOST({ brief: "seed brief here", shots: 2 });
    const headBefore = await readHead(STORE);
    expect(headBefore?.version).toBe("v1");

    const { status, json } = await callPOST({
      mode: "sweep",
      brief: "sweep brief here",
      shots: 2,
      sweep: { axis: "model", values: ["a", "b", "c"] },
    });
    expect(status).toBe(200);
    const body = json as {
      sweep_run_id: string;
      variants: DraftEnvelope[];
    };
    expect(body.variants).toHaveLength(3);
    expect(body.sweep_run_id).toMatch(/[0-9a-f-]/);
    const runIds = new Set(body.variants.map((v) => v.sweep_run_id));
    expect(runIds.size).toBe(1);
    expect([...runIds][0]).toBe(body.sweep_run_id);
    const versions = body.variants.map((v) => v.version).sort();
    expect(versions).toEqual(["v2", "v3", "v4"]);
    for (const v of body.variants) {
      expect(v.reason).toMatch(/^sweep:axis=model,value=/);
      expect(v.parent).toBe("v1");
    }

    const headAfter = await readHead(STORE);
    expect(headAfter?.version).toBe("v1"); // unchanged

    const drafts = await listDrafts(STORE);
    expect(drafts.map((d) => d.version)).toEqual(["v1", "v2", "v3", "v4"]);
  });

  test("launches all variant compositions concurrently", async () => {
    const { backend, invocations } = makeDeferredBackend();
    setVideoBackend(backend);

    const promise = POST(
      req({
        mode: "sweep",
        brief: "sweep concurrent here",
        shots: 2,
        sweep: { axis: "style", values: ["x", "y", "z"] },
      }),
      ctx(),
    );

    // Yield a few microtasks to let dispatch happen, but do NOT resolve yet.
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(invocations).toHaveLength(3);

    // Resolve all
    for (const inv of invocations) {
      inv.resolve(defaultOutput(inv.input));
    }

    const res = await promise;
    expect(res.status).toBe(200);
  });

  test("sweep with no prior HEAD: variants have parent=null and start at v1", async () => {
    const { backend } = makeImmediateBackend(defaultOutput);
    setVideoBackend(backend);

    const { status, json } = await callPOST({
      mode: "sweep",
      brief: "fresh sweep here",
      shots: 2,
      sweep: { axis: "temperature", values: ["0.2", "0.8"] },
    });
    expect(status).toBe(200);
    const body = json as { sweep_run_id: string; variants: DraftEnvelope[] };
    expect(body.variants.map((v) => v.version).sort()).toEqual(["v1", "v2"]);
    for (const v of body.variants) {
      expect(v.parent).toBeNull();
    }
    const head = await readHead(STORE);
    expect(head).toBeNull();
  });
});

// ---------- constrain ----------

describe("mode=constrain", () => {
  test("reuses parent locked shot urls; generator called only for unlocked", async () => {
    // Seed a parent v1 with 3 known shot URLs.
    setVideoBackend(
      makeImmediateBackend((input) => ({
        shotUrls: input.prompts.map((_, i) => `parent-url-${i}`),
        mp4LocalPath: `/tmp/${input.outputBasename}.mp4`,
        durationSeconds: 6,
        fileBytes: 1,
        modelUsed: "fake",
      })).backend,
    );
    await callPOST({ brief: "seed brief here", shots: 3 });

    // Now constrain
    const { backend, calls } = makeImmediateBackend(defaultOutput);
    setVideoBackend(backend);
    const { status, json } = await callPOST({
      mode: "constrain",
      parent: "v1",
      locked_shots: [0, 2],
      brief: "constrain brief here",
    });
    expect(status).toBe(200);
    const body = json as { version: string; head: { version: string }; envelope: DraftEnvelope };
    expect(body.version).toBe("v2");
    expect(body.head.version).toBe("v2");
    expect(body.envelope.parent).toBe("v1");
    expect(body.envelope.locked_shots).toEqual([0, 2]);
    expect(body.envelope.reason).toBe("constrain:locked=[0,2]");
    expect(body.envelope.shots[0]?.video_url).toBe("parent-url-0");
    expect(body.envelope.shots[2]?.video_url).toBe("parent-url-2");
    // Generator called once; lockedUrls had 2 entries; prompts length 3
    expect(calls).toHaveLength(1);
    const callInput = calls[0];
    if (!callInput) throw new Error("no call");
    expect(callInput.prompts).toHaveLength(3);
    expect(callInput.lockedUrls).toEqual({ 0: "parent-url-0", 2: "parent-url-2" });
  });

  test("unknown parent → 400", async () => {
    const { backend } = makeImmediateBackend(defaultOutput);
    setVideoBackend(backend);
    const { status } = await callPOST({
      mode: "constrain",
      parent: "v99",
      locked_shots: [0],
    });
    expect(status).toBe(400);
  });

  test("out-of-range locked_shots index → 400", async () => {
    setVideoBackend(
      makeImmediateBackend((input) => ({
        shotUrls: input.prompts.map((_, i) => `parent-url-${i}`),
        mp4LocalPath: `/tmp/${input.outputBasename}.mp4`,
        durationSeconds: 4,
        fileBytes: 1,
        modelUsed: "fake",
      })).backend,
    );
    await callPOST({ brief: "seed brief here", shots: 2 });

    const { status } = await callPOST({
      mode: "constrain",
      parent: "v1",
      locked_shots: [0, 5],
    });
    expect(status).toBe(400);
  });

  test("all locked: 0 generator calls; envelope still written", async () => {
    setVideoBackend(
      makeImmediateBackend((input) => ({
        shotUrls: input.prompts.map((_, i) => `parent-url-${i}`),
        mp4LocalPath: `/tmp/${input.outputBasename}.mp4`,
        durationSeconds: 4,
        fileBytes: 1,
        modelUsed: "fake",
      })).backend,
    );
    await callPOST({ brief: "seed brief here", shots: 3 });

    // Backend that asserts no shots are unlocked.
    const calls: GenerateInput[] = [];
    const backend: VideoBackend = {
      async generateAndCompose(input: GenerateInput): Promise<GenerateOutput> {
        calls.push(input);
        const locked = input.lockedUrls ?? {};
        const shotUrls: (string | null)[] = [];
        for (let i = 0; i < input.prompts.length; i++) {
          shotUrls.push(locked[i] ?? null);
        }
        return {
          shotUrls,
          mp4LocalPath: `/tmp/${input.outputBasename}.mp4`,
          durationSeconds: 6,
          fileBytes: 1,
          modelUsed: "fake-all-locked",
        };
      },
    };
    setVideoBackend(backend);

    const { status, json } = await callPOST({
      mode: "constrain",
      parent: "v1",
      locked_shots: [0, 1, 2],
    });
    expect(status).toBe(200);
    const body = json as { version: string; envelope: DraftEnvelope };
    expect(body.version).toBe("v2");
    expect(body.envelope.locked_shots).toEqual([0, 1, 2]);
    expect(calls).toHaveLength(1);
    // Verify the backend received all locked indices and no prompts to generate
    const ci = calls[0];
    if (!ci) throw new Error("no call");
    expect(Object.keys(ci.lockedUrls ?? {}).sort()).toEqual(["0", "1", "2"]);

    const stored = await readDraft(STORE, "v2");
    expect(stored).not.toBeNull();
    expect(stored?.shots.map((s) => s.video_url)).toEqual([
      "parent-url-0",
      "parent-url-1",
      "parent-url-2",
    ]);
  });
});
