import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

export type VOTiming = {
  text: string;
  startSec: number;
  endSec: number;
};

export type VOResult = {
  localPath: string;
  durationSeconds: number;
  timings: VOTiming[];
};

export type SFXResult = {
  localPath: string;
  durationSeconds: number;
};

export type MusicResult = {
  localPath: string;
  durationSeconds: number;
};

export interface AudioBackend {
  generateVO(text: string, voiceId: string): Promise<VOResult>;
  generateSFX(text: string, durationSeconds: number): Promise<SFXResult>;
  generateMusic(prompt: string): Promise<MusicResult>;
}

export const BRAID_AUDIO_DIR: string = process.env.BRAID_AUDIO_DIR ?? tmpdir();

export async function saveAudioBytes(bytes: Uint8Array, filename: string): Promise<string> {
  const p = join(BRAID_AUDIO_DIR, filename);
  await writeFile(p, bytes);
  return p;
}

function createLocalStubBackend(): AudioBackend {
  return {
    async generateVO(text: string, _voiceId: string): Promise<VOResult> {
      const words = text.split(/\s+/).filter(Boolean);
      const durationSeconds = Math.max(1, words.length / 3);
      const bytes = new Uint8Array(0);
      const localPath = await saveAudioBytes(bytes, `stub-vo-${Date.now()}.mp3`);
      const timings: VOTiming[] = [{ text, startSec: 0, endSec: durationSeconds }];
      return { localPath, durationSeconds, timings };
    },
    async generateSFX(text: string, durationSeconds: number): Promise<SFXResult> {
      const bytes = new Uint8Array(0);
      const localPath = await saveAudioBytes(bytes, `stub-sfx-${Date.now()}.mp3`);
      return { localPath, durationSeconds: durationSeconds || 3 };
    },
    async generateMusic(_prompt: string): Promise<MusicResult> {
      const bytes = new Uint8Array(0);
      const localPath = await saveAudioBytes(bytes, `stub-music-${Date.now()}.mp3`);
      return { localPath, durationSeconds: 30 };
    },
  };
}

export const localStubBackend: AudioBackend = createLocalStubBackend();

let _impl: AudioBackend | null = null;

export function setAudioBackend(impl: AudioBackend | null): void {
  _impl = impl;
}

export function getAudioBackend(): AudioBackend {
  return _impl ?? localStubBackend;
}
