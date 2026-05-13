/**
 * ffmpeg compose helper for the Draft lane. Inlined from the experiment's
 * ffmpeg-runner — normalize each clip to 1280x720@30fps h264, then concat
 * with crossfades, then +faststart for streaming.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const DEFAULT_CROSSFADE_MS = 500;

export type ComposeInput = {
  clipUrls: string[];
  outPath: string;
  fps?: number;
  crossfadeMs?: number;
};

export type ComposeResult = {
  outPath: string;
  scratchDir: string;
};

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function downloadTo(url: string, path: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download ${url} failed: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
}

export async function composeClips(input: ComposeInput): Promise<ComposeResult> {
  const fps = input.fps ?? FPS;
  const crossfadeMs = input.crossfadeMs ?? DEFAULT_CROSSFADE_MS;
  const crossfadeSec = crossfadeMs / 1000;

  const scratchDir = `/tmp/braid-studio-${randomUUID()}`;
  await mkdir(scratchDir, { recursive: true });
  await mkdir(dirname(input.outPath), { recursive: true });

  // Step 1: download each clip
  const downloaded: string[] = [];
  for (let i = 0; i < input.clipUrls.length; i++) {
    const p = join(scratchDir, `raw-${i + 1}.mp4`);
    const url = input.clipUrls[i];
    if (!url) throw new Error(`composeClips: missing url at index ${i}`);
    await downloadTo(url, p);
    downloaded.push(p);
  }

  // Step 2: normalize each clip to common geometry/fps/codec
  const normalized: string[] = [];
  for (let i = 0; i < downloaded.length; i++) {
    const src = downloaded[i];
    if (!src) continue;
    const dst = join(scratchDir, `norm-${i + 1}.mp4`);
    // Always synthesize silent audio so clips without source audio (some FAL
    // models return video-only mp4s) still normalize uniformly. We drop any
    // source audio — FAL clips don't carry meaningful audio anyway.
    const args = [
      "-y",
      "-i",
      src,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-vf",
      `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-shortest",
      dst,
    ];
    const r = await run("ffmpeg", args);
    if (r.exitCode !== 0) {
      throw new Error(`ffmpeg normalize failed (clip ${i + 1}): ${r.stderr.slice(-1200)}`);
    }
    normalized.push(dst);
  }

  // Step 3: concat with xfade crossfades
  let concatOut: string;
  if (normalized.length === 1) {
    concatOut = normalized[0] ?? "";
  } else {
    // Build filter_complex chain.
    const ffArgs: string[] = ["-y"];
    for (const f of normalized) ffArgs.push("-i", f);

    // Probe duration of each clip
    const durations: number[] = [];
    for (const p of normalized) {
      const dur = await ffprobeDuration(p);
      durations.push(dur);
    }

    const filterParts: string[] = [];
    let prevV = "[0:v]";
    let prevA = "[0:a]";
    let offset = 0;
    for (let i = 1; i < normalized.length; i++) {
      const dur = durations[i - 1] ?? 0;
      offset += dur - crossfadeSec;
      const vOut = `v${i}`;
      const aOut = `a${i}`;
      filterParts.push(
        `${prevV}[${i}:v]xfade=transition=fade:duration=${crossfadeSec}:offset=${offset.toFixed(3)}[${vOut}]`,
      );
      filterParts.push(`${prevA}[${i}:a]acrossfade=d=${crossfadeSec}[${aOut}]`);
      prevV = `[${vOut}]`;
      prevA = `[${aOut}]`;
    }

    concatOut = join(scratchDir, "concat.mp4");
    ffArgs.push(
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      prevV,
      "-map",
      prevA,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      concatOut,
    );
    const r = await run("ffmpeg", ffArgs);
    if (r.exitCode !== 0) {
      throw new Error(`ffmpeg xfade concat failed: ${r.stderr.slice(-1500)}`);
    }
  }

  // Step 4: +faststart for streaming
  const r2 = await run("ffmpeg", [
    "-y",
    "-i",
    concatOut,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    input.outPath,
  ]);
  if (r2.exitCode !== 0) {
    throw new Error(`ffmpeg faststart failed: ${r2.stderr.slice(-1200)}`);
  }
  return { outPath: input.outPath, scratchDir };
}

export async function ffprobeDuration(path: string): Promise<number> {
  const r = await run("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", path]);
  if (r.exitCode !== 0) {
    throw new Error(`ffprobe failed: ${r.stderr.slice(-400)}`);
  }
  const parsed = JSON.parse(r.stdout) as { format?: { duration?: string } };
  return Number.parseFloat(parsed.format?.duration ?? "0");
}
