import {
  type Dream,
  createDream as defaultCreateDream,
  getDream as defaultGetDream,
} from "./anthropic";

export const DEFAULT_INSTRUCTIONS = `You are curating CRAFT TASTE for a video-ad studio from completed projects.

Read every critique envelope under /memory/critiques/**. For each aspect:
1. Aggregate scores into bands. Bucket high-band (≥0.85) and low-band (<0.5).
2. Extract the RECURRING patterns (≥2 occurrences) in each band.
3. Cross-reference with the BRIEF GENRE (luxury, ugc, doc, comedy, horror, anthem, editorial, thriller).

Write the curated lessons to /memory/taste/v{N}.json with this shape:
{
  "winning_patterns": {
    "<aspect>": {
      "<genre>": ["pattern with ≥2 occurrences at score ≥ 0.85", ...]
    }
  },
  "failure_modes": {
    "<aspect>": {
      "<genre>": ["pattern with ≥2 occurrences at score < 0.5", ...]
    }
  },
  "operational_overrides": {
    "<aspect>": "If the brief is in genre X, the operational definition should add ..."
  }
}

Only include patterns that appear ≥2 times. Cap to 2KB per genre to stay under the 100KB memory cap.`;

export type TasteDreamInput = {
  briefStoreIds: string[];
  previousTasteStoreId?: string;
  instructions?: string;
};

export type TasteDreamCreateInput = {
  memory_store_ids: string[];
  instructions: string;
};

export type TasteDreamDeps = {
  createDream: (input: TasteDreamCreateInput) => Promise<Dream>;
  getDream: (dreamId: string) => Promise<Dream>;
  pollIntervalMs?: number;
  maxPolls?: number;
};

export type TasteDreamResult = { tasteStoreId: string };

export class TasteDreamFailedError extends Error {
  constructor(public readonly dream: Dream) {
    super(`taste-dream: dream ${dream.id} ended with status=${dream.status}`);
    this.name = "TasteDreamFailedError";
  }
}

export class TasteDreamNoOutputError extends Error {
  constructor(public readonly dream: Dream) {
    super(`taste-dream: completed dream ${dream.id} has no output memory store`);
    this.name = "TasteDreamNoOutputError";
  }
}

export class TasteDreamTimeoutError extends Error {
  constructor(public readonly dreamId: string) {
    super(`taste-dream: timed out polling dream ${dreamId}`);
    this.name = "TasteDreamTimeoutError";
  }
}

export class TasteDreamEmptyInputError extends Error {
  constructor() {
    super("taste-dream: briefStoreIds must contain at least one id");
    this.name = "TasteDreamEmptyInputError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function adaptCreateDream(input: TasteDreamCreateInput): Promise<Dream> {
  const [primary, ...rest] = input.memory_store_ids;
  if (!primary) throw new TasteDreamEmptyInputError();
  return defaultCreateDream({
    memoryStoreId: primary,
    instructions: input.instructions,
    ...(rest.length > 0 ? { sessionIds: rest } : {}),
  });
}

export async function runTasteDream(
  input: TasteDreamInput,
  deps: TasteDreamDeps = {
    createDream: adaptCreateDream,
    getDream: defaultGetDream,
  },
): Promise<TasteDreamResult> {
  if (input.briefStoreIds.length === 0) throw new TasteDreamEmptyInputError();

  const memory_store_ids = [
    ...input.briefStoreIds,
    ...(input.previousTasteStoreId ? [input.previousTasteStoreId] : []),
  ];

  const created = await deps.createDream({
    memory_store_ids,
    instructions: input.instructions ?? DEFAULT_INSTRUCTIONS,
  });

  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
  const maxPolls = deps.maxPolls ?? 600;

  let current = created;
  for (let i = 0; i < maxPolls; i++) {
    if (current.status === "completed") {
      const output = current.outputs[0];
      if (!output) throw new TasteDreamNoOutputError(current);
      return { tasteStoreId: output.memory_store_id };
    }
    if (current.status === "failed" || current.status === "canceled") {
      throw new TasteDreamFailedError(current);
    }
    await sleep(pollIntervalMs);
    current = await deps.getDream(created.id);
  }
  throw new TasteDreamTimeoutError(created.id);
}
