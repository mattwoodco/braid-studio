/**
 * Pattern miner — reads all critic envelopes for a memory store (or a set),
 * groups by aspect × score-band, and surfaces:
 *   - which aspects discriminate (high variance between candidates)
 *   - which suggestions recur in high-scoring vs low-scoring shots
 *   - cross-brief correlations (when run over multiple stores)
 *
 * Output: a markdown report + a JSON dump suitable for feeding back into
 * future rubric refinement.
 */
import { listMemories } from "./anthropic";

export type SeatEnvelope = {
  aspect: string;
  parent_draft: string;
  candidate_scores: Array<{
    n: number;
    score: number;
    issues: string[];
    suggestion: string;
  }>;
  overall: number;
};

const PATH_RE = /^\/memory\/critiques\/([^/]+)\/([^/]+)\/([^/]+)-seat(\d+)\.json$/;

export type PatternReport = {
  storeIds: string[];
  totalSeatEnvelopes: number;
  byAspect: Map<
    string,
    {
      seatCount: number;
      mean: number;
      median: number;
      variance: number;
      /** Score distribution; useful for "is this aspect even discriminating?" */
      histogram: Record<string, number>;
      /** Common issues + suggestions per score band */
      lowBandIssues: Array<{ issue: string; count: number }>;
      highBandSuggestions: Array<{ suggestion: string; count: number }>;
    }
  >;
};

function variance(xs: number[], mean: number): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / xs.length;
}

function topN<T extends { count: number }>(items: T[], n: number): T[] {
  return [...items].sort((a, b) => b.count - a.count).slice(0, n);
}

function bucket(score: number): string {
  if (score < 0.4) return "0.0-0.4";
  if (score < 0.55) return "0.4-0.55";
  if (score < 0.7) return "0.55-0.7";
  if (score < 0.85) return "0.7-0.85";
  return "0.85-1.0";
}

export async function loadAllSeatEnvelopesForStore(storeId: string): Promise<
  Array<{ phase: string; version: string; envelope: SeatEnvelope }>
> {
  const mems = await listMemories(storeId, { prefix: "/memory/critiques/" });
  const out: Array<{ phase: string; version: string; envelope: SeatEnvelope }> = [];
  for (const m of mems) {
    const match = PATH_RE.exec(m.path);
    if (!match) continue;
    const [, phase, version, aspect] = match;
    try {
      const raw = JSON.parse(m.content);
      if (!raw) continue;
      const cs =
        raw.candidate_scores ?? raw.shot_scores ?? raw.scene_scores ?? raw.variant_scores;
      if (!Array.isArray(cs)) continue;
      out.push({
        phase: phase ?? "unknown",
        version: version ?? "v0",
        envelope: {
          aspect: aspect ?? raw.aspect,
          parent_draft: raw.parent_draft ?? version ?? "",
          candidate_scores: cs
            .map((c: unknown) => {
              if (typeof c !== "object" || c === null) return null;
              const r = c as Record<string, unknown>;
              const n = typeof r.n === "number" ? r.n : Number(r.n);
              const score = typeof r.score === "number" ? r.score : Number(r.score);
              if (!Number.isFinite(n) || !Number.isFinite(score)) return null;
              return {
                n,
                score,
                issues: Array.isArray(r.issues)
                  ? r.issues.filter((x: unknown): x is string => typeof x === "string")
                  : [],
                suggestion: typeof r.suggestion === "string" ? r.suggestion : "",
              };
            })
            .filter((x: SeatEnvelope["candidate_scores"][number] | null): x is SeatEnvelope["candidate_scores"][number] => x !== null),
          overall: typeof raw.overall === "number" ? raw.overall : 0,
        },
      });
    } catch {}
  }
  return out;
}

export async function minePatterns(storeIds: string[]): Promise<PatternReport> {
  const all: Array<{ storeId: string; phase: string; version: string; envelope: SeatEnvelope }> = [];
  for (const sid of storeIds) {
    const list = await loadAllSeatEnvelopesForStore(sid);
    for (const e of list) all.push({ storeId: sid, ...e });
  }

  const byAspect = new Map<
    string,
    {
      seatCount: number;
      scores: number[];
      issuesByBand: Map<string, Map<string, number>>;
      suggestionsByBand: Map<string, Map<string, number>>;
    }
  >();

  for (const { envelope } of all) {
    const a = envelope.aspect;
    if (!a) continue;
    const bucketState = byAspect.get(a) ?? {
      seatCount: 0,
      scores: [],
      issuesByBand: new Map<string, Map<string, number>>(),
      suggestionsByBand: new Map<string, Map<string, number>>(),
    };
    bucketState.seatCount += 1;
    for (const cs of envelope.candidate_scores) {
      bucketState.scores.push(cs.score);
      const band = bucket(cs.score);
      const issBag = bucketState.issuesByBand.get(band) ?? new Map<string, number>();
      for (const i of cs.issues) issBag.set(i, (issBag.get(i) ?? 0) + 1);
      bucketState.issuesByBand.set(band, issBag);
      const sugBag = bucketState.suggestionsByBand.get(band) ?? new Map<string, number>();
      if (cs.suggestion) {
        sugBag.set(cs.suggestion, (sugBag.get(cs.suggestion) ?? 0) + 1);
      }
      bucketState.suggestionsByBand.set(band, sugBag);
    }
    byAspect.set(a, bucketState);
  }

  const reportByAspect = new Map<string, PatternReport["byAspect"] extends Map<string, infer V> ? V : never>();
  for (const [aspect, state] of byAspect) {
    const xs = state.scores;
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const sorted = [...xs].sort((a, b) => a - b);
    const median = xs.length
      ? xs.length % 2
        ? sorted[Math.floor(xs.length / 2)] ?? 0
        : ((sorted[xs.length / 2 - 1] ?? 0) + (sorted[xs.length / 2] ?? 0)) / 2
      : 0;
    const histogram: Record<string, number> = {};
    for (const x of xs) {
      const b = bucket(x);
      histogram[b] = (histogram[b] ?? 0) + 1;
    }
    const lowIssues = [...(state.issuesByBand.get("0.0-0.4")?.entries() ?? []),
      ...(state.issuesByBand.get("0.4-0.55")?.entries() ?? [])]
      .map(([issue, count]) => ({ issue, count }));
    const highSugg = [...(state.suggestionsByBand.get("0.7-0.85")?.entries() ?? []),
      ...(state.suggestionsByBand.get("0.85-1.0")?.entries() ?? [])]
      .map(([suggestion, count]) => ({ suggestion, count }));

    reportByAspect.set(aspect, {
      seatCount: state.seatCount,
      mean,
      median,
      variance: variance(xs, mean),
      histogram,
      lowBandIssues: topN(lowIssues, 10),
      highBandSuggestions: topN(highSugg, 10),
    });
  }

  return {
    storeIds,
    totalSeatEnvelopes: all.length,
    byAspect: reportByAspect,
  };
}

export function reportToMarkdown(r: PatternReport): string {
  const rows: string[] = [];
  rows.push("# Pattern miner — critic envelope analysis");
  rows.push("");
  rows.push(`Stores analysed: ${r.storeIds.length}`);
  rows.push(`Seat envelopes: ${r.totalSeatEnvelopes}`);
  rows.push("");
  rows.push("## Per-aspect statistics (discrimination = high variance)");
  rows.push("");
  rows.push("| Aspect | Seats | Mean | Median | Variance (discrimination) | Distribution |");
  rows.push("|---|---|---|---|---|---|");
  const aspectsSorted = [...r.byAspect.entries()].sort(
    (a, b) => b[1].variance - a[1].variance,
  );
  for (const [aspect, s] of aspectsSorted) {
    const dist = Object.entries(s.histogram)
      .map(([b, c]) => `${b}:${c}`)
      .join(" ");
    rows.push(
      `| ${aspect} | ${s.seatCount} | ${s.mean.toFixed(2)} | ${s.median.toFixed(2)} | ${s.variance.toFixed(3)} | ${dist} |`,
    );
  }
  rows.push("");
  rows.push("## Recurring low-band issues (what consistently fails)");
  rows.push("");
  for (const [aspect, s] of aspectsSorted) {
    if (!s.lowBandIssues.length) continue;
    rows.push(`### ${aspect}`);
    for (const { issue, count } of s.lowBandIssues) {
      rows.push(`- (${count}×) ${issue}`);
    }
    rows.push("");
  }
  rows.push("## Recurring high-band suggestions (what worked when scores were high)");
  rows.push("");
  for (const [aspect, s] of aspectsSorted) {
    if (!s.highBandSuggestions.length) continue;
    rows.push(`### ${aspect}`);
    for (const { suggestion, count } of s.highBandSuggestions) {
      rows.push(`- (${count}×) ${suggestion}`);
    }
    rows.push("");
  }
  return rows.join("\n");
}
