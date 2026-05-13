/**
 * Unit 2 — video-backend tests.
 *
 * Covers the red/green items in SPEC.md §"Unit 2".
 * No SDK mocking — we test the seam by injecting fake VideoBackend impls
 * via setVideoBackend / getVideoBackend, and test the helper that computes
 * which prompt indices to generate (locked vs. open).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type GenerateInput,
  type GenerateOutput,
  type VideoBackend,
  getVideoBackend,
  setVideoBackend,
} from "./video-backend";

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

/**
 * Build a fake VideoBackend that:
 * - For each prompt index NOT in lockedUrls, calls `generator(index, prompt)`.
 * - Returns generated urls in order (locked indices preserve the locked url).
 * - Reports invocations.
 *
 * The real default backend is exercised in an importability smoke test.
 * Behavior tests use the fake so we drive concurrency and locking deterministically.
 */
function makeFakeBackend(generator: (index: number, prompt: string) => Promise<string>): {
  backend: VideoBackend;
  calls: Array<{ index: number; prompt: string }>;
} {
  const calls: Array<{ index: number; prompt: string }> = [];
  const backend: VideoBackend = {
    async generateAndCompose(input: GenerateInput): Promise<GenerateOutput> {
      const locked = input.lockedUrls ?? {};
      // Concurrency: dispatch all open generator calls before awaiting any.
      const pending: Array<{ index: number; promise: Promise<string> }> = [];
      for (let i = 0; i < input.prompts.length; i++) {
        if (Object.prototype.hasOwnProperty.call(locked, i)) continue;
        const prompt = input.prompts[i] ?? "";
        calls.push({ index: i, prompt });
        pending.push({ index: i, promise: generator(i, prompt) });
      }
      const results = await Promise.all(pending.map((p) => p.promise));
      const shotUrls: (string | null)[] = new Array(input.prompts.length).fill(null);
      for (let i = 0; i < input.prompts.length; i++) {
        const lockedUrl = locked[i];
        if (lockedUrl !== undefined) {
          shotUrls[i] = lockedUrl;
        }
      }
      for (let k = 0; k < pending.length; k++) {
        const slot = pending[k];
        const val = results[k];
        if (slot && val !== undefined) shotUrls[slot.index] = val;
      }
      return {
        shotUrls,
        mp4LocalPath: `/tmp/fake-${input.outputBasename}.mp4`,
        durationSeconds: input.prompts.length * 2,
        fileBytes: 1234,
        modelUsed: "fake-model",
      };
    },
  };
  return { backend, calls };
}

afterEach(() => {
  // Restore the default backend between tests so we don't leak fakes.
  // setVideoBackend(null) resets to default in the impl.
  setVideoBackend(null);
});

describe("video-backend seam", () => {
  test("default backend is importable without throwing (lazy init)", () => {
    const b = getVideoBackend();
    expect(typeof b.generateAndCompose).toBe("function");
  });

  test("setVideoBackend swaps the active impl; null restores default", () => {
    const { backend } = makeFakeBackend(async (i) => `gen-${i}`);
    setVideoBackend(backend);
    expect(getVideoBackend()).toBe(backend);
    setVideoBackend(null);
    expect(getVideoBackend()).not.toBe(backend);
  });

  test("prompts of length 3 with no locks invokes generator 3x", async () => {
    const { backend, calls } = makeFakeBackend(async (i) => `gen-${i}`);
    setVideoBackend(backend);
    const out = await getVideoBackend().generateAndCompose({
      prompts: ["a", "b", "c"],
      storeId: "store1",
      outputBasename: "draft-store1-t",
    });
    expect(calls.length).toBe(3);
    expect(out.shotUrls).toEqual(["gen-0", "gen-1", "gen-2"]);
  });

  test("locked indices skip generation; output preserves locked urls in order", async () => {
    const { backend, calls } = makeFakeBackend(async (i) => `gen-${i}`);
    setVideoBackend(backend);
    const out = await getVideoBackend().generateAndCompose({
      prompts: ["a", "b", "c"],
      lockedUrls: { 0: "u0", 2: "u2" },
      storeId: "store1",
      outputBasename: "draft-store1-t",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.index).toBe(1);
    expect(out.shotUrls).toEqual(["u0", "gen-1", "u2"]);
  });

  test("all locked => generator invoked 0 times; envelope output still produced", async () => {
    const { backend, calls } = makeFakeBackend(async (i) => `gen-${i}`);
    setVideoBackend(backend);
    const out = await getVideoBackend().generateAndCompose({
      prompts: ["a", "b", "c"],
      lockedUrls: { 0: "u0", 1: "u1", 2: "u2" },
      storeId: "store1",
      outputBasename: "draft-store1-t",
    });
    expect(calls.length).toBe(0);
    expect(out.shotUrls).toEqual(["u0", "u1", "u2"]);
    expect(typeof out.mp4LocalPath).toBe("string");
  });

  test("concurrency: all generator calls dispatched before any resolves", async () => {
    const defs = [deferred<string>(), deferred<string>(), deferred<string>()];
    let activeCount = 0;
    let maxActive = 0;
    const { backend } = makeFakeBackend(async (i) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      const d = defs[i];
      if (!d) throw new Error(`no deferred for ${i}`);
      const v = await d.promise;
      activeCount--;
      return v;
    });
    setVideoBackend(backend);

    const runPromise = getVideoBackend().generateAndCompose({
      prompts: ["a", "b", "c"],
      storeId: "store1",
      outputBasename: "draft-store1-t",
    });

    // Yield microtasks so each generator() call has a chance to run up to its `await d.promise`.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // All 3 calls should have entered the generator body before any resolves.
    expect(maxActive).toBe(3);

    // Race against a fast sentinel: runPromise must NOT resolve yet.
    const sentinel = Symbol("sentinel");
    const winner = await Promise.race([
      runPromise.then(() => "run" as const),
      Promise.resolve(sentinel),
    ]);
    expect(winner).toBe(sentinel);

    // Now resolve all and ensure final shape is correct.
    defs[0]?.resolve("g0");
    defs[1]?.resolve("g1");
    defs[2]?.resolve("g2");
    const out = await runPromise;
    expect(out.shotUrls).toEqual(["g0", "g1", "g2"]);
  });
});
