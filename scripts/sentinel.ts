/**
 * Sentinel watchdog — runs in parallel to the pipeline, watches the log,
 * detects stalls and error patterns, and writes diagnostic reports.
 *
 * Optionally spawns a Managed Agent session to analyse a fault when one
 * occurs (so the sentinel itself uses the same infrastructure as the rest
 * of the system — Anthropic agents critiquing the agent run).
 *
 * Usage:
 *   bun scripts/sentinel.ts <logPath> [--stall=180] [--diag-agent] [--pid=N]
 *
 *   <logPath>    : file the pipeline writes to (typically /tmp/full-pipeline.log)
 *   --stall=N    : seconds of silence before declaring a stall (default 180)
 *   --diag-agent : when a fault is detected, spawn a Managed Agent that reads
 *                  the log tail and writes a JSON diagnosis
 *   --pid=N      : if set, sentinel can deliver SIGTERM to this PID if stall
 *                  exceeds 2× the threshold (off by default for safety)
 */
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { createSession, sendEvent, streamSession } from "@/lib/anthropic";
import { getEnv } from "@/lib/env";

type Args = {
  logPath: string;
  stallSeconds: number;
  diagAgent: boolean;
  pid: number | null;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error("usage: bun scripts/sentinel.ts <logPath> [--stall=180] [--diag-agent] [--pid=N]");
    process.exit(1);
  }
  let logPath = "";
  let stallSeconds = 180;
  let diagAgent = false;
  let pid: number | null = null;
  for (const a of argv) {
    if (a.startsWith("--stall=")) stallSeconds = Number(a.slice("--stall=".length));
    else if (a === "--diag-agent") diagAgent = true;
    else if (a.startsWith("--pid=")) pid = Number(a.slice("--pid=".length));
    else logPath = a;
  }
  if (!logPath) {
    console.error("sentinel: missing logPath");
    process.exit(1);
  }
  return { logPath: resolvePath(logPath), stallSeconds, diagAgent, pid };
}

const OUT_DIR = resolvePath(process.cwd(), "data/sentinel");

const log = (...a: unknown[]): void => console.log("[sentinel]", ...a);

async function tailFile(path: string, bytes: number): Promise<string> {
  try {
    const buf = await readFile(path, "utf8");
    return buf.slice(-bytes);
  } catch {
    return "";
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return 0;
  }
}

const ERROR_PATTERNS = [
  /ECONNRESET/i,
  /socket connection was closed/i,
  /TimeoutError/i,
  /\[panel\] timeout/i,
  /\bfailed:/i,
  /UnhandledRejection/i,
  /Error: /,
];

function detectErrors(tail: string): string[] {
  const hits: string[] = [];
  for (const re of ERROR_PATTERNS) {
    const m = re.exec(tail);
    if (m) hits.push(m[0]);
  }
  return [...new Set(hits)];
}

async function diagnoseWithAgent(input: {
  tail: string;
  faultKind: "stall" | "error";
  durationSeconds: number;
}): Promise<{ sessionId: string; diagnosisPath: string }> {
  const env = getEnv();
  log(`spawning diagnostic agent (faultKind=${input.faultKind})`);

  // Use a transient store just for diagnostic artifacts.
  const { createMemoryStore } = await import("@/lib/anthropic");
  const store = await createMemoryStore({
    name: `sentinel-diag-${Date.now()}`,
    description: "Sentinel diagnostic store",
  });

  const { sessionId } = await createSession({
    agentId: env.AGENT_ID,
    environmentId: env.ENV_ID,
    vaultIds: [env.VAULT_ID],
    title: `Sentinel diagnosis ${input.faultKind}`,
    resources: [
      {
        type: "memory_store",
        memory_store_id: store.id,
        access: "read_write",
        instructions: [
          "STEP 0: `ls /mnt/memory/` to find STORE_DIR.",
          "Read the LOG TAIL in the user message and write a JSON diagnosis to:",
          "  /mnt/memory/$STORE_DIR/memory/diagnosis.json",
          "",
          "Shape: {",
          '  "fault_kind": "stall" | "error",',
          '  "root_cause": "1-sentence cause",',
          '  "affected_sessions": ["..." ],',
          '  "recommended_action": "restart" | "abort" | "wait",',
          '  "evidence": ["lines from the log that justify the diagnosis"]',
          "}",
          "When written, emit `DONE` and end turn.",
        ].join("\n"),
      },
    ],
  });

  const rubric = [
    "You are the SENTINEL diagnostic agent for a video pipeline.",
    "A fault was detected. Read the log tail and produce a structured diagnosis.",
    "Be specific: which seats failed, which phase, what error pattern.",
    "Do not run any code. Just analyse the log and write the JSON diagnosis file as instructed.",
  ].join("\n");

  await sendEvent(sessionId, {
    type: "user.define_outcome",
    rubric,
    maxIterations: 1,
  });
  await sendEvent(sessionId, {
    type: "user.message",
    content: [
      `FAULT KIND: ${input.faultKind}`,
      `DURATION: ${input.durationSeconds}s of inactivity / since fault.`,
      "",
      "LOG TAIL (most recent ~3 KB):",
      "```",
      input.tail,
      "```",
    ].join("\n"),
  });

  // Stream to completion.
  try {
    for await (const ev of streamSession(sessionId)) {
      if (ev.type === "session.status_idle" && ev.stopReason === "end_turn") break;
    }
  } catch (err) {
    log(`diagnostic agent stream error: ${err instanceof Error ? err.message : err}`);
  }

  // Pull diagnosis file
  const { listMemories } = await import("@/lib/anthropic");
  const mems = await listMemories(store.id, { prefix: "/memory/" });
  const diag = mems.find((m) => m.path === "/memory/diagnosis.json");
  await mkdir(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = resolvePath(OUT_DIR, `diagnosis-${ts}.json`);
  await writeFile(outPath, diag?.content ?? `{"note":"diagnosis agent did not write a file","sessionId":"${sessionId}"}`);
  return { sessionId, diagnosisPath: outPath };
}

async function writeFaultReport(input: {
  faultKind: "stall" | "error";
  args: Args;
  tail: string;
  errors: string[];
  durationSeconds: number;
}): Promise<string> {
  await mkdir(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolvePath(OUT_DIR, `fault-${input.faultKind}-${ts}.md`);
  const lines: string[] = [];
  lines.push(`# Sentinel fault report — ${input.faultKind}`);
  lines.push(`Time: ${new Date().toISOString()}`);
  lines.push(`Log: ${input.args.logPath}`);
  lines.push(`Duration since last activity: ${input.durationSeconds}s`);
  if (input.errors.length) {
    lines.push("");
    lines.push("## Error patterns detected");
    for (const e of input.errors) lines.push(`- ${e}`);
  }
  lines.push("");
  lines.push("## Log tail (last 3 KB)");
  lines.push("```");
  lines.push(input.tail);
  lines.push("```");
  await writeFile(path, lines.join("\n"));
  return path;
}

async function main(): Promise<void> {
  const args = parseArgs();
  log(`watching ${args.logPath} (stall threshold ${args.stallSeconds}s, diag-agent=${args.diagAgent})`);

  let lastSize = 0;
  let lastActivity = Date.now();
  let lastErrorReported = "";
  let stallReported = false;
  let stallStart = 0;

  while (true) {
    await new Promise((r) => setTimeout(r, 20_000));
    const curSize = await fileSize(args.logPath);
    if (curSize > lastSize) {
      lastSize = curSize;
      lastActivity = Date.now();
      if (stallReported) {
        log(`recovered — log progressed after stall`);
        stallReported = false;
      }
    }

    const tail = await tailFile(args.logPath, 4000);

    // Error detection — only act on new errors (track signature).
    const errs = detectErrors(tail);
    if (errs.length > 0) {
      const sig = errs.join("|") + "::" + tail.slice(-200);
      if (sig !== lastErrorReported) {
        lastErrorReported = sig;
        const report = await writeFaultReport({
          faultKind: "error",
          args,
          tail,
          errors: errs,
          durationSeconds: 0,
        });
        log(`error pattern detected: ${errs.join(", ")} → ${report}`);
        if (args.diagAgent) {
          try {
            const { diagnosisPath } = await diagnoseWithAgent({
              tail,
              faultKind: "error",
              durationSeconds: 0,
            });
            log(`diagnosis written: ${diagnosisPath}`);
          } catch (err) {
            log(`diagnostic agent failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    // Stall detection
    const idleSec = (Date.now() - lastActivity) / 1000;
    if (idleSec > args.stallSeconds && !stallReported) {
      stallReported = true;
      stallStart = lastActivity;
      const report = await writeFaultReport({
        faultKind: "stall",
        args,
        tail,
        errors: errs,
        durationSeconds: Math.round(idleSec),
      });
      log(`STALL: ${idleSec.toFixed(0)}s without log progress → ${report}`);
      if (args.diagAgent) {
        try {
          const { diagnosisPath } = await diagnoseWithAgent({
            tail,
            faultKind: "stall",
            durationSeconds: Math.round(idleSec),
          });
          log(`diagnosis written: ${diagnosisPath}`);
        } catch (err) {
          log(`diagnostic agent failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Optional: hard kill after 2× threshold without recovery
    if (
      stallReported &&
      args.pid !== null &&
      (Date.now() - stallStart) / 1000 > args.stallSeconds * 2
    ) {
      log(`STALL exceeded 2× threshold — sending SIGTERM to pid ${args.pid}`);
      try {
        process.kill(args.pid, "SIGTERM");
      } catch (err) {
        log(`kill failed: ${err instanceof Error ? err.message : err}`);
      }
      // give up watching after kill
      return;
    }
  }
}

main().catch((err) => {
  console.error("[sentinel] crashed:", err);
  process.exit(1);
});
