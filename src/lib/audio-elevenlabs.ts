import { randomUUID } from "node:crypto";
import { type AudioBackend, type SFXResult, type VOResult, type VOTiming, saveAudioBytes } from "@/lib/audio";

type HttpFn = (url: string, init: RequestInit) => Promise<Response>;

let _http: HttpFn = (url, init) => fetch(url, init);

export function setHttp(fn: HttpFn): void {
  _http = fn;
}

async function probeDuration(path: string): Promise<number | null> {
  try {
    const { ffprobeDuration } = await import("@/lib/ffmpeg");
    return await ffprobeDuration(path);
  } catch {
    return null;
  }
}

function distributeTimings(sentences: string[], totalDuration: number): VOTiming[] {
  const wordCounts = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const total = wordCounts.reduce((a, b) => a + b, 0) || 1;
  const timings: VOTiming[] = [];
  let cursor = 0;
  for (let i = 0; i < sentences.length; i++) {
    const frac = (wordCounts[i] ?? 0) / total;
    const dur = frac * totalDuration;
    timings.push({ text: sentences[i] ?? "", startSec: cursor, endSec: cursor + dur });
    cursor += dur;
  }
  return timings;
}

async function generateVO(text: string, voiceId: string): Promise<VOResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const res = await _http(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs VO failed: ${res.status}`);

  const buf = await res.arrayBuffer();
  const localPath = await saveAudioBytes(new Uint8Array(buf), `elevenlabs-vo-${randomUUID()}.mp3`);

  const probed = await probeDuration(localPath);
  const durationSeconds = probed ?? text.split(/\s+/).filter(Boolean).length / 3;

  const sentences = text.split(/\.\s+/).filter(Boolean);
  const timings = distributeTimings(sentences.length > 0 ? sentences : [text], durationSeconds);

  return { localPath, durationSeconds, timings };
}

async function generateSFX(text: string, durationSeconds: number): Promise<SFXResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const res = await _http("https://api.elevenlabs.io/v1/sound-generation", {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, duration_seconds: durationSeconds }),
  });
  if (!res.ok) throw new Error(`ElevenLabs SFX failed: ${res.status}`);

  const buf = await res.arrayBuffer();
  const localPath = await saveAudioBytes(new Uint8Array(buf), `elevenlabs-sfx-${randomUUID()}.mp3`);

  return { localPath, durationSeconds };
}

export const elevenlabsBackend: Partial<AudioBackend> = {
  generateVO,
  generateSFX,
};
