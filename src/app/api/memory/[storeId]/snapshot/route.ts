/**
 * GET /api/memory/[storeId]/snapshot
 *
 * Reads memory entries for a project store and returns a normalized snapshot
 * of `manifest.json`, `shots/<N>.json`, `final.json`, and the versioned
 * envelope drafts (`drafts/<vN>.json`) plus `drafts/HEAD.json`. Supports ETag
 * / If-None-Match for cheap polling.
 *
 * R3 (SPEC perf contract): never re-read the same memory entry twice — one
 * `listMemories` pass for non-draft entries plus the drafts seam for
 * envelopes/HEAD. R5: ETag changes when any draft or HEAD changes.
 */
import { createHash } from "node:crypto";
import { listMemories, type MemoryEntry } from "@/lib/anthropic";
import {
  type DraftEnvelope,
  type Head,
  listDrafts,
  readHead,
} from "@/lib/drafts";

export const dynamic = "force-dynamic";

type Manifest = {
  name: string;
  brief: string;
  created_at: string;
};

type Shot = {
  n: number;
  prompt: string;
  video_url: string | null;
  updated_at: string;
  path: string;
  id: string;
};

type Final = {
  shot_urls: string[];
  duration_seconds_per_clip: number;
  crossfade_ms: number;
  updated_at: string;
};

type Draft = {
  mp4_filename: string;
  shot_urls: string[];
  duration_seconds: number;
  file_bytes: number;
  wall_ms: number;
  model_used: string | null;
  updated_at: string;
};

type Snapshot = {
  manifest: Manifest | null;
  shots: Shot[];
  final: Final | null;
  draft: Draft | null;
  drafts: DraftEnvelope[];
  head: Head | null;
};

// ---------- Test seam ----------

export type MemoryLister = (storeId: string) => Promise<MemoryEntry[]>;

let _memoryLister: MemoryLister = (storeId) => listMemories(storeId);

/**
 * Test seam: inject a fake `listMemories` implementation. Resetting requires
 * passing the live impl back in.
 */
export function setSnapshotMemoryLister(impl: MemoryLister): void {
  _memoryLister = impl;
}

export function resetSnapshotMemoryLister(): void {
  _memoryLister = (storeId) => listMemories(storeId);
}

// ---------- Parsing helpers ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string") out.push(v);
  }
  return out;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseManifest(entry: MemoryEntry): Manifest | null {
  const rec = asRecord(safeParseJson(entry.content));
  if (!rec) return null;
  return {
    name: asString(rec.name),
    brief: asString(rec.brief),
    created_at: asString(rec.created_at),
  };
}

function parseShot(entry: MemoryEntry): Shot | null {
  const rec = asRecord(safeParseJson(entry.content));
  if (!rec) return null;
  const n = asNumber(rec.n, Number.NaN);
  if (!Number.isFinite(n)) return null;
  const videoUrl = typeof rec.video_url === "string" ? rec.video_url : null;
  return {
    n,
    prompt: asString(rec.prompt),
    video_url: videoUrl,
    updated_at: asString(rec.updated_at, entry.updatedAt),
    path: entry.path,
    id: entry.id,
  };
}

function parseLegacyDraft(entry: MemoryEntry): Draft | null {
  const rec = asRecord(safeParseJson(entry.content));
  if (!rec) return null;
  const filename = asString(rec.mp4_filename);
  if (!filename) return null;
  return {
    mp4_filename: filename,
    shot_urls: asStringArray(rec.shot_urls),
    duration_seconds: asNumber(rec.duration_seconds),
    file_bytes: asNumber(rec.file_bytes),
    wall_ms: asNumber(rec.wall_ms),
    model_used: typeof rec.model_used === "string" ? rec.model_used : null,
    updated_at: asString(rec.updated_at, entry.updatedAt),
  };
}

function parseFinal(entry: MemoryEntry): Final | null {
  const rec = asRecord(safeParseJson(entry.content));
  if (!rec) return null;
  return {
    shot_urls: asStringArray(rec.shot_urls),
    duration_seconds_per_clip: asNumber(rec.duration_seconds_per_clip),
    crossfade_ms: asNumber(rec.crossfade_ms),
    updated_at: asString(rec.updated_at, entry.updatedAt),
  };
}

/**
 * Derive a back-compat `draft` view from a HEAD envelope.
 */
function draftFromEnvelope(env: DraftEnvelope): Draft {
  const shot_urls: string[] = [];
  for (const s of env.shots) {
    if (typeof s.video_url === "string") shot_urls.push(s.video_url);
  }
  return {
    mp4_filename: env.mp4_filename,
    shot_urls,
    duration_seconds: env.duration_seconds,
    file_bytes: env.file_bytes,
    wall_ms: env.wall_ms,
    model_used: env.model_used,
    updated_at: env.updated_at,
  };
}

type NonDraftParts = {
  manifest: Manifest | null;
  shots: Shot[];
  final: Final | null;
  legacyDraft: Draft | null;
};

function buildNonDraftParts(entries: MemoryEntry[]): NonDraftParts {
  let manifest: Manifest | null = null;
  let final: Final | null = null;
  let legacyDraft: Draft | null = null;
  const shots: Shot[] = [];

  for (const entry of entries) {
    const p = entry.path.replace(/^\/?(memory\/)?/, "");
    if (p === "manifest.json") {
      manifest = parseManifest(entry);
    } else if (p === "final.json") {
      final = parseFinal(entry);
    } else if (p === "draft.json") {
      legacyDraft = parseLegacyDraft(entry);
    } else if (p.startsWith("shots/") && p.endsWith(".json")) {
      const shot = parseShot(entry);
      if (shot) shots.push(shot);
    }
  }

  shots.sort((a, b) => a.n - b.n);
  return { manifest, shots, final, legacyDraft };
}

/**
 * ETag input must change whenever any draft envelope, HEAD pointer, or
 * non-draft entry changes. We hash the full snapshot JSON plus stable
 * identifiers (version + updated_at) for drafts/HEAD.
 */
function computeEtag(
  snapshot: Snapshot,
  drafts: DraftEnvelope[],
  head: Head | null,
): string {
  const draftFingerprint = drafts.map((d) => ({
    v: d.version,
    u: d.updated_at,
  }));
  const headFingerprint = head ? { v: head.version, u: head.updated_at } : null;
  const input = JSON.stringify({
    s: snapshot,
    d: draftFingerprint,
    h: headFingerprint,
  });
  const hash = createHash("sha256").update(input).digest("hex");
  return `W/"${hash.slice(0, 16)}"`;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ storeId: string }> },
): Promise<Response> {
  const { storeId } = await ctx.params;

  let entries: MemoryEntry[];
  let drafts: DraftEnvelope[];
  let head: Head | null;
  try {
    // Run the three reads in parallel. Drafts/HEAD go through the drafts
    // storage seam; non-draft entries come from one listMemories pass.
    [entries, drafts, head] = await Promise.all([
      _memoryLister(storeId),
      listDrafts(storeId),
      readHead(storeId),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { manifest, shots, final, legacyDraft } = buildNonDraftParts(entries);

  // Derive the back-compat `draft` field. Prefer HEAD envelope when present;
  // otherwise fall back to legacy `/memory/draft.json`.
  let draft: Draft | null = null;
  if (head) {
    const headEnv = drafts.find((d) => d.version === head.version) ?? null;
    if (headEnv) draft = draftFromEnvelope(headEnv);
  }
  if (!draft) draft = legacyDraft;

  const snapshot: Snapshot = {
    manifest,
    shots,
    final,
    draft,
    drafts,
    head,
  };
  const etag = computeEtag(snapshot, drafts, head);

  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: {
      ETag: etag,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
