import { randomUUID } from "node:crypto";
import type { AudioBackend, MusicResult } from "@/lib/audio";
import { saveAudioBytes } from "@/lib/audio";

type HttpFn = (url: string, init?: RequestInit) => Promise<Response>;

let _http: HttpFn = (url, init) => fetch(url, init);

export function setHttp(fn: HttpFn): void {
  _http = fn;
}

const POLL_DELAYS = [200, 800, 3200, 12800];
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

type GenerateResponse = { data?: { taskId?: string } };
type RecordInfo = { data?: { status?: string; songs?: Array<{ audioUrl?: string }> } };

async function pollForResult(taskId: string, apiKey: string): Promise<string> {
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await _http(`https://api.sunoapi.org/api/v1/generate/record-info?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Suno poll failed: ${res.status}`);

    const json = (await res.json()) as RecordInfo;
    const status = json.data?.status;

    if (status === "failed") throw new Error("Suno generation failed");
    if (status === "success") {
      const audioUrl = json.data?.songs?.[0]?.audioUrl;
      if (!audioUrl) throw new Error("Suno: no audioUrl in success response");
      return audioUrl;
    }

    const delay = POLL_DELAYS[Math.min(attempt, POLL_DELAYS.length - 1)] ?? 12800;
    await new Promise<void>((r) => setTimeout(r, delay));
    attempt++;
  }

  throw new Error("Suno: polling timed out after 5 minutes");
}

async function generateMusicFn(prompt: string): Promise<MusicResult> {
  const apiKey = process.env.SUNO_API_KEY;
  if (!apiKey) throw new Error("SUNO_API_KEY not set");

  const res = await _http("https://api.sunoapi.org/api/v1/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model: "V4", customMode: false }),
  });
  if (!res.ok) throw new Error(`Suno generate failed: ${res.status}`);

  const json = (await res.json()) as GenerateResponse;
  const taskId = json.data?.taskId;
  if (!taskId) throw new Error("Suno: no taskId in response");

  const audioUrl = await pollForResult(taskId, apiKey);

  const dlRes = await _http(audioUrl);
  if (!dlRes.ok) throw new Error(`Suno: download failed: ${dlRes.status}`);

  const buf = await dlRes.arrayBuffer();
  const localPath = await saveAudioBytes(new Uint8Array(buf), `suno-music-${randomUUID()}.mp3`);

  let durationSeconds = 30;
  try {
    const { ffprobeDuration } = await import("@/lib/ffmpeg");
    durationSeconds = await ffprobeDuration(localPath);
  } catch {
  }

  return { localPath, durationSeconds };
}

export const sunoBackend: Pick<AudioBackend, "generateMusic"> = {
  generateMusic: generateMusicFn,
};
