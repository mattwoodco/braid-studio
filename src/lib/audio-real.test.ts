import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { setHttp as setElHttp } from "./audio-elevenlabs";
import { setHttp as setSunoHttp } from "./audio-suno";
import { realBackend } from "./audio-real";

const savedPaths: string[] = [];

function makeJsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    arrayBuffer: async () => new ArrayBuffer(8),
    text: async () => text,
  } as unknown as Response;
}

function makeBytesResponse(bytes: Uint8Array, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response;
}

function installElMock(audioUrl = "https://cdn.suno.ai/song.mp3"): void {
  setElHttp(async () => makeBytesResponse(new Uint8Array([1, 2, 3])));
  setSunoHttp(async (url) => {
    if (url === "https://api.sunoapi.org/api/v1/generate") {
      return makeJsonResponse({ data: { taskId: "t1" } });
    }
    if (url.includes("record-info")) {
      return makeJsonResponse({ data: { status: "success", songs: [{ audioUrl }] } });
    }
    return makeBytesResponse(new Uint8Array([4, 5, 6]));
  });
}

beforeEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.SUNO_API_KEY;
});

afterEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.SUNO_API_KEY;
  setElHttp((url, init) => fetch(url, init));
  setSunoHttp((url, init) => fetch(url, init));
  for (const p of savedPaths) {
    if (existsSync(p)) unlinkSync(p);
  }
  savedPaths.length = 0;
});

describe("realBackend", () => {
  test("falls back to stub for VO when ELEVENLABS_API_KEY not set", async () => {
    const result = await realBackend.generateVO("Hello world", "v1");
    expect(result.localPath).toMatch(/stub-vo/);
    savedPaths.push(result.localPath);
  });

  test("falls back to stub for SFX when ELEVENLABS_API_KEY not set", async () => {
    const result = await realBackend.generateSFX("explosion", 2);
    expect(result.localPath).toMatch(/stub-sfx/);
    savedPaths.push(result.localPath);
  });

  test("falls back to stub for music when SUNO_API_KEY not set", async () => {
    const result = await realBackend.generateMusic("epic theme");
    expect(result.localPath).toMatch(/stub-music/);
    savedPaths.push(result.localPath);
  });

  test("uses elevenlabs for VO when ELEVENLABS_API_KEY is set", async () => {
    process.env.ELEVENLABS_API_KEY = "el-key";
    setElHttp(async () => makeBytesResponse(new Uint8Array([9, 8, 7])));
    const result = await realBackend.generateVO("Hello", "v-abc");
    expect(result.localPath).toMatch(/elevenlabs-vo/);
    savedPaths.push(result.localPath);
  });

  test("uses elevenlabs for SFX when ELEVENLABS_API_KEY is set", async () => {
    process.env.ELEVENLABS_API_KEY = "el-key";
    setElHttp(async () => makeBytesResponse(new Uint8Array([5, 5, 5])));
    const result = await realBackend.generateSFX("boom", 1.5);
    expect(result.localPath).toMatch(/elevenlabs-sfx/);
    savedPaths.push(result.localPath);
  });

  test("uses suno for music when SUNO_API_KEY is set", async () => {
    process.env.SUNO_API_KEY = "suno-key";
    const audioUrl = "https://cdn.suno.ai/track.mp3";
    setSunoHttp(async (url) => {
      if (url === "https://api.sunoapi.org/api/v1/generate") {
        return makeJsonResponse({ data: { taskId: "t99" } });
      }
      if (url.includes("record-info")) {
        return makeJsonResponse({ data: { status: "success", songs: [{ audioUrl }] } });
      }
      return makeBytesResponse(new Uint8Array([1, 2]));
    });
    const result = await realBackend.generateMusic("lo-fi beats");
    expect(result.localPath).toMatch(/suno-music/);
    savedPaths.push(result.localPath);
  });

  test("partial keys: elevenlabs VO real + suno stub when only ELEVENLABS_API_KEY set", async () => {
    process.env.ELEVENLABS_API_KEY = "el-key";
    setElHttp(async () => makeBytesResponse(new Uint8Array([3, 2, 1])));
    const [voResult, musicResult] = await Promise.all([
      realBackend.generateVO("test", "v1"),
      realBackend.generateMusic("test"),
    ]);
    expect(voResult.localPath).toMatch(/elevenlabs-vo/);
    expect(musicResult.localPath).toMatch(/stub-music/);
    savedPaths.push(voResult.localPath);
    savedPaths.push(musicResult.localPath);
  });
});
