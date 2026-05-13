/**
 * On-disk checkpoint store for pipeline resumption.
 *
 * Each brief has one JSON file at <runDir>/<briefId>/checkpoint.json.
 * Phases write progressive state after each completion so a crash can resume
 * without redoing finished work.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

export type PhaseAState = {
  status: "pending" | "in_progress" | "done";
  winner?: {
    n: number;
    title: string;
    hook: string;
    scenes: { description: string; duration_seconds: number }[];
    voiceover_or_dialogue: string;
    ending_beat: string;
  };
  history?: Array<{ version: string; winnerN: number; winnerScore: number; perCand: Record<number, number> }>;
};

export type PhaseBState = {
  status: "pending" | "in_progress" | "done";
  shots?: Array<{
    n: number;
    prompt: string;
    imageUrl: string | null;
    localPath: string | null;
  }>;
  history?: Array<{ version: string; overall: number; locked: number[]; perCand: Record<number, number> }>;
};

export type PhaseCState = {
  status: "pending" | "in_progress" | "done" | "skipped";
  videoUrls?: string[];
  prompts?: string[];
  mp4Path?: string;
  fileBytes?: number;
  durationSeconds?: number;
};

export type Gate = "G1" | "G2" | "G3" | "G4" | "G5" | "G6";
export type GateState = "pending" | "passed" | "halted";

export type BriefCheckpoint = {
  briefId: string;
  storeId: string;
  startedAt: string;
  updatedAt: string;
  phaseA: PhaseAState;
  phaseB: PhaseBState;
  phaseC: PhaseCState;
  cumulativeSpendUsd: number;
  gateState: Record<Gate, GateState>;
};

export function checkpointPath(runDir: string, briefId: string): string {
  return resolvePath(runDir, briefId, "checkpoint.json");
}

function defaultGateState(): Record<Gate, GateState> {
  return {
    G1: "pending",
    G2: "pending",
    G3: "pending",
    G4: "pending",
    G5: "pending",
    G6: "pending",
  };
}

type RawCheckpoint = Omit<Partial<BriefCheckpoint>, "gateState"> & {
  briefId: string;
  storeId: string;
  startedAt: string;
  updatedAt: string;
  phaseA: PhaseAState;
  phaseB: PhaseBState;
  phaseC: PhaseCState;
  gateState?: Partial<Record<Gate, GateState>>;
};

function normalizeCheckpoint(raw: RawCheckpoint): BriefCheckpoint {
  const gates = defaultGateState();
  if (raw.gateState) {
    for (const k of Object.keys(gates) as Gate[]) {
      const v = raw.gateState[k];
      if (v === "pending" || v === "passed" || v === "halted") {
        gates[k] = v;
      }
    }
  }
  return {
    briefId: raw.briefId,
    storeId: raw.storeId,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    phaseA: raw.phaseA,
    phaseB: raw.phaseB,
    phaseC: raw.phaseC,
    cumulativeSpendUsd:
      typeof raw.cumulativeSpendUsd === "number" ? raw.cumulativeSpendUsd : 0,
    gateState: gates,
  };
}

export async function loadCheckpoint(
  runDir: string,
  briefId: string,
): Promise<BriefCheckpoint | null> {
  try {
    const txt = await readFile(checkpointPath(runDir, briefId), "utf8");
    const parsed = JSON.parse(txt) as RawCheckpoint;
    return normalizeCheckpoint(parsed);
  } catch {
    return null;
  }
}

export async function saveCheckpoint(
  runDir: string,
  cp: BriefCheckpoint,
): Promise<void> {
  await mkdir(resolvePath(runDir, cp.briefId), { recursive: true });
  cp.updatedAt = new Date().toISOString();
  await writeFile(
    checkpointPath(runDir, cp.briefId),
    JSON.stringify(cp, null, 2),
  );
}

export function freshCheckpoint(briefId: string, storeId: string): BriefCheckpoint {
  const now = new Date().toISOString();
  return {
    briefId,
    storeId,
    startedAt: now,
    updatedAt: now,
    phaseA: { status: "pending" },
    phaseB: { status: "pending" },
    phaseC: { status: "pending" },
    cumulativeSpendUsd: 0,
    gateState: defaultGateState(),
  };
}

export function setGateState(
  cp: BriefCheckpoint,
  gate: Gate,
  state: GateState,
): BriefCheckpoint {
  return {
    ...cp,
    gateState: { ...cp.gateState, [gate]: state },
    updatedAt: new Date().toISOString(),
  };
}

export function addSpend(cp: BriefCheckpoint, usd: number): BriefCheckpoint {
  return {
    ...cp,
    cumulativeSpendUsd: cp.cumulativeSpendUsd + usd,
    updatedAt: new Date().toISOString(),
  };
}
