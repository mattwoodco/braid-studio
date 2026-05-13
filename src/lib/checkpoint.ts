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

export type BriefCheckpoint = {
  briefId: string;
  storeId: string;
  startedAt: string;
  updatedAt: string;
  phaseA: PhaseAState;
  phaseB: PhaseBState;
  phaseC: PhaseCState;
};

export function checkpointPath(runDir: string, briefId: string): string {
  return resolvePath(runDir, briefId, "checkpoint.json");
}

export async function loadCheckpoint(
  runDir: string,
  briefId: string,
): Promise<BriefCheckpoint | null> {
  try {
    const txt = await readFile(checkpointPath(runDir, briefId), "utf8");
    return JSON.parse(txt) as BriefCheckpoint;
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
  };
}
