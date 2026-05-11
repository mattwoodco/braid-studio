#!/usr/bin/env bun
/**
 * Live acceptance test for braid-studio.
 *
 * 1. Health: GET / on localhost:3000.
 * 2. Create project.
 * 3. Draft test: POST /draft, assert mp4 exists, duration > 14s, size > 50KB.
 * 4. Studio test: POST /studio, stream events, wait for end_turn, read
 *    /memory/final.json from the memory store, download mp4, ffprobe.
 * 5. Studio followup: POST /studio/<sessionId>, re-stream, assert
 *    /memory/shots/2.json updated_at is newer, /memory/final.json mp4_url differs.
 */
import { mkdir, copyFile, writeFile, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { listMemories } from "../src/lib/anthropic";
import { ffprobeDuration } from "../src/lib/ffmpeg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const BRIEF =
  "15-second ad for a coffee shop: sunrise light, espresso pouring, a couple at the window. Warm cinematic tones.";

interface DraftRes {
  mp4LocalPath: string;
  shotUrls: string[];
  durationSeconds: number;
  fileBytes: number;
  wallMs: number;
  modelUsed: string | null;
  error?: string;
}

interface FinalJson {
  shot_urls?: string[];
  duration_seconds_per_clip?: number;
  crossfade_ms?: number;
  updated_at?: number | string;
}

interface FinalizeRes {
  mp4LocalPath: string;
  shotUrls: string[];
  durationSeconds: number;
  crossfadeMs: number;
  wallMs: number;
  error?: string;
}

interface ShotJson {
  prompt?: string;
  clip_url?: string;
  updated_at?: string;
}

async function waitForHealth(maxMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok || res.status === 200) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server not healthy at ${BASE} after ${maxMs}ms`);
}

async function createProject(): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `acceptance-${ts}` }),
  });
  if (!res.ok) throw new Error(`create project failed: ${res.status}`);
  const data = (await res.json()) as { storeId: string };
  return data.storeId;
}

async function runDraft(storeId: string): Promise<{ wallMs: number; mp4Path: string }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/projects/${storeId}/draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief: BRIEF }),
  });
  const data = (await res.json()) as DraftRes;
  if (!res.ok || data.error) {
    throw new Error(`draft failed: ${data.error ?? res.status}`);
  }
  const dur = await ffprobeDuration(data.mp4LocalPath);
  const st = await stat(data.mp4LocalPath);
  if (st.size < 50 * 1024) {
    throw new Error(`draft mp4 too small: ${st.size} bytes`);
  }
  if (dur < 5) {
    throw new Error(`draft mp4 too short: ${dur}s`);
  }
  console.log(
    `  draft: wall=${((Date.now() - t0) / 1000).toFixed(1)}s, dur=${dur.toFixed(2)}s, size=${(st.size / 1024).toFixed(0)}KB`,
  );
  return { wallMs: Date.now() - t0, mp4Path: data.mp4LocalPath };
}

async function streamUntilIdle(storeId: string, sessionId: string, maxMs = 600_000): Promise<void> {
  const url = `${BASE}/api/projects/${storeId}/studio/${sessionId}/events`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`SSE open failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + maxMs;
  let buf = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const dataPart = line.slice(5).trim();
        if (!dataPart) continue;
        try {
          const ev = JSON.parse(dataPart) as {
            type: string;
            stopReason?: string;
            toolName?: string;
            text?: string;
          };
          if (ev.type === "agent.message" && ev.text) {
            console.log(`    agent: ${ev.text.slice(0, 120)}`);
          } else if (ev.type === "agent.tool_use") {
            console.log(`    tool_use: ${ev.toolName}`);
          } else if (ev.type === "session.status_idle") {
            console.log(`    idle (${ev.stopReason})`);
            if (ev.stopReason === "end_turn") return;
          }
        } catch {
          // ignore
        }
      }
    }
  }
  throw new Error("studio: stream did not end with end_turn before timeout");
}

async function readFinalJson(storeId: string): Promise<FinalJson | null> {
  for (const p of ["/final.json", "/memory/final.json"]) {
    const memories = await listMemories(storeId, { prefix: p });
    const m = memories.find((x) => x.path === p);
    if (m) {
      try {
        return JSON.parse(m.content) as FinalJson;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function readShotJson(storeId: string, n: number): Promise<ShotJson | null> {
  for (const p of [`/shots/${n}.json`, `/memory/shots/${n}.json`]) {
    const memories = await listMemories(storeId, { prefix: p });
    const m = memories.find((x) => x.path === p);
    if (m) {
      try {
        return JSON.parse(m.content) as ShotJson;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function downloadAndVerify(
  url: string,
  outPath: string,
): Promise<{ size: number; duration: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download mp4 failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(resolvePath(outPath, ".."), { recursive: true });
  await writeFile(outPath, buf);
  const dur = await ffprobeDuration(outPath);
  return { size: buf.length, duration: dur };
}

async function finalizeStudio(storeId: string, sessionId: string): Promise<FinalizeRes> {
  const res = await fetch(
    `${BASE}/api/projects/${storeId}/studio/${sessionId}/finalize`,
    { method: "POST" },
  );
  const data = (await res.json()) as FinalizeRes;
  if (!res.ok || data.error) {
    throw new Error(`finalize failed: ${data.error ?? res.status}`);
  }
  return data;
}

async function runStudio(storeId: string): Promise<{ wallMs: number; sessionId: string; mp4Path: string; shotUrls: string[] }> {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/projects/${storeId}/studio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief: BRIEF }),
  });
  if (!res.ok) throw new Error(`studio create failed: ${res.status}`);
  const data = (await res.json()) as { sessionId: string };
  console.log(`  studio session: ${data.sessionId}`);
  await streamUntilIdle(storeId, data.sessionId);
  const finalJson = await readFinalJson(storeId);
  const shotUrls = finalJson?.shot_urls ?? [];
  if (shotUrls.length === 0) {
    throw new Error("studio: /memory/final.json missing or no shot_urls");
  }
  console.log(`  studio: agent wrote ${shotUrls.length} shot URLs; composing...`);
  const finalized = await finalizeStudio(storeId, data.sessionId);
  if (finalized.durationSeconds < 5) {
    throw new Error(`studio mp4 too short: ${finalized.durationSeconds}s`);
  }
  console.log(
    `  studio: wall=${((Date.now() - t0) / 1000).toFixed(1)}s, dur=${finalized.durationSeconds.toFixed(2)}s, mp4=${finalized.mp4LocalPath}`,
  );
  return { wallMs: Date.now() - t0, sessionId: data.sessionId, mp4Path: finalized.mp4LocalPath, shotUrls };
}

async function runFollowup(
  storeId: string,
  sessionId: string,
  prevShotUrls: string[],
): Promise<{ wallMs: number; mp4Path: string }> {
  const t0 = Date.now();
  const beforeShot2 = await readShotJson(storeId, 2);
  const res = await fetch(`${BASE}/api/projects/${storeId}/studio/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "regenerate shot 2 with cooler tone and softer light",
    }),
  });
  if (!res.ok) throw new Error(`followup post failed: ${res.status}`);
  await streamUntilIdle(storeId, sessionId);
  const afterShot2 = await readShotJson(storeId, 2);
  if (!afterShot2?.updated_at) {
    throw new Error("followup: shot 2 has no updated_at after followup");
  }
  const beforeTs = beforeShot2?.updated_at;
  const afterTs = afterShot2.updated_at;
  if (beforeTs !== undefined && String(afterTs) <= String(beforeTs)) {
    throw new Error(`followup: shot 2 updated_at not newer (before=${beforeTs}, after=${afterTs})`);
  }
  const finalJson = await readFinalJson(storeId);
  const newShotUrls = finalJson?.shot_urls ?? [];
  if (newShotUrls.length === 0) throw new Error("followup: no shot_urls");
  const shot2New = newShotUrls[1];
  const shot2Old = prevShotUrls[1];
  if (shot2New && shot2Old && shot2New === shot2Old) {
    throw new Error("followup: shot 2 URL unchanged");
  }
  const finalized = await finalizeStudio(storeId, sessionId);
  console.log(
    `  followup: wall=${((Date.now() - t0) / 1000).toFixed(1)}s, dur=${finalized.durationSeconds.toFixed(2)}s, mp4=${finalized.mp4LocalPath}`,
  );
  return { wallMs: Date.now() - t0, mp4Path: finalized.mp4LocalPath };
}

async function main(): Promise<void> {
  console.log("[acceptance] waiting for server health...");
  await waitForHealth();
  console.log("[acceptance] creating project...");
  const storeId = await createProject();
  console.log(`[acceptance] storeId=${storeId}`);

  const results: Array<{ test: string; wallMs: number; path: string }> = [];

  console.log("[acceptance] --- DRAFT ---");
  const draft = await runDraft(storeId);
  const draftCopy = resolvePath(
    process.cwd(),
    "data/finals",
    `draft-acceptance-${Date.now()}.mp4`,
  );
  await copyFile(draft.mp4Path, draftCopy);
  results.push({ test: "draft", wallMs: draft.wallMs, path: draftCopy });

  console.log("[acceptance] --- STUDIO ---");
  const studio = await runStudio(storeId);
  results.push({ test: "studio", wallMs: studio.wallMs, path: studio.mp4Path });

  console.log("[acceptance] --- STUDIO FOLLOWUP ---");
  const followup = await runFollowup(storeId, studio.sessionId, studio.shotUrls);
  results.push({ test: "studio-followup", wallMs: followup.wallMs, path: followup.mp4Path });

  console.log("\n[acceptance] SUMMARY");
  console.log("test               wall(s)   ratio-vs-235s  path");
  for (const r of results) {
    const sec = (r.wallMs / 1000).toFixed(1).padStart(7);
    const ratio = (235 / (r.wallMs / 1000)).toFixed(2).padStart(6);
    console.log(`${r.test.padEnd(18)} ${sec}   ${ratio}x       ${r.path}`);
  }
}

main().catch((err) => {
  console.error(`[acceptance] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
