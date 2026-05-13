/**
 * Reusable Managed-Agent critic panel: spawn N seats per aspect, stream until
 * idle, parse JSON envelopes from the memory store, median-consensus per
 * aspect, optional carry-forward floor against priors.
 *
 * Used by all three pipeline phases (script, storyboard, video). The only
 * thing that differs per phase is the rubric text + the aspect set.
 */
import {
  createSession,
  listMemories,
  sendEvent,
  type SessionResource,
  streamSession,
} from "./anthropic";
import { getEnv } from "./env";

export type AspectScores = {
  /** index — either shot/scene/variant depending on phase */
  n: number;
  score: number;
  issues: string[];
  suggestion: string;
};

export type ConsensusEnvelope<TAspect extends string = string> = {
  version: string;
  parent_draft: string;
  aspect: TAspect;
  /** scores per indexed candidate (shot, scene, or script variant). */
  candidate_scores: AspectScores[];
  overall: number;
  summary: string;
  created_at: string;
};

export type PanelConfig<TAspect extends string> = {
  storeId: string;
  draftVersion: string;
  aspects: readonly TAspect[];
  seatsPerAspect: number;
  /** subdir under /memory/critiques/ — defaults to phase/<draftVersion>/ */
  pathPrefix: string;
  /** rubric body: must instruct the agent to write to {pathPrefix}/{aspect}-seat{N}.json. */
  buildRubric(aspect: TAspect, seat: number): string;
  /** the user message after define_outcome (typically the artifact + brief). */
  buildMessage(aspect: TAspect, seat: number): string;
  /** optional console tag per seat. */
  tag?: string;
  /** stream timeout per seat in ms — default 8 min. */
  timeoutMs?: number;
};

const log = (...a: unknown[]): void => console.log("[panel]", ...a);
const stamp = (): string => new Date().toISOString().slice(11, 19);

async function streamUntilIdle(
  sessionId: string,
  timeoutMs: number,
  tag: string,
): Promise<void> {
  const start = Date.now();
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      for await (const ev of streamSession(sessionId)) {
        if (ev.type === "session.status_idle" && ev.stopReason === "end_turn") {
          log(stamp(), `idle [${tag}]`);
          return;
        }
        if (ev.type === "agent.tool_use") {
          const inp = JSON.stringify(ev.input).slice(0, 80);
          log(stamp(), `tool [${tag}]: ${ev.toolName} ${inp}`);
        }
        if (Date.now() - start > timeoutMs) {
          log(`timeout [${tag}]`);
          return;
        }
      }
      // Stream ended without idle event — treat as done.
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        /ECONNRESET|socket|fetch|network|timeout|stream/i.test(msg) ?? false;
      if (attempt < MAX_RETRIES && transient) {
        const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        log(
          stamp(),
          `[${tag}] stream error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${msg.slice(0, 120)} — retrying in ${backoff}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
        if (Date.now() - start > timeoutMs) {
          log(`[${tag}] timeout exceeded during retry, giving up`);
          return;
        }
        continue;
      }
      log(stamp(), `[${tag}] stream FAILED after ${attempt + 1} attempt(s): ${msg.slice(0, 200)}`);
      return; // don't kill the whole run; this seat is missing
    }
  }
}

export async function runPanel<TAspect extends string>(
  cfg: PanelConfig<TAspect>,
): Promise<Map<TAspect, ConsensusEnvelope<TAspect>>> {
  const env = getEnv();
  const resources: SessionResource[] = [
    {
      type: "memory_store",
      memory_store_id: cfg.storeId,
      access: "read_write",
      instructions: [
        "MEMORY STORE MOUNT.",
        "STEP 0: run `bash` `ls /mnt/memory/` to discover STORE_DIR.",
        `Write critique files to /mnt/memory/$STORE_DIR/memory/critiques/${cfg.pathPrefix}/<aspect>-seat<N>.json`,
      ].join("\n"),
    },
  ];

  const sessions: { aspect: TAspect; seat: number; sessionId: string }[] = [];
  for (const aspect of cfg.aspects) {
    for (let seat = 0; seat < cfg.seatsPerAspect; seat++) {
      const { sessionId } = await createSession({
        agentId: env.AGENT_ID,
        environmentId: env.ENV_ID,
        vaultIds: [env.VAULT_ID],
        title: `${cfg.tag ?? "panel"} ${cfg.draftVersion} — ${aspect} seat ${seat}`,
        resources,
      });
      sessions.push({ aspect, seat, sessionId });
      await sendEvent(sessionId, {
        type: "user.define_outcome",
        rubric: cfg.buildRubric(aspect, seat),
        maxIterations: 1,
      });
      await sendEvent(sessionId, {
        type: "user.message",
        content: cfg.buildMessage(aspect, seat),
      });
    }
  }

  log(
    stamp(),
    `${cfg.tag ?? "panel"} ${cfg.draftVersion}: spawned ${sessions.length} sessions (${cfg.aspects.length} aspects × ${cfg.seatsPerAspect} seats)`,
  );
  await Promise.all(
    sessions.map(({ aspect, seat, sessionId }) =>
      streamUntilIdle(
        sessionId,
        cfg.timeoutMs ?? 8 * 60 * 1000,
        `${cfg.tag ?? cfg.draftVersion}/${aspect}/s${seat}`,
      ),
    ),
  );

  return loadConsensus<TAspect>(cfg.storeId, cfg.pathPrefix, cfg.aspects);
}

const SEAT_RE = /\/([^/]+)-seat(\d+)\.json$/;

export async function loadConsensus<TAspect extends string>(
  storeId: string,
  pathPrefix: string,
  aspects: readonly TAspect[],
): Promise<Map<TAspect, ConsensusEnvelope<TAspect>>> {
  const mems = await listMemories(storeId, {
    prefix: `/memory/critiques/${pathPrefix}/`,
  });
  const bySeat = new Map<TAspect, Array<{ candidate_scores: AspectScores[] }>>();
  for (const m of mems) {
    const match = SEAT_RE.exec(m.path);
    if (!match) continue;
    const aspect = match[1] as TAspect;
    if (!aspects.includes(aspect)) continue;
    try {
      const raw = JSON.parse(m.content);
      if (!raw) continue;
      // Accept either {candidate_scores: [...]} or {shot_scores: [...]} or
      // {scene_scores} or {variant_scores} — normalise.
      const arr =
        raw.candidate_scores ?? raw.shot_scores ?? raw.scene_scores ?? raw.variant_scores;
      if (!Array.isArray(arr)) continue;
      const candidate_scores: AspectScores[] = arr
        .map((s: unknown) => {
          if (typeof s !== "object" || s === null) return null;
          const sc = s as Record<string, unknown>;
          const n = typeof sc.n === "number" ? sc.n : Number(sc.n);
          const score =
            typeof sc.score === "number" ? sc.score : Number(sc.score);
          if (!Number.isFinite(n) || !Number.isFinite(score)) return null;
          return {
            n,
            score: Math.max(0, Math.min(1, score)),
            issues: Array.isArray(sc.issues)
              ? sc.issues.filter((x: unknown): x is string => typeof x === "string")
              : [],
            suggestion: typeof sc.suggestion === "string" ? sc.suggestion : "",
          };
        })
        .filter((x: AspectScores | null): x is AspectScores => x !== null);
      if (!candidate_scores.length) continue;
      const list = bySeat.get(aspect) ?? [];
      list.push({ candidate_scores });
      bySeat.set(aspect, list);
    } catch {}
  }

  const out = new Map<TAspect, ConsensusEnvelope<TAspect>>();
  for (const aspect of aspects) {
    const seats = bySeat.get(aspect) ?? [];
    if (!seats.length) continue;
    const idxSet = new Set<number>();
    for (const s of seats) for (const c of s.candidate_scores) idxSet.add(c.n);
    const candidate_scores: AspectScores[] = [...idxSet]
      .sort((a, b) => a - b)
      .map((n) => {
        const scores: number[] = [];
        const issues: string[] = [];
        const suggestions: string[] = [];
        for (const s of seats) {
          const c = s.candidate_scores.find((x) => x.n === n);
          if (!c) continue;
          scores.push(c.score);
          for (const i of c.issues) issues.push(i);
          if (c.suggestion) suggestions.push(c.suggestion);
        }
        return {
          n,
          score: median(scores),
          issues: [...new Set(issues)].slice(0, 8),
          suggestion: suggestions.join(" / ").slice(0, 600),
        };
      });
    const overall =
      candidate_scores.length > 0
        ? candidate_scores.reduce((a, s) => a + s.score, 0) /
          candidate_scores.length
        : 0;
    out.set(aspect, {
      version: `c-${aspect}-consensus`,
      parent_draft: pathPrefix,
      aspect,
      candidate_scores,
      overall,
      summary: `median of ${seats.length} seats`,
      created_at: new Date().toISOString(),
    });
  }
  return out;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

export function perCandidateAvg<TAspect extends string>(
  consensus: Map<TAspect, ConsensusEnvelope<TAspect>>,
): Record<number, number> {
  const acc: Record<number, number[]> = {};
  for (const env of consensus.values()) {
    for (const c of env.candidate_scores) {
      acc[c.n] = acc[c.n] ?? [];
      acc[c.n]!.push(c.score);
    }
  }
  const out: Record<number, number> = {};
  for (const [n, arr] of Object.entries(acc)) {
    out[Number(n)] = arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  return out;
}

export function overallOf(perCand: Record<number, number>): number {
  const v = Object.values(perCand);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

export type PerAspectShot = Map<string, Record<number, number>>;

export function extractPerAspectShot<TAspect extends string>(
  consensus: Map<TAspect, ConsensusEnvelope<TAspect>>,
): PerAspectShot {
  const out: PerAspectShot = new Map();
  for (const [a, env] of consensus) {
    const m: Record<number, number> = {};
    for (const c of env.candidate_scores) m[c.n] = c.score;
    out.set(a as string, m);
  }
  return out;
}

/**
 * Convergence smoothing — require two consecutive versions at convergence
 * before declaring done. Reduces false positives from noisy panels.
 *
 * Pass the rolling history; returns true iff the last two entries both meet
 * (allLocked && overall >= threshold).
 */
export function convergedSmoothed(
  history: { allLocked: boolean; overall: number }[],
  overallThreshold = 0.8,
  consecutive = 2,
): boolean {
  if (history.length < consecutive) return false;
  const tail = history.slice(-consecutive);
  return tail.every((h) => h.allLocked && h.overall >= overallThreshold);
}

/**
 * Efficient exit: if locked == total AND no regen work remains, the loop
 * has nothing to do regardless of overall score. This catches the
 * "stuck at 0.77 but 5/5 locked" wasted-iteration case.
 */
export function noWorkRemaining(history: {
  locked: number[];
  totalShots: number;
}): boolean {
  return history.locked.length >= history.totalShots;
}

export function applyCarryForward<TAspect extends string>(
  current: Map<TAspect, ConsensusEnvelope<TAspect>>,
  priorPerAspect: PerAspectShot,
  priorLocked: Set<number>,
  delta = 0.05,
): Map<TAspect, ConsensusEnvelope<TAspect>> {
  const out = new Map<TAspect, ConsensusEnvelope<TAspect>>();
  for (const [a, env] of current) {
    const priors = priorPerAspect.get(a as string) ?? {};
    const candidate_scores = env.candidate_scores.map((c) => {
      if (!priorLocked.has(c.n)) return c;
      const prior = priors[c.n];
      if (prior === undefined) return c;
      const floor = prior - delta;
      return c.score >= floor ? c : { ...c, score: floor };
    });
    const overall =
      candidate_scores.length > 0
        ? candidate_scores.reduce((a, s) => a + s.score, 0) /
          candidate_scores.length
        : 0;
    out.set(a, { ...env, candidate_scores, overall });
  }
  return out;
}
