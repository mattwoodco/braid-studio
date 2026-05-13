/**
 * Critique loop primitives: per-aspect scores from a multiagent critic panel,
 * aggregated into locked / regenerate partitions over the parent draft.
 *
 * Pure logic + a storage seam that piggybacks on the same DraftsStorage shape
 * used by `drafts.ts`. The Anthropic SDK is never imported here.
 */
import { z } from "zod";
import type { DraftsStorage } from "./drafts";
import {
  createMemory,
  listMemories,
  type MemoryEntry,
  updateMemory,
} from "./anthropic";

export const CRITIQUE_THRESHOLD = 0.7;

export const CRITIQUE_ASPECTS = [
  "cinematography",
  "pacing",
  "color",
  "narrative",
  "audio",
  "brand",
] as const;
export type CritiqueAspect = (typeof CRITIQUE_ASPECTS)[number];

export type ShotScore = {
  n: number;
  score: number;
  issues: string[];
  suggestion?: string;
};

export type CritiqueEnvelope = {
  version: string;
  parent_draft: string;
  aspect: CritiqueAspect;
  shot_scores: ShotScore[];
  overall: number;
  summary: string;
  created_at: string;
};

export type AggregateResult = {
  locked: number[];
  regen: { n: number; suggestion: string }[];
  overall: number;
};

const shotScoreSchema = z.object({
  n: z.number(),
  score: z.number(),
  issues: z.array(z.string()),
  suggestion: z.string().optional(),
});

const aspectSchema = z.enum(CRITIQUE_ASPECTS);

const envelopeSchema: z.ZodType<CritiqueEnvelope> = z.object({
  version: z.string(),
  parent_draft: z.string(),
  aspect: aspectSchema,
  shot_scores: z.array(shotScoreSchema),
  overall: z.number(),
  summary: z.string(),
  created_at: z.string(),
});

function parseEnvelope(text: string): CritiqueEnvelope | null {
  try {
    const raw: unknown = JSON.parse(text);
    const parsed = envelopeSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------- aggregate / summarize ----------

export function aggregate(envelopes: CritiqueEnvelope[]): AggregateResult {
  if (envelopes.length === 0) {
    return { locked: [], regen: [], overall: 0 };
  }

  // Collect per-shot scores across all aspects.
  const perShot = new Map<number, { scores: number[]; suggestions: string[] }>();
  for (const env of envelopes) {
    for (const s of env.shot_scores) {
      const bucket = perShot.get(s.n) ?? { scores: [], suggestions: [] };
      bucket.scores.push(s.score);
      if (s.suggestion) bucket.suggestions.push(`${env.aspect}: ${s.suggestion}`);
      perShot.set(s.n, bucket);
    }
  }

  const locked: number[] = [];
  const regen: { n: number; suggestion: string }[] = [];
  let totalScore = 0;
  let count = 0;

  for (const [n, bucket] of [...perShot.entries()].sort((a, b) => a[0] - b[0])) {
    const shotAvg = bucket.scores.reduce((a, b) => a + b, 0) / bucket.scores.length;
    totalScore += shotAvg;
    count++;
    if (shotAvg >= CRITIQUE_THRESHOLD) {
      locked.push(n);
    } else {
      regen.push({
        n,
        suggestion: bucket.suggestions.join("; ") || "improve overall quality",
      });
    }
  }

  return {
    locked,
    regen,
    overall: count > 0 ? totalScore / count : 0,
  };
}

export function summarize(envelopes: CritiqueEnvelope[]): string {
  const out = aggregate(envelopes);
  const overall = out.overall.toFixed(2);
  const s = `critique:overall=${overall},locked=${out.locked.length},regen=${out.regen.length}`;
  return s.length > 80 ? s.slice(0, 80) : s;
}

// ---------- Storage seam ----------

export type CritiqueStorage = DraftsStorage;

const CRITIQUES_PREFIX = "/memory/critiques/";

function critiquePath(version: string, aspect: CritiqueAspect): string {
  return `${CRITIQUES_PREFIX}${version}/${aspect}.json`;
}

const VERSION_RE = /^\/memory\/critiques\/([^/]+)\/([^/]+)\.json$/;

const defaultStorage: CritiqueStorage = {
  async create(storeId, path, content) {
    const entry = await createMemory(storeId, { path, content });
    return { id: entry.id, path: entry.path, content: entry.content };
  },
  async update(storeId, memoryId, content) {
    const entry = await updateMemory(storeId, memoryId, { content });
    return { id: entry.id, path: entry.path, content: entry.content };
  },
  async list(storeId, prefix) {
    const opts: { prefix?: string } = {};
    if (prefix !== undefined) opts.prefix = prefix;
    const entries: MemoryEntry[] = await listMemories(storeId, opts);
    return entries.map((e) => ({ id: e.id, path: e.path }));
  },
  async read(storeId, memoryId) {
    const entries = await listMemories(storeId, { prefix: CRITIQUES_PREFIX });
    const hit = entries.find((e) => e.id === memoryId);
    if (!hit) throw new Error(`critique.read: not found: ${memoryId}`);
    return { id: hit.id, path: hit.path, content: hit.content };
  },
};

let _storage: CritiqueStorage = defaultStorage;

export function setCritiqueStorage(impl: CritiqueStorage): void {
  _storage = impl;
}

export async function writeCritique(
  storeId: string,
  envelope: CritiqueEnvelope,
): Promise<void> {
  await _storage.create(
    storeId,
    critiquePath(envelope.parent_draft, envelope.aspect),
    JSON.stringify(envelope),
  );
}

export async function listCritiques(
  storeId: string,
  draftVersion: string,
): Promise<CritiqueEnvelope[]> {
  const entries = await _storage.list(storeId, CRITIQUES_PREFIX);
  const out: CritiqueEnvelope[] = [];
  for (const e of entries) {
    const m = VERSION_RE.exec(e.path);
    if (!m || m[1] !== draftVersion) continue;
    try {
      const read = await _storage.read(storeId, e.id);
      const parsed = parseEnvelope(read.content);
      if (parsed) out.push(parsed);
    } catch {
      // skip
    }
  }
  return out;
}
