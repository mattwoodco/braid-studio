import { test, expect } from "bun:test";
import { VIDEO_RUBRIC_TEMPLATE, buildCoordinatorPrompt } from "./video-rubric";
import type { DraftEnvelope } from "./drafts";

test("rubric mentions all six aspects", () => {
  const t = VIDEO_RUBRIC_TEMPLATE.toLowerCase();
  expect(t).toContain("shot composition");
  expect(t).toContain("motion");
  expect(t).toContain("color");
  expect(t).toContain("pacing");
  expect(t).toContain("brief alignment");
  expect(t).toContain("transition");
});

test("buildCoordinatorPrompt embeds rubric, version, and per-shot prompts", () => {
  const draft: DraftEnvelope = {
    version: "v7",
    parent: null,
    reason: "create",
    locked_shots: [],
    shots: [
      { n: 0, prompt: "wide cinematic shot of city", video_url: null },
      { n: 1, prompt: "close-up of hands typing", video_url: null },
    ],
    mp4_filename: "v7.mp4",
    duration_seconds: 8,
    file_bytes: 1000,
    wall_ms: 50,
    model_used: "test",
    updated_at: "t",
  };
  const out = buildCoordinatorPrompt({ brief: "a film about coding", draft });
  expect(out).toContain(VIDEO_RUBRIC_TEMPLATE);
  expect(out).toContain("v7");
  expect(out).toContain("wide cinematic shot of city");
  expect(out).toContain("close-up of hands typing");
  expect(out).toContain("a film about coding");
});
