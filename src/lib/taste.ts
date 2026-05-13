/**
 * Taste memory: a singleton "winners" memory store that critic sessions mount
 * read-only so the rubric primes on past projects. Populated by Dreams after
 * each project finishes.
 */
import { type CreateDreamInput, createDream } from "./anthropic";

let _tasteStoreId: string | null = null;

export function setTasteStoreId(id: string | null): void {
  _tasteStoreId = id;
}

export function getTasteStoreId(): string | null {
  return _tasteStoreId;
}

const TASTE_DREAM_INSTRUCTIONS = [
  "You are distilling video-direction taste from a finished project.",
  "Read each critique aspect file and the final draft envelope.",
  "Emit at /memory/taste/winners.json an object with:",
  "  - palette: dominant colors used in shots that scored >= 0.7",
  "  - pacing: avg shot duration of high-scoring shots",
  "  - motifs: subjects/compositions that recurred in winners",
  "  - avoid: patterns from shots that scored < 0.7",
  "Keep it under 4KB. Do not include any source URLs.",
].join("\n");

export async function createTasteDream(
  sourceStoreId: string,
  sessionIds: string[],
): Promise<{ dreamId: string }> {
  const input: CreateDreamInput = {
    memoryStoreId: sourceStoreId,
    instructions: TASTE_DREAM_INSTRUCTIONS,
  };
  if (sessionIds.length > 0) input.sessionIds = sessionIds;
  const dream = await createDream(input);
  return { dreamId: dream.id };
}
