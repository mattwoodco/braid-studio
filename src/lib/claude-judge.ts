/**
 * Shared Claude helpers that bake in the resilient patterns:
 *   - briefGroundedJudge(): vision pick against the BRIEF (not the prompt)
 *   - minimalRewrite(): rewriter with hard-coded "change ≤ 2 attributes" guard
 *   - medianVote(): N-sample median for any scalar Claude judgement
 *   - adaptiveBestOfN(): per-candidate N based on distance from threshold
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";

let _client: Anthropic | null = null;
export function anth(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY missing");
  _client = new Anthropic({ apiKey: key });
  return _client;
}

const JUDGE_MODEL = "claude-sonnet-4-5";

// ============================================================
// Brief-grounded vision judge
// ============================================================

export async function briefGroundedJudge(input: {
  brief: string;
  intent: string; // shot/scene intent
  thumbPaths: string[];
}): Promise<number> {
  const labels = "ABCDEFGH";
  const imgs = await Promise.all(input.thumbPaths.map((p) => readFile(p)));
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }
  > = [
    {
      type: "text",
      text: [
        "Pick the candidate that BEST serves THE BRIEF (not just visual prettiness):",
        `BRIEF: ${input.brief}`,
        `Scene intent: ${input.intent}`,
        `${input.thumbPaths.length} candidates labelled ${labels.slice(0, input.thumbPaths.length).split("").join(", ")}.`,
        "Judge on: brief alignment first, composition, motion intent, color logic, cinematic quality.",
        `Reply with exactly one character: ${labels.slice(0, input.thumbPaths.length).split("").join(" or ")}.`,
      ].join("\n"),
    },
  ];
  for (const img of imgs) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") },
    });
  }
  const msg = await anth().messages.create({
    model: JUDGE_MODEL,
    max_tokens: 50,
    messages: [{ role: "user", content }],
  });
  const t = msg.content[0]?.type === "text" ? msg.content[0].text.trim().toUpperCase() : "A";
  const idx = labels.indexOf(t[0] ?? "A");
  return idx >= 0 && idx < input.thumbPaths.length ? idx : 0;
}

// ============================================================
// Minimal rewrite — hard guarded by a constant prefix
// ============================================================

const MINIMAL_REWRITE_GUARD = [
  "MINIMAL TARGETED REWRITE — read carefully:",
  "  - PRESERVE: subject, scene, era, props, framing intent.",
  "  - CHANGE: at most 1-2 attributes (camera, lighting quality, color temp, composition, motion).",
  "  - Do NOT introduce new subjects, locations, or moods.",
  "  - Do NOT lengthen the prompt by more than 25%.",
  "  - Output ONLY the new prompt, one paragraph, no labels, no quotes.",
].join("\n");

export async function minimalRewrite(input: {
  brief: string;
  parentPrompt: string;
  unitIndex: number;
  unitLabel: "shot" | "scene" | "variant";
  issues: string[];
  suggestions: string[];
}): Promise<string> {
  const msg = await anth().messages.create({
    model: JUDGE_MODEL,
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `BRIEF (top-level north star): ${input.brief}`,
              "",
              `Original ${input.unitLabel} ${input.unitIndex} prompt:`,
              `  "${input.parentPrompt}"`,
              "",
              "Critics flagged these issues:",
              ...input.issues.slice(0, 12).map((i) => `  - ${i}`),
              "",
              "Critic suggestions:",
              ...input.suggestions.slice(0, 12).map((s) => `  - ${s}`),
              "",
              MINIMAL_REWRITE_GUARD,
            ].join("\n"),
          },
        ],
      },
    ],
  });
  const block = msg.content[0];
  if (!block || block.type !== "text") throw new Error("rewrite: no text");
  return block.text.trim().replace(/^["']|["']$/g, "");
}

// ============================================================
// Median-of-N for any scalar Claude judgement
// ============================================================

export async function medianVote<T extends number | string>(
  call: () => Promise<T>,
  nSamples: number,
  pickMedian: (samples: T[]) => T,
): Promise<{ winner: T; samples: T[] }> {
  const samples = await Promise.all(Array.from({ length: nSamples }, () => call()));
  return { winner: pickMedian(samples), samples };
}

export function numericMedian(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length === 0) return 0;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

export function stringMode(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = xs[0] ?? "";
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

// ============================================================
// Adaptive best-of-N for per-shot regeneration
// ============================================================

export function adaptiveN(opts: {
  shotScore: number;
  lockThreshold: number;
  /** Below this distance use min N. Above, scale to max. */
  maxDistance?: number;
  minN?: number;
  maxN?: number;
}): number {
  const minN = opts.minN ?? 2;
  const maxN = opts.maxN ?? 4;
  const dist = Math.max(0, opts.lockThreshold - opts.shotScore);
  const maxD = opts.maxDistance ?? 0.3; // 0.30 → maxN; closer → minN
  const ratio = Math.min(1, dist / maxD);
  return Math.round(minN + ratio * (maxN - minN));
}
