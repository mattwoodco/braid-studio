import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import {
  type AudioBackend,
  type GeneratedAudio,
  type VOTiming,
  getAudioBackend,
  localStubBackend,
  resetAudioBackend,
  setAudioBackend,
} from "./audio";

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;

afterEach(() => {
  resetAudioBackend();
});

describe("audio backend seam", () => {
  test("default backend is localStubBackend", () => {
    expect(getAudioBackend()).toBe(localStubBackend);
  });

  test("setAudioBackend swaps active impl; reset restores default", () => {
    const fake: AudioBackend = {
      async generateVO() {
        return {
          audio: { path: "/tmp/x.wav", durationSec: 0 },
          timing: { perLine: [], totalSec: 0 },
        };
      },
      async generateMusic() {
        return { path: "/tmp/m.wav", durationSec: 0 };
      },
      async generateSFX() {
        return { path: "/tmp/s.wav", durationSec: 0 };
      },
    };
    setAudioBackend(fake);
    expect(getAudioBackend()).toBe(fake);
    resetAudioBackend();
    expect(getAudioBackend()).toBe(localStubBackend);
  });
});

describe("localStubBackend silent WAV", () => {
  test("generateMusic writes a 44-byte RIFF/WAVE header with correct payload size", async () => {
    const durationSec = 2;
    const out = await localStubBackend.generateMusic("calm pad", durationSec);
    const buf = await readFile(out.path);
    const expectedSamples = Math.round(durationSec * SAMPLE_RATE);
    const expectedDataSize = expectedSamples * BYTES_PER_SAMPLE;
    expect(buf.length).toBe(44 + expectedDataSize);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.toString("ascii", 12, 16)).toBe("fmt ");
    expect(buf.toString("ascii", 36, 40)).toBe("data");
    expect(buf.readUInt32LE(4)).toBe(36 + expectedDataSize);
    expect(buf.readUInt16LE(20)).toBe(1);
    expect(buf.readUInt16LE(22)).toBe(1);
    expect(buf.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(buf.readUInt32LE(40)).toBe(expectedDataSize);
    expect(out.durationSec).toBe(durationSec);
  });

  test("generateSFX writes file of correct size for fractional duration", async () => {
    const durationSec = 0.5;
    const out = await localStubBackend.generateSFX("click", durationSec);
    const st = await stat(out.path);
    const expectedSamples = Math.round(durationSec * SAMPLE_RATE);
    expect(st.size).toBe(44 + expectedSamples * BYTES_PER_SAMPLE);
  });

  test("generateVO timing perLine sums to totalSec within 0.01", async () => {
    const text =
      "First line of voice over. Second line of voice over. Third and final line of voice over.";
    const { timing }: { timing: VOTiming } = await localStubBackend.generateVO(text);
    expect(timing.perLine.length).toBe(3);
    const last = timing.perLine[timing.perLine.length - 1];
    if (!last) throw new Error("no last");
    expect(Math.abs(last.endSec - timing.totalSec)).toBeLessThanOrEqual(0.01);
    expect(timing.perLine[0]?.startSec).toBe(0);
    for (let i = 1; i < timing.perLine.length; i++) {
      const prev = timing.perLine[i - 1];
      const cur = timing.perLine[i];
      if (!prev || !cur) throw new Error("missing");
      expect(Math.abs(cur.startSec - prev.endSec)).toBeLessThanOrEqual(0.01);
    }
  });

  test("generateVO computes totalSec from ~3 words/sec", async () => {
    const text = "one two three four five six";
    const { timing, audio }: { timing: VOTiming; audio: GeneratedAudio } =
      await localStubBackend.generateVO(text);
    expect(timing.totalSec).toBeCloseTo(2, 5);
    expect(audio.durationSec).toBeCloseTo(2, 5);
  });

  test("generateVO with empty text yields empty timing and zero-duration WAV", async () => {
    const { timing, audio } = await localStubBackend.generateVO("");
    expect(timing.totalSec).toBe(0);
    expect(timing.perLine.length).toBe(0);
    const buf = await readFile(audio.path);
    expect(buf.length).toBe(44);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
  });
});
