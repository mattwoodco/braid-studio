/**
 * Supervisor — runs the pipeline as a subprocess, restarts it on non-zero
 * exit up to N attempts. The pipeline is responsible for reading its
 * checkpoints at startup so the restart is idempotent.
 *
 * Usage:
 *   bun scripts/supervisor.ts <pipelineScript> [--max-restarts=3] [--cooldown=15]
 *
 * Args after --cooldown=N are forwarded to the pipeline script.
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: bun scripts/supervisor.ts <pipelineScript> [--max-restarts=3] [--cooldown=15] [-- args...]");
  process.exit(1);
}

let pipelineScript = "";
let maxRestarts = 3;
let cooldownSec = 15;
const passthrough: string[] = [];
let inPassthrough = false;
for (const a of argv) {
  if (inPassthrough) {
    passthrough.push(a);
    continue;
  }
  if (a === "--") {
    inPassthrough = true;
    continue;
  }
  if (a.startsWith("--max-restarts=")) maxRestarts = Number(a.slice("--max-restarts=".length));
  else if (a.startsWith("--cooldown=")) cooldownSec = Number(a.slice("--cooldown=".length));
  else if (!pipelineScript) pipelineScript = a;
  else passthrough.push(a);
}

const stamp = (): string => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a: unknown[]): void => console.log(`[supervisor ${stamp()}]`, ...a);

function runOnce(): Promise<{ code: number; signal: string | null }> {
  return new Promise((resolve) => {
    log(`spawning ${pipelineScript} ${passthrough.join(" ")}`);
    const child = spawn("bun", [pipelineScript, ...passthrough], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null });
    });
    child.on("error", (err) => {
      log(`spawn error: ${err.message}`);
      resolve({ code: 1, signal: null });
    });
  });
}

async function main(): Promise<void> {
  log(`max restarts: ${maxRestarts}, cooldown: ${cooldownSec}s`);
  for (let attempt = 0; attempt <= maxRestarts; attempt++) {
    const start = Date.now();
    const { code, signal } = await runOnce();
    const wall = ((Date.now() - start) / 1000).toFixed(0);
    if (code === 0) {
      log(`pipeline completed cleanly after ${attempt} restart(s) (wall ${wall}s)`);
      process.exit(0);
    }
    log(`pipeline exited ${code} signal=${signal} after ${wall}s (attempt ${attempt + 1}/${maxRestarts + 1})`);
    if (attempt >= maxRestarts) {
      log(`exhausted ${maxRestarts} restarts — giving up`);
      process.exit(1);
    }
    log(`cooling down ${cooldownSec}s before restart...`);
    await new Promise((r) => setTimeout(r, cooldownSec * 1000));
  }
}

main();
