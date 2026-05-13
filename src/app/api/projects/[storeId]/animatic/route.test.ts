import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AnimaticComposer,
  type AnimaticComposerInput,
  type AnimaticComposerOutput,
  type AudioBackendLike,
  POST,
  setAnimaticComposer,
  setAudioBackendGetter,
} from "./route";

const STORE = "store_test";

function req(body: unknown): Request {
  return new Request("http://localhost/api/projects/store_test/animatic", {
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

beforeEach(() => {
  const audio: AudioBackendLike = {
    async generateVO(_scriptText: string) {
      return { voPath: "/tmp/vo-fake.mp3" };
    },
  };
  setAudioBackendGetter(() => audio);
  const composer: AnimaticComposer = async (
    input: AnimaticComposerInput,
  ): Promise<AnimaticComposerOutput> => {
    return {
      mp4Path: input.outPath,
      durationSec: input.stills.length * 2,
    };
  };
  setAnimaticComposer(composer);
});

afterEach(() => {
  setAudioBackendGetter(null);
  setAnimaticComposer(null);
});

describe("POST /api/projects/[storeId]/animatic", () => {
  test("happy path returns ok=true with mp4Path and durationSec", async () => {
    const { status, json } = await callPOST({
      stillUrls: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
      scriptText: "a short script",
    });
    expect(status).toBe(200);
    const body = json as {
      ok: boolean;
      mp4Path: string;
      durationSec: number;
    };
    expect(body.ok).toBe(true);
    expect(body.mp4Path).toMatch(/^\/tmp\/animatic-store_test-.*\.mp4$/);
    expect(body.durationSec).toBe(6);
  });

  test("composer error returns ok=false with status 500", async () => {
    setAnimaticComposer(async () => {
      throw new Error("ffmpeg blew up");
    });
    const { status, json } = await callPOST({
      stillUrls: ["/tmp/a.png"],
      scriptText: "x",
    });
    expect(status).toBe(500);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("ffmpeg blew up");
  });
});
