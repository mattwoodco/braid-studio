/**
 * Deterministic critique smoke: real Draft → synthetic critique → real Apply,
 * iterated v1 → v2 → v3 with 3 shots.
 *
 * Goal: produce three actual mp4 files where the locked-shot pipeline reuses
 * URLs from earlier iterations and only regenerates the "failing" shots, so
 * the videos visibly improve in the regenerated slots while held-shot bytes
 * are unchanged.
 *
 * Bypasses the Managed-Agent critic (which needs a submit_critique tool not
 * yet wired) by writing critique envelopes synthetically via the same storage
 * path the agent would have used. The Apply route, video backend, drafts
 * storage, and critique storage are ALL real.
 */
import {
  type CritiqueAspect,
  type CritiqueEnvelope,
  CRITIQUE_ASPECTS,
  writeCritique,
} from "@/lib/critique";
import {
  type DraftEnvelope,
  listDrafts,
  nextVersion,
  readDraft,
  writeDraft,
  writeHead,
} from "@/lib/drafts";
import { createMemoryStore, updateMemoryStoreMetadata } from "@/lib/anthropic";
import { getVideoBackend } from "@/lib/video-backend";
import { basename } from "node:path";
import { POST as applyPOST } from "@/app/api/projects/[storeId]/critique/[sessionId]/apply/route";

function log(...args: unknown[]): void {
  console.log("[smoke]", ...args);
}

async function buildV1(storeId: string): Promise<DraftEnvelope> {
  const prompts = [
    "establishing wide shot: a quiet city street at dawn, warm sunlight, slow dolly forward",
    "medium shot: a person walks past, in profile, soft morning light",
    "close-up: hands holding a paper coffee cup, steam rising",
  ];
  log("v1: generating 3 shots via FAL");
  const start = Date.now();
  const result = await getVideoBackend().generateAndCompose({
    prompts,
    storeId,
    outputBasename: `smoke-${storeId}-v1-${start}`,
  });
  const envelope: DraftEnvelope = {
    version: "v1",
    parent: null,
    reason: "create",
    locked_shots: [],
    shots: prompts.map((p, i) => ({
      n: i,
      prompt: p,
      video_url: result.shotUrls[i] ?? null,
    })),
    mp4_filename: basename(result.mp4LocalPath),
    duration_seconds: result.durationSeconds,
    file_bytes: result.fileBytes,
    wall_ms: Date.now() - start,
    model_used: result.modelUsed,
    updated_at: new Date().toISOString(),
  };
  await writeDraft(storeId, envelope);
  await writeHead(storeId, { version: "v1", updated_at: envelope.updated_at });
  log("v1: done", { mp4: result.mp4LocalPath, bytes: result.fileBytes });
  return envelope;
}

/**
 * Write 6 aspect envelopes for `draftVersion`, with the given per-shot scores
 * (same scores reused across aspects — deterministic).
 */
async function writeSyntheticCritique(
  storeId: string,
  draftVersion: string,
  scores: number[],
): Promise<void> {
  for (const aspect of CRITIQUE_ASPECTS) {
    const env: CritiqueEnvelope = {
      version: `c-${aspect}-${draftVersion}`,
      parent_draft: draftVersion,
      aspect: aspect as CritiqueAspect,
      shot_scores: scores.map((s, n) => ({
        n,
        score: s,
        issues: s < 0.7 ? [`${aspect} weak in shot ${n}`] : [],
        suggestion:
          s < 0.7
            ? `improve ${aspect} on shot ${n}: more contrast and intentional motion`
            : undefined,
      })),
      overall: scores.reduce((a, b) => a + b, 0) / scores.length,
      summary: `synthetic ${aspect} for ${draftVersion}`,
      created_at: new Date().toISOString(),
    };
    await writeCritique(storeId, env);
  }
}

async function applyOnce(
  storeId: string,
  parentVersion: string,
): Promise<DraftEnvelope> {
  const req = new Request("http://smoke/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draftVersion: parentVersion }),
  });
  const res = await applyPOST(req, {
    params: Promise.resolve({ storeId, sessionId: "smoke-no-session" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`apply ${parentVersion} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as DraftEnvelope;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
  if (!process.env.FAL_API_KEY) throw new Error("FAL_API_KEY missing");

  log("creating memory store");
  const store = await createMemoryStore({
    name: `critique-smoke-${new Date().toISOString().slice(0, 19)}`,
    description: "Deterministic critique smoke",
  });
  await updateMemoryStoreMetadata(store.id, {
    braid_studio: "v1",
    project_name: "critique-smoke",
  });
  log("store", store.id);

  // ---- v1: real generation ----
  const v1 = await buildV1(store.id);

  // ---- v1 critique: shot 0 passes, shots 1,2 fail ----
  await writeSyntheticCritique(store.id, "v1", [0.85, 0.4, 0.35]);
  log("v1 critique written: lock=[0], regen=[1,2]");

  // ---- apply → v2 ----
  log("apply v1 → v2 (expect shot 0 reused, shots 1,2 regenerated)");
  const v2 = await applyOnce(store.id, "v1");
  log("v2 done", {
    locked: v2.locked_shots,
    mp4: v2.mp4_filename,
    bytes: v2.file_bytes,
  });

  // ---- v2 critique: shots 0,1 pass, shot 2 fails ----
  await writeSyntheticCritique(store.id, "v2", [0.85, 0.8, 0.35]);
  log("v2 critique written: lock=[0,1], regen=[2]");

  // ---- apply → v3 ----
  log("apply v2 → v3 (expect shots 0,1 reused, shot 2 regenerated)");
  const v3 = await applyOnce(store.id, "v2");
  log("v3 done", {
    locked: v3.locked_shots,
    mp4: v3.mp4_filename,
    bytes: v3.file_bytes,
  });

  // ---- summary ----
  const drafts = await listDrafts(store.id);
  const byV: Record<string, DraftEnvelope> = {};
  for (const d of drafts) byV[d.version] = d;
  const get = (v: string) => byV[v] ?? null;

  const a = get("v1");
  const b = get("v2");
  const c = get("v3");
  if (!a || !b || !c) throw new Error("missing version");

  // Validate shot-URL reuse contracts.
  const reuse = (parent: DraftEnvelope, child: DraftEnvelope, n: number) =>
    parent.shots[n]?.video_url === child.shots[n]?.video_url;

  const checks = {
    v2_shot0_reused: reuse(a, b, 0),
    v2_shot1_changed: !reuse(a, b, 1),
    v2_shot2_changed: !reuse(a, b, 2),
    v3_shot0_reused: reuse(b, c, 0),
    v3_shot1_reused: reuse(b, c, 1),
    v3_shot2_changed: !reuse(b, c, 2),
    locked_growth: a.locked_shots.length <= b.locked_shots.length &&
      b.locked_shots.length <= c.locked_shots.length,
  };
  const allPass = Object.values(checks).every(Boolean);

  console.log("\n=== SMOKE RESULT ===");
  console.log("store:", store.id);
  console.log("v1 mp4:", a.mp4_filename, `(${a.file_bytes} bytes, ${a.locked_shots.length} locked)`);
  console.log("v2 mp4:", b.mp4_filename, `(${b.file_bytes} bytes, ${b.locked_shots.length} locked)`);
  console.log("v3 mp4:", c.mp4_filename, `(${c.file_bytes} bytes, ${c.locked_shots.length} locked)`);
  console.log("\nshot URLs:");
  for (let i = 0; i < 3; i++) {
    console.log(`  shot ${i}:`);
    console.log(`    v1: ${a.shots[i]?.video_url}`);
    console.log(`    v2: ${b.shots[i]?.video_url}`);
    console.log(`    v3: ${c.shots[i]?.video_url}`);
  }
  console.log("\nchecks:", checks);
  console.log(allPass ? "\nALL CHECKS PASSED ✓" : "\nSOME CHECKS FAILED ✗");
  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
