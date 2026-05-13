/**
 * Versioned envelope drafts on top of the Claude Managed Agents Memory Store.
 *
 * Public contract per docs/SPEC.md Unit 1:
 *   - DraftEnvelope, Head types
 *   - writeDraft, listDrafts, readDraft, readHead, writeHead, nextVersion
 *   - setDraftsStorage(impl) — test seam
 *
 * Storage is abstracted behind `DraftsStorage` so tests inject a fake and never
 * touch the live SDK. The default implementation wraps the helpers in
 * `./anthropic.ts`.
 */
import { z } from "zod";
import {
  createMemory,
  listMemories,
  type MemoryEntry,
  updateMemory,
} from "./anthropic";

// ---------- Public types ----------

export type DraftEnvelope = {
  version: string;
  parent: string | null;
  reason: string;
  sweep_run_id?: string;
  locked_shots: number[];
  shots: { n: number; prompt: string; video_url: string | null }[];
  mp4_filename: string;
  duration_seconds: number;
  file_bytes: number;
  wall_ms: number;
  model_used: string | null;
  updated_at: string;
};

export type Head = { version: string; updated_at: string };

// ---------- Storage seam ----------

export interface DraftsStorage {
  create(
    storeId: string,
    path: string,
    content: string,
  ): Promise<{ id: string; path: string; content: string }>;
  update(
    storeId: string,
    memoryId: string,
    content: string,
  ): Promise<{ id: string; path: string; content: string }>;
  list(
    storeId: string,
    prefix?: string,
  ): Promise<{ id: string; path: string }[]>;
  read(
    storeId: string,
    memoryId: string,
  ): Promise<{ id: string; path: string; content: string }>;
}

/**
 * Default storage implementation backed by the Anthropic Memory API. The
 * `list` helper from `./anthropic.ts` already returns content (view=full), so
 * we cache it inline and `read` simply fetches a fresh list.
 */
const defaultStorage: DraftsStorage = {
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
    const entries = await listMemories(storeId, { prefix: DRAFTS_PREFIX });
    const hit = entries.find((e) => e.id === memoryId);
    if (!hit) throw new Error(`drafts.read: memory not found: ${memoryId}`);
    return { id: hit.id, path: hit.path, content: hit.content };
  },
};

let _storage: DraftsStorage = defaultStorage;

export function setDraftsStorage(impl: DraftsStorage): void {
  _storage = impl;
}

// ---------- Paths ----------

const DRAFTS_PREFIX = "/memory/drafts/";
const HEAD_PATH = "/memory/drafts/HEAD.json";

function draftPath(version: string): string {
  return `${DRAFTS_PREFIX}${version}.json`;
}

const VERSION_RE = /^v(\d+)$/;
const VERSION_FILE_RE = /^\/memory\/drafts\/v(\d+)\.json$/;

// ---------- Zod schemas (boundary validation) ----------

const shotSchema = z.object({
  n: z.number(),
  prompt: z.string(),
  video_url: z.union([z.string(), z.null()]),
});

const envelopeSchema: z.ZodType<DraftEnvelope> = z.object({
  version: z.string(),
  parent: z.union([z.string(), z.null()]),
  reason: z.string(),
  sweep_run_id: z.string().optional(),
  locked_shots: z.array(z.number()),
  shots: z.array(shotSchema),
  mp4_filename: z.string(),
  duration_seconds: z.number(),
  file_bytes: z.number(),
  wall_ms: z.number(),
  model_used: z.union([z.string(), z.null()]),
  updated_at: z.string(),
});

const headSchema: z.ZodType<Head> = z.object({
  version: z.string(),
  updated_at: z.string(),
});

function parseEnvelope(text: string): DraftEnvelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = envelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseHead(text: string): Head | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = headSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------- Public API ----------

/**
 * Returns the next monotonic version, sorted by numeric suffix so v10 > v9.
 * Invalid version strings are ignored.
 */
export function nextVersion(existing: string[]): string {
  let max = 0;
  for (const v of existing) {
    const m = VERSION_RE.exec(v);
    if (!m || m[1] === undefined) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `v${max + 1}`;
}

/**
 * Writes a new draft envelope. Throws if the version already exists in the
 * drafts listing.
 */
export async function writeDraft(
  storeId: string,
  envelope: DraftEnvelope,
): Promise<void> {
  const existing = await _storage.list(storeId, DRAFTS_PREFIX);
  const versions = listExistingVersions(existing);
  if (versions.includes(envelope.version)) {
    throw new Error(`drafts.writeDraft: version already exists: ${envelope.version}`);
  }
  await _storage.create(
    storeId,
    draftPath(envelope.version),
    JSON.stringify(envelope),
  );
}

function listExistingVersions(entries: { path: string }[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const m = VERSION_FILE_RE.exec(e.path);
    if (m) out.push(`v${m[1]}`);
  }
  return out;
}

/**
 * Returns all draft envelopes in the store, ascending by numeric version.
 * Skips HEAD.json, non-`v{N}.json` paths, and malformed JSON.
 */
export async function listDrafts(storeId: string): Promise<DraftEnvelope[]> {
  const entries = await _storage.list(storeId, DRAFTS_PREFIX);
  const matches: { id: string; path: string; n: number }[] = [];
  for (const e of entries) {
    const m = VERSION_FILE_RE.exec(e.path);
    if (!m || m[1] === undefined) continue;
    matches.push({ id: e.id, path: e.path, n: Number.parseInt(m[1], 10) });
  }
  matches.sort((a, b) => a.n - b.n);
  const out: DraftEnvelope[] = [];
  for (const m of matches) {
    let content: string;
    try {
      const read = await _storage.read(storeId, m.id);
      content = read.content;
    } catch {
      continue;
    }
    const env = parseEnvelope(content);
    if (env) out.push(env);
  }
  return out;
}

/**
 * Returns a single draft envelope by version, or null if missing/malformed.
 */
export async function readDraft(
  storeId: string,
  version: string,
): Promise<DraftEnvelope | null> {
  const entries = await _storage.list(storeId, DRAFTS_PREFIX);
  const target = draftPath(version);
  const hit = entries.find((e) => e.path === target);
  if (!hit) return null;
  try {
    const read = await _storage.read(storeId, hit.id);
    return parseEnvelope(read.content);
  } catch {
    return null;
  }
}

/**
 * Returns the current HEAD pointer or null.
 */
export async function readHead(storeId: string): Promise<Head | null> {
  const entries = await _storage.list(storeId, DRAFTS_PREFIX);
  const hit = entries.find((e) => e.path === HEAD_PATH);
  if (!hit) return null;
  try {
    const read = await _storage.read(storeId, hit.id);
    return parseHead(read.content);
  } catch {
    return null;
  }
}

/**
 * Upserts HEAD.json — `update` if it already exists, otherwise `create`.
 */
export async function writeHead(storeId: string, head: Head): Promise<void> {
  const entries = await _storage.list(storeId, DRAFTS_PREFIX);
  const existing = entries.find((e) => e.path === HEAD_PATH);
  const content = JSON.stringify(head);
  if (existing) {
    await _storage.update(storeId, existing.id, content);
  } else {
    await _storage.create(storeId, HEAD_PATH, content);
  }
}
