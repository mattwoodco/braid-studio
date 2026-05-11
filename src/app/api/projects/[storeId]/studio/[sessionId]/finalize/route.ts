/**
 * POST /api/projects/[storeId]/studio/[sessionId]/finalize
 *
 * The agent's deliverable is the manifest at `/memory/final.json` (shot URLs).
 * Composing the final mp4 is deterministic plumbing the backend owns.
 *
 * This route reads the manifest from the memory store, downloads the shot
 * clips, runs ffmpeg locally (concat + crossfade + +faststart), and returns
 * the local mp4 path. Idempotent: called once at the end of the agent's
 * session AND after every follow-up that updates the manifest.
 */
import { mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { listMemories } from "@/lib/anthropic";
import { composeClips, ffprobeDuration } from "@/lib/ffmpeg";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type FinalManifest = {
  shot_urls?: unknown;
  duration_seconds_per_clip?: unknown;
  crossfade_ms?: unknown;
  updated_at?: unknown;
};

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || x.length === 0) return null;
    out.push(x);
  }
  return out;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ storeId: string; sessionId: string }> },
): Promise<Response> {
  const { storeId, sessionId } = await ctx.params;
  const t0 = Date.now();

  // The agent writes the manifest at either `/final.json` (root of the mounted
  // memory store) or `/memory/final.json` depending on how it interprets the
  // mount path. Accept both.
  const candidatePaths = ["/final.json", "/memory/final.json"];
  let final: { path: string; content: string } | undefined;
  for (const p of candidatePaths) {
    const mems = await listMemories(storeId, { prefix: p });
    final = mems.find((m) => m.path === p);
    if (final) break;
  }
  if (!final) {
    return Response.json(
      { error: "manifest_missing", message: "Agent has not written /memory/final.json yet." },
      { status: 409 },
    );
  }

  let parsed: FinalManifest;
  try {
    parsed = JSON.parse(final.content) as FinalManifest;
  } catch {
    return Response.json(
      { error: "manifest_malformed", message: "final.json is not valid JSON." },
      { status: 422 },
    );
  }

  const shotUrls = asStringArray(parsed.shot_urls);
  if (!shotUrls || shotUrls.length === 0) {
    return Response.json(
      { error: "no_shot_urls", message: "manifest.shot_urls missing or empty." },
      { status: 422 },
    );
  }
  const crossfadeMs = asNumber(parsed.crossfade_ms) ?? 500;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const finalsDir = resolvePath(process.cwd(), "data", "finals");
  await mkdir(finalsDir, { recursive: true });
  const outPath = resolvePath(finalsDir, `studio-${sessionId.slice(0, 12)}-${ts}.mp4`);

  try {
    await composeClips({ clipUrls: shotUrls, outPath, crossfadeMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "ffmpeg_failed", message: msg }, { status: 500 });
  }

  const duration = await ffprobeDuration(outPath);
  return Response.json({
    mp4LocalPath: outPath,
    shotUrls,
    durationSeconds: duration,
    crossfadeMs,
    wallMs: Date.now() - t0,
  });
}
