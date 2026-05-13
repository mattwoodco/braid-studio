import { describe, expect, it } from "bun:test";
import { RUBRIC_TEMPLATE } from "./rubric";

describe("RUBRIC_TEMPLATE", () => {
  const required: string[] = [
    "drafts/HEAD.json",
    "append-only",
    "parent",
    "reason",
    "locked_shots",
    "/memory/drafts/{version}.json",
    "v1",
    "v2",
    "head endpoint",
    "create",
    "sweep:",
    "constrain:locked=[",
    "critique:",
    "chat:",
  ];

  for (const needle of required) {
    it(`contains literal substring: ${needle}`, () => {
      expect(RUBRIC_TEMPLATE.includes(needle)).toBe(true);
    });
  }

  it("preserves the original rubric preamble", () => {
    expect(RUBRIC_TEMPLATE).toContain(
      "Produce an mp4 reflecting the brief. Each shot must be vivid.",
    );
    expect(RUBRIC_TEMPLATE).toContain("ffprobe");
  });

  it("explains monotonic versioning and HEAD pointer non-overwrite", () => {
    expect(RUBRIC_TEMPLATE).toContain("monotonic");
    expect(RUBRIC_TEMPLATE).toContain("Never overwrite past versions");
  });
});
