import { spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { anth } from "./claude-judge";

export type AnimaticVerdict = {
  overall: number;
  dims: { name: string; score: number; note: string }[];
};

const DIMS = [
  "pacing",
  "Spike",
  "Star-arc",
  "end-frame brand fluency",
  "A/V synergy",
  "CTA clarity",
  "STSL-analog",
  "novelty balance",
] as const;

const DimSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(1),
  note: z.string(),
});

const VerdictSchema = z.object({
  dims: z.array(DimSchema).length(DIMS.length),
});

type FrameExtractor = (mp4Path: string, count: number) => Promise<string[]>;
type VisionClient = (brief: string, framePaths: string[]) => Promise<string>;

let _frameExtractor: FrameExtractor | null = null;
let _visionClient: VisionClient | null = null;

export function setFrameExtractor(fn: FrameExtractor): void {
  _frameExtractor = fn;
}

export function setVisionClient(fn: VisionClient): void {
  _visionClient = fn;
}

async function defaultFrameExtractor(mp4Path: string, count: number): Promise<string[]> {
  const dir = join("/tmp", `animatic-frames-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const outPattern = join(dir, "frame%03d.jpg");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-i", mp4Path,
        "-vf", `select='not(mod(n\\,floor(t*25/${count})))',setpts=N/FRAME_RATE/TB`,
        "-frames:v", String(count),
        "-q:v", "3",
        outPattern,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg frame extract failed: ${stderr.slice(-800)}`));
      else resolve();
    });
  });
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith(".jpg")).sort().map((f) => join(dir, f));
}

async function defaultVisionClient(brief: string, framePaths: string[]): Promise<string> {
  const images = await Promise.all(framePaths.map((p) => readFile(p)));
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }
  > = [
    {
      type: "text",
      text: [
        "You are a senior creative director evaluating an animatic for the following brief:",
        `BRIEF: ${brief}`,
        "",
        `You are shown ${framePaths.length} evenly-spaced frames from the animatic.`,
        "Score each dimension 0.0–1.0 and write one short sentence of justification.",
        "",
        "Dimensions to score:",
        ...DIMS.map((d, i) => `  ${i + 1}. ${d}`),
        "",
        "Respond ONLY with valid JSON in this exact shape, no markdown fences:",
        '{"dims":[{"name":"<dim>","score":<0..1>,"note":"<one sentence>"},…]}',
        "All 8 dims must appear in order.",
      ].join("\n"),
    },
  ];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") },
    });
  }
  const msg = await anth().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content }],
  });
  const block = msg.content[0];
  if (!block || block.type !== "text") throw new Error("vision: no text block");
  return block.text;
}

export async function extractStrideFrames(mp4Path: string, count: number): Promise<string[]> {
  const fn = _frameExtractor ?? defaultFrameExtractor;
  return fn(mp4Path, count);
}

export async function critiqueAnimatic(input: {
  brief: string;
  mp4Path: string;
  count?: number;
}): Promise<AnimaticVerdict> {
  const count = input.count ?? 8;
  const framePaths = await extractStrideFrames(input.mp4Path, count);
  if (framePaths.length === 0) throw new Error("critiqueAnimatic: no frames extracted");

  const fn = _visionClient ?? defaultVisionClient;
  const raw = await fn(input.brief, framePaths);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error(`critiqueAnimatic: model returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`critiqueAnimatic: schema violation: ${result.error.message}`);
  }

  const dims = result.data.dims;
  const overall = dims.reduce((sum, d) => sum + d.score, 0) / dims.length;
  return { overall, dims };
}
