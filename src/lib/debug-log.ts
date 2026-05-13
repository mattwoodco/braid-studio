import { appendFile, mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

export type DebugRow = {
  ts: string;
  briefId: string;
  phase: string;
  kind: string;
  model?: string;
  durMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  retry?: number;
  extra?: Record<string, unknown>;
};

export async function debugLog(row: DebugRow, runDir: string): Promise<void> {
  const dir = resolvePath(runDir, row.briefId);
  await mkdir(dir, { recursive: true });
  const file = resolvePath(dir, "debug.jsonl");
  await appendFile(file, JSON.stringify(row) + "\n", "utf8");
}

export async function withTiming<T>(fn: () => Promise<T>): Promise<{ result: T; durMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durMs: Date.now() - start };
}
