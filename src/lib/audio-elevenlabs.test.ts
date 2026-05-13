import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { setHttp, elevenlabsBackend } from "./audio-elevenlabs";

const savedPaths: string[] = [];

function makeResponseMock(body: Uint8Array, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body.buffer as ArrayBuffer,
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response;
}

type CapturedRequest = { url: string; init?: RequestInit };
let captured: CapturedRequest[] = [];
let mockResponse: Response = makeResponseMock(new Uint8Array([1, 2, 3]));

beforeEach(() => {
  captured = [];
  process.env.ELEVENLABS_API_KEY = "test-key";
  setHttp(async (url, init) => {
    captured.push({ url, init });
    return mockResponse;
  });
});

afterEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  setHttp((url, init) => fetch(url, init));
  for (const p of savedPaths) {
    if (existsSync(p)) unlinkSync(p);
  }
  savedPaths.length = 0;
});

describe("elevenlabsBackend.generateVO", () => {
  test("calls correct URL with xi-api-key header and body", async () => {
    const fn = elevenlabsBackend.generateVO;
    if (!fn) throw new Error("generateVO not defined");
    const result = await fn("Hello world.", "voice-abc");
    expect(captured.length).toBe(1);
    expect(captured[0]?.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-abc");
    const headers = captured[0]?.init?.headers as Record<string, string>;
    expect(headers?.["xi-api-key"]).toBe("test-key");
    expect(headers?.["Content-Type"]).toBe("application/json");
    const body = JSON.parse(captured[0]?.init?.body as string) as { text: string; model_id: string };
    expect(body.text).toBe("Hello world.");
    expect(body.model_id).toBe("eleven_multilingual_v2");
    savedPaths.push(result.localPath);
  });

  test("saves bytes to disk and returns localPath", async () => {
    const fn = elevenlabsBackend.generateVO;
    if (!fn) throw new Error("generateVO not defined");
    mockResponse = makeResponseMock(new Uint8Array([10, 20, 30]));
    const result = await fn("Test text.", "voice-xyz");
    expect(existsSync(result.localPath)).toBe(true);
    savedPaths.push(result.localPath);
  });

  test("throws when ELEVENLABS_API_KEY missing", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const fn = elevenlabsBackend.generateVO;
    if (!fn) throw new Error("generateVO not defined");
    await expect(fn("Hello", "v1")).rejects.toThrow("ELEVENLABS_API_KEY not set");
  });

  test("distributes timings proportionally to word count across sentences", async () => {
    const fn = elevenlabsBackend.generateVO;
    if (!fn) throw new Error("generateVO not defined");
    const result = await fn("Hello world. How are you today.", "v1");
    expect(result.timings.length).toBeGreaterThan(0);
    expect(result.timings[0]?.startSec).toBe(0);
    savedPaths.push(result.localPath);
  });
});

describe("elevenlabsBackend.generateSFX", () => {
  test("calls correct URL with xi-api-key and body", async () => {
    const fn = elevenlabsBackend.generateSFX;
    if (!fn) throw new Error("generateSFX not defined");
    const result = await fn("explosion sound", 3);
    expect(captured[0]?.url).toBe("https://api.elevenlabs.io/v1/sound-generation");
    const headers = captured[0]?.init?.headers as Record<string, string>;
    expect(headers?.["xi-api-key"]).toBe("test-key");
    const body = JSON.parse(captured[0]?.init?.body as string) as { text: string; duration_seconds: number };
    expect(body.text).toBe("explosion sound");
    expect(body.duration_seconds).toBe(3);
    expect(result.durationSeconds).toBe(3);
    savedPaths.push(result.localPath);
  });

  test("saves bytes to disk", async () => {
    const fn = elevenlabsBackend.generateSFX;
    if (!fn) throw new Error("generateSFX not defined");
    const result = await fn("click", 1);
    expect(existsSync(result.localPath)).toBe(true);
    savedPaths.push(result.localPath);
  });

  test("throws when ELEVENLABS_API_KEY missing", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const fn = elevenlabsBackend.generateSFX;
    if (!fn) throw new Error("generateSFX not defined");
    await expect(fn("boom", 2)).rejects.toThrow("ELEVENLABS_API_KEY not set");
  });
});
