import { test, expect, beforeEach, describe } from "bun:test";
import {
  critiqueAnimatic,
  setFrameExtractor,
  setVisionClient,
  type AnimaticVerdict,
} from "./animatic-critique";

const MOCK_DIMS = [
  { name: "pacing", score: 0.8, note: "Good rhythm." },
  { name: "Spike", score: 0.7, note: "Spike lands well." },
  { name: "Star-arc", score: 0.9, note: "Clear arc." },
  { name: "end-frame brand fluency", score: 0.6, note: "Brand legible." },
  { name: "A/V synergy", score: 0.75, note: "Audio fits." },
  { name: "CTA clarity", score: 0.85, note: "CTA visible." },
  { name: "STSL-analog", score: 0.65, note: "Analog present." },
  { name: "novelty balance", score: 0.7, note: "Fresh but safe." },
];

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function makeFakeFrames(count = 8): string[] {
  return Array.from({ length: count }, (_, i) => `/tmp/fake/frame${i + 1}.jpg`);
}

beforeEach(() => {
  setFrameExtractor(async (_mp4, count) => makeFakeFrames(count));
  setVisionClient(async (_brief, _paths) => JSON.stringify({ dims: MOCK_DIMS }));
});

describe("critiqueAnimatic", () => {
  test("happy path: overall equals mean of dim scores, returns 8 dims", async () => {
    const verdict: AnimaticVerdict = await critiqueAnimatic({
      brief: "A fast-paced ad for a new sneaker.",
      mp4Path: "/fake/animatic.mp4",
    });

    expect(verdict.dims).toHaveLength(8);
    const expectedOverall = mean(MOCK_DIMS.map((d) => d.score));
    expect(verdict.overall).toBeCloseTo(expectedOverall, 6);
  });

  test("schema-violating model output throws", async () => {
    setVisionClient(async (_brief, _paths) =>
      JSON.stringify({ dims: [{ name: "pacing", score: 2.5, note: "over the top" }] }),
    );
    await expect(
      critiqueAnimatic({ brief: "test", mp4Path: "/fake/animatic.mp4" }),
    ).rejects.toThrow(/schema violation/);
  });

  test("empty frames array from extractor throws", async () => {
    setFrameExtractor(async (_mp4, _count) => []);
    await expect(
      critiqueAnimatic({ brief: "test", mp4Path: "/fake/animatic.mp4" }),
    ).rejects.toThrow(/no frames/);
  });

  test("default count is 8", async () => {
    let capturedCount = 0;
    setFrameExtractor(async (_mp4, count) => {
      capturedCount = count;
      return makeFakeFrames(count);
    });
    await critiqueAnimatic({ brief: "test", mp4Path: "/fake/animatic.mp4" });
    expect(capturedCount).toBe(8);
  });
});
