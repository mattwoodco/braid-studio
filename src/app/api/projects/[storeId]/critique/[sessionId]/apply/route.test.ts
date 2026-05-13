import { test, expect, beforeEach } from "bun:test";
import {
  type CritiqueAspect,
  type CritiqueEnvelope,
  setCritiqueStorage,
  writeCritique,
} from "@/lib/critique";
import {
  type DraftEnvelope,
  type DraftsStorage,
  setDraftsStorage,
  writeDraft,
  writeHead,
} from "@/lib/drafts";
import {
  type GenerateInput,
  type GenerateOutput,
  type VideoBackend,
  setVideoBackend,
} from "@/lib/video-backend";
import { POST } from "./route";

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
      for (const [k, e] of entries) {
        if (e.id === memoryId && k.startsWith(`${storeId}::`)) {
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

function recordingBackend(): {
  backend: VideoBackend;
  calls: GenerateInput[];
} {
  const calls: GenerateInput[] = [];
  const backend: VideoBackend = {
    async generateAndCompose(input) {
      calls.push(input);
      const locked = input.lockedUrls ?? {};
      const shotUrls = input.prompts.map((_p, i) =>
        i in locked ? (locked[i] ?? null) : `https://gen.test/${i}.mp4`,
      );
      const out: GenerateOutput = {
        shotUrls,
        mp4LocalPath: `/tmp/${input.outputBasename}.mp4`,
        durationSeconds: 5,
        fileBytes: 1234,
        modelUsed: "fake",
      };
      return out;
    },
  };
  return { backend, calls };
}

function parentEnvelope(
  version: string,
  parent: string | null = null,
): DraftEnvelope {
  return {
    version,
    parent,
    reason: parent ? "critique:dummy" : "create",
    locked_shots: [],
    shots: [0, 1, 2, 3, 4].map((n) => ({
      n,
      prompt: `prompt-${n}-${version}`,
      video_url: `https://parent.test/${version}/${n}.mp4`,
    })),
    mp4_filename: `${version}.mp4`,
    duration_seconds: 5,
    file_bytes: 100,
    wall_ms: 50,
    model_used: "test",
    updated_at: "t",
  };
}

function critiqueEnv(
  aspect: CritiqueAspect,
  parentDraft: string,
  scores: number[],
): CritiqueEnvelope {
  return {
    version: `c-${aspect}-${parentDraft}`,
    parent_draft: parentDraft,
    aspect,
    shot_scores: scores.map((s, n) => ({
      n,
      score: s,
      issues: s < 0.7 ? [`${aspect} weak`] : [],
      suggestion: s < 0.7 ? `boost ${aspect} on ${n}` : undefined,
    })),
    overall: scores.reduce((a, b) => a + b, 0) / scores.length,
    summary: `${aspect}-summary`,
    created_at: "t",
  };
}

const STORE = "store_x";
const SESSION = "sess_1";

let bk: ReturnType<typeof recordingBackend>;

beforeEach(() => {
  const ds = makeFakeStorage();
  setDraftsStorage(ds.storage);
  // Share storage between drafts and critiques so listCritiques/listDrafts see same data.
  setCritiqueStorage(ds.storage);
  bk = recordingBackend();
  setVideoBackend(bk.backend);
});

function post(body?: object): Promise<Response> {
  return POST(
    new Request(`http://test/apply`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
    { params: Promise.resolve({ storeId: STORE, sessionId: SESSION }) },
  );
}

test("partitions shots, only regen indices submit to video backend (speed contract)", async () => {
  await writeDraft(STORE, parentEnvelope("v1"));
  await writeHead(STORE, { version: "v1", updated_at: "t" });

  // Three aspect envelopes; shots [0,1,3] avg >= 0.7, shots [2,4] avg < 0.7.
  await writeCritique(STORE, critiqueEnv("cinematography", "v1", [0.9, 0.8, 0.4, 0.9, 0.5]));
  await writeCritique(STORE, critiqueEnv("pacing", "v1", [0.8, 0.7, 0.5, 0.85, 0.4]));
  await writeCritique(STORE, critiqueEnv("color", "v1", [0.9, 0.9, 0.6, 0.8, 0.45]));

  const res = await post({ draftVersion: "v1" });
  expect(res.status).toBe(200);
  const child = (await res.json()) as DraftEnvelope;

  expect(child.parent).toBe("v1");
  expect(child.version).toBe("v2");
  expect(child.locked_shots.sort()).toEqual([0, 1, 3]);
  expect(child.reason.startsWith("critique:")).toBe(true);

  // Speed contract: backend got 5 prompts but lockedUrls includes 3 entries,
  // so only 2 FAL submissions would happen.
  expect(bk.calls).toHaveLength(1);
  const call = bk.calls[0]!;
  expect(Object.keys(call.lockedUrls ?? {}).sort()).toEqual(["0", "1", "3"]);
  // The non-locked prompts must carry the suggestion (proof regen happens).
  expect(call.prompts[2]).toContain("boost");
  expect(call.prompts[4]).toContain("boost");
  // Locked prompts unchanged.
  expect(call.prompts[0]).toBe("prompt-0-v1");
  expect(call.prompts[3]).toBe("prompt-3-v1");

  // Child shots reflect: locked URLs are reused from parent, regen URLs are new.
  expect(child.shots[0]!.video_url).toBe("https://parent.test/v1/0.mp4");
  expect(child.shots[2]!.video_url).toBe("https://gen.test/2.mp4");
});

test("404 when there are no critiques", async () => {
  await writeDraft(STORE, parentEnvelope("v1"));
  const res = await post({ draftVersion: "v1" });
  expect(res.status).toBe(404);
});

test("locked-shot count is non-decreasing across iterations (improvement invariant)", async () => {
  // v1 baseline
  await writeDraft(STORE, parentEnvelope("v1"));
  await writeHead(STORE, { version: "v1", updated_at: "t" });
  await writeCritique(STORE, critiqueEnv("cinematography", "v1", [0.9, 0.4, 0.4, 0.4, 0.4]));
  let res = await post({ draftVersion: "v1" });
  expect(res.status).toBe(200);
  const v2 = (await res.json()) as DraftEnvelope;
  expect(v2.locked_shots.length).toBe(1);

  // v2 critique: shot 0 still passes (no regression), shot 1 now passes.
  await writeCritique(STORE, critiqueEnv("cinematography", "v2", [0.9, 0.8, 0.4, 0.4, 0.4]));
  res = await post({ draftVersion: "v2" });
  expect(res.status).toBe(200);
  const v3 = (await res.json()) as DraftEnvelope;
  expect(v3.locked_shots.length).toBeGreaterThanOrEqual(v2.locked_shots.length);
  expect(v3.locked_shots.length).toBe(2);

  // v3 critique: shots 0,1 still pass, shot 2 now passes.
  await writeCritique(STORE, critiqueEnv("cinematography", "v3", [0.9, 0.8, 0.75, 0.4, 0.4]));
  res = await post({ draftVersion: "v3" });
  expect(res.status).toBe(200);
  const v4 = (await res.json()) as DraftEnvelope;
  expect(v4.locked_shots.length).toBeGreaterThanOrEqual(v3.locked_shots.length);
  expect(v4.locked_shots.length).toBe(3);
});

test("overall score is monotonic across iterations under non-regressing fixtures", async () => {
  await writeDraft(STORE, parentEnvelope("v1"));
  await writeHead(STORE, { version: "v1", updated_at: "t" });

  // Tracks the overall score per version via the aggregator (decoupled from the route).
  const { aggregate, listCritiques } = await import("@/lib/critique");

  await writeCritique(STORE, critiqueEnv("cinematography", "v1", [0.4, 0.4, 0.4]));
  const v1Critiques = await listCritiques(STORE, "v1");
  const v1Overall = aggregate(v1Critiques).overall;
  await post({ draftVersion: "v1" });

  await writeCritique(STORE, critiqueEnv("cinematography", "v2", [0.7, 0.6, 0.5]));
  const v2Critiques = await listCritiques(STORE, "v2");
  const v2Overall = aggregate(v2Critiques).overall;

  expect(v2Overall).toBeGreaterThan(v1Overall);
});
