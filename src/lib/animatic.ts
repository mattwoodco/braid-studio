import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const MUSIC_VOLUME = 0.2;

export type AnimaticStill = { path: string; durationSec: number };
export type AnimaticAudio = { voPath: string; musicPath?: string; sfxPaths?: string[] };
export type AnimaticInput = {
  stills: AnimaticStill[];
  audio: AnimaticAudio;
  outPath: string;
};
export type AnimaticResult = { mp4Path: string; durationSec: number };

export type FfmpegRunner = (
  cmd: string,
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

let runner: FfmpegRunner = defaultRunner;

export function setFfmpegRunner(fn: FfmpegRunner | null): void {
  runner = fn ?? defaultRunner;
}

function defaultRunner(cmd: string, args: string[]) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
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

export function buildAnimaticFfmpegArgs(input: AnimaticInput): string[] {
  if (input.stills.length === 0) {
    throw new Error("buildAnimaticFfmpegArgs: stills must not be empty");
  }
  const sfxPaths = input.audio.sfxPaths ?? [];
  if (sfxPaths.length > input.stills.length) {
    throw new Error("buildAnimaticFfmpegArgs: more sfx than stills");
  }

  const args: string[] = ["-y"];

  for (const still of input.stills) {
    args.push("-loop", "1", "-t", still.durationSec.toFixed(3), "-i", still.path);
  }
  const voIndex = input.stills.length;
  args.push("-i", input.audio.voPath);

  let musicIndex = -1;
  if (input.audio.musicPath) {
    musicIndex = voIndex + 1;
    args.push("-i", input.audio.musicPath);
  }

  const sfxStartIndex = musicIndex >= 0 ? musicIndex + 1 : voIndex + 1;
  for (const sfx of sfxPaths) {
    args.push("-i", sfx);
  }

  const totalDuration = input.stills.reduce((s, x) => s + x.durationSec, 0);

  const filterParts: string[] = [];
  for (let i = 0; i < input.stills.length; i++) {
    filterParts.push(
      `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[v${i}]`,
    );
  }
  const concatInputs = input.stills.map((_, i) => `[v${i}]`).join("");
  filterParts.push(`${concatInputs}concat=n=${input.stills.length}:v=1:a=0[vout]`);

  const audioLabels: string[] = [`[${voIndex}:a]`];
  if (musicIndex >= 0) {
    filterParts.push(`[${musicIndex}:a]volume=${MUSIC_VOLUME}[amusic]`);
    audioLabels.push("[amusic]");
  }

  let offset = 0;
  for (let i = 0; i < sfxPaths.length; i++) {
    const inIdx = sfxStartIndex + i;
    const delayMs = Math.round(offset * 1000);
    filterParts.push(`[${inIdx}:a]adelay=${delayMs}|${delayMs}[asfx${i}]`);
    audioLabels.push(`[asfx${i}]`);
    offset += input.stills[i]?.durationSec ?? 0;
  }

  const aoutLabel = "[aout]";
  filterParts.push(
    `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=first:dropout_transition=0,atrim=0:${totalDuration.toFixed(3)},asetpts=N/SR/TB${aoutLabel}`,
  );

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[vout]",
    "-map",
    aoutLabel,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    "-t",
    totalDuration.toFixed(3),
    input.outPath,
  );

  return args;
}

export function animaticDurationSec(stills: AnimaticStill[]): number {
  return stills.reduce((s, x) => s + x.durationSec, 0);
}

export async function composeAnimatic(input: AnimaticInput): Promise<AnimaticResult> {
  await mkdir(dirname(input.outPath), { recursive: true });
  const args = buildAnimaticFfmpegArgs(input);
  const r = await runner("ffmpeg", args);
  if (r.exitCode !== 0) {
    throw new Error(`ffmpeg animatic failed: ${r.stderr.slice(-1500)}`);
  }
  return { mp4Path: input.outPath, durationSec: animaticDurationSec(input.stills) };
}
