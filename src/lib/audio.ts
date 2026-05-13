import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type VOTiming = {
  perLine: { line: string; startSec: number; endSec: number }[];
  totalSec: number;
};

export type GeneratedAudio = { path: string; durationSec: number };

export interface AudioBackend {
  generateVO(text: string, voice?: string): Promise<{ audio: GeneratedAudio; timing: VOTiming }>;
  generateMusic(prompt: string, durationSec: number): Promise<GeneratedAudio>;
  generateSFX(prompt: string, durationSec: number): Promise<GeneratedAudio>;
}

const SAMPLE_RATE = 8000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

function buildSilentWav(durationSec: number): Buffer {
  const sec = Math.max(0, durationSec);
  const numSamples = Math.max(0, Math.round(sec * SAMPLE_RATE));
  const dataSize = numSamples * NUM_CHANNELS * BYTES_PER_SAMPLE;
  const byteRate = SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = NUM_CHANNELS * BYTES_PER_SAMPLE;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

async function writeSilentWav(durationSec: number, kind: string): Promise<GeneratedAudio> {
  const dir = join(tmpdir(), "braid-audio");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${kind}-${randomUUID()}.wav`);
  await writeFile(path, buildSilentWav(durationSec));
  return { path, durationSec };
}

function splitLines(text: string): string[] {
  const parts = text
    .split(". ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return text.trim().length > 0 ? [text.trim()] : [];
  return parts;
}

function computeTotalSec(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return 0;
  return words.length / 3;
}

export const localStubBackend: AudioBackend = {
  async generateVO(
    text: string,
    _voice?: string,
  ): Promise<{ audio: GeneratedAudio; timing: VOTiming }> {
    const totalSec = computeTotalSec(text);
    const lines = splitLines(text);
    const perLine: { line: string; startSec: number; endSec: number }[] = [];
    if (lines.length > 0 && totalSec > 0) {
      const slice = totalSec / lines.length;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const startSec = i * slice;
        const endSec = i === lines.length - 1 ? totalSec : (i + 1) * slice;
        perLine.push({ line, startSec, endSec });
      }
    }
    const audio = await writeSilentWav(totalSec, "vo");
    return { audio, timing: { perLine, totalSec } };
  },
  async generateMusic(_prompt: string, durationSec: number): Promise<GeneratedAudio> {
    return writeSilentWav(durationSec, "music");
  },
  async generateSFX(_prompt: string, durationSec: number): Promise<GeneratedAudio> {
    return writeSilentWav(durationSec, "sfx");
  },
};

let _impl: AudioBackend | null = null;

export function getAudioBackend(): AudioBackend {
  if (_impl) return _impl;
  return localStubBackend;
}

export function setAudioBackend(b: AudioBackend): void {
  _impl = b;
}

export function resetAudioBackend(): void {
  _impl = null;
}
