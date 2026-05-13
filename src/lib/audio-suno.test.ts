import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { setHttp, sunoBackend } from "./audio-suno";

const savedPaths: string[] = [];

type CapturedRequest = { url: string; init?: RequestInit };
let captured: CapturedRequest[] = [];

type MockHandler = (url: string, init?: RequestInit) => Response;
let mockHandler: MockHandler = () => { throw new Error("no mock set"); };

function makeJson(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    arrayBuffer: async () => new ArrayBuffer(4),
    text: async () => text,
  } as unknown as Response;
}

function makeBytes(bytes: Uint8Array, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response;
}

beforeEach(() => {
  captured = [];
  process.env.SUNO_API_KEY = "suno-key";
  setHttp(async (url, init) => {
    captured.push({ url, init });
    return mockHandler(url, init);
  });
});

afterEach(() => {
  delete process.env.SUNO_API_KEY;
  setHttp((url, init) => fetch(url, init));
  for (const p of savedPaths) {
    if (existsSync(p)) unlinkSync(p);
  }
  savedPaths.length = 0;
});

describe("sunoBackend.generateMusic", () => {
  test("polls until success and returns saved path", async () => {
    let pollCount = 0;
    const audioUrl = "https://cdn.suno.ai/song.mp3";

    mockHandler = (url) => {
      if (url === "https://api.sunoapi.org/api/v1/generate") {
        return makeJson({ data: { taskId: "task-123" } });
      }
      if (url.includes("record-info")) {
        pollCount++;
        if (pollCount < 3) {
          return makeJson({ data: { status: "pending" } });
        }
        return makeJson({ data: { status: "success", songs: [{ audioUrl }] } });
      }
      if (url === audioUrl) {
        return makeBytes(new Uint8Array([1, 2, 3, 4]));
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await sunoBackend.generateMusic("epic orchestral theme");
    expect(pollCount).toBeGreaterThanOrEqual(3);
    expect(existsSync(result.localPath)).toBe(true);
    savedPaths.push(result.localPath);
  });

  test("rejects when status is failed", async () => {
    mockHandler = (url) => {
      if (url === "https://api.sunoapi.org/api/v1/generate") {
        return makeJson({ data: { taskId: "task-fail" } });
      }
      if (url.includes("record-info")) {
        return makeJson({ data: { status: "failed" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    await expect(sunoBackend.generateMusic("sad melody")).rejects.toThrow("Suno generation failed");
  });

  test("includes Authorization header in generate and poll requests", async () => {
    const audioUrl = "https://cdn.suno.ai/song2.mp3";
    mockHandler = (url) => {
      if (url === "https://api.sunoapi.org/api/v1/generate") {
        return makeJson({ data: { taskId: "task-auth" } });
      }
      if (url.includes("record-info")) {
        return makeJson({ data: { status: "success", songs: [{ audioUrl }] } });
      }
      if (url === audioUrl) {
        return makeBytes(new Uint8Array([5, 6]));
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await sunoBackend.generateMusic("test");
    const generateReq = captured.find((r) => r.url === "https://api.sunoapi.org/api/v1/generate");
    const headers = generateReq?.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer suno-key");
    savedPaths.push(result.localPath);
  });

  test("throws when SUNO_API_KEY missing", async () => {
    delete process.env.SUNO_API_KEY;
    await expect(sunoBackend.generateMusic("test")).rejects.toThrow("SUNO_API_KEY not set");
  });
});
