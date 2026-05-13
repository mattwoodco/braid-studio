/**
 * The video rubric used by the critique session. Distinct from the storage
 * rubric in `./rubric.ts` (which validates draft envelopes).
 */
import type { DraftEnvelope } from "./drafts";

export const VIDEO_RUBRIC_TEMPLATE = `You are grading a short video composed of N shots.

Score each shot from 0 to 1 across these aspects (any below 0.7 will trigger regeneration):

- Shot composition: framing, subject placement, depth, headroom
- Motion quality: stability, intentional movement, no hitching
- Color cohesion: palette consistency with adjacent shots; white balance
- Pacing: shot duration appropriate to subject and rhythm
- Brief alignment: shot serves the stated brief and narrative beat
- Transition smoothness: visual continuity into the next shot

For each shot emit { n, score, issues[], suggestion } in a JSON object grouped by aspect. Submit the result via the submit_critique tool.

Iterate until every shot scores >= 0.7 across all aspects, or until max_iterations is reached.`;

export function buildCoordinatorPrompt(input: {
  brief: string;
  draft: DraftEnvelope;
}): string {
  const { brief, draft } = input;
  const shots = draft.shots
    .map((s) => `  [${s.n}] ${s.prompt}`)
    .join("\n");
  return `${VIDEO_RUBRIC_TEMPLATE}

---

Project brief: ${brief}

Draft version: ${draft.version}
Shots:
${shots}

Critique each shot per the rubric above and write per-aspect envelopes to /memory/critiques/${draft.version}/<aspect>.json.`;
}
