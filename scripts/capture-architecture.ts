#!/usr/bin/env bun
/**
 * capture-architecture.ts
 *
 * Captures screenshots of the live memory-architecture visualization
 * (docs/architecture/index.html) into docs/architecture/screenshots/.
 *
 * The visualization is a static HTML page that polls `/api/memory/<storeId>/snapshot`
 * with a same-origin fetch. To make that fetch resolve to the running Next.js
 * dev server, we:
 *
 *   1. Navigate the browser to <baseUrl> (so document.origin === dev server).
 *   2. Use `history.replaceState` to put `?storeId=<id>` on the URL.
 *   3. Use `document.open()/write()/close()` to replace the body with the
 *      contents of docs/architecture/index.html. Because document.write does
 *      not navigate, the origin is preserved and the script's `fetch` calls
 *      hit the dev server.
 *
 * Default browser tool: agent-browser (per project conventions).
 *
 * Usage:
 *   bun run scripts/capture-architecture.ts <storeId>
 *     [--base-url http://localhost:3000]
 *     [--out docs/architecture/screenshots]
 */

import { mkdir, readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

interface CliArgs {
  storeId: string;
  baseUrl: string;
  outDir: string;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ScreenshotTarget {
  filename: string;
  selector: string | null;
  description: string;
}

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;
const POPULATE_TIMEOUT_MS = 10_000;
const POPULATE_POLL_INTERVAL_MS = 250;

function parseArgs(argv: readonly string[]): CliArgs {
  const positional: string[] = [];
  let baseUrl = "http://localhost:3000";
  let outDir = "docs/architecture/screenshots";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--base-url") {
      const next = argv[i + 1];
      if (!next) throw new Error("--base-url requires a value");
      baseUrl = next;
      i++;
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--out") {
      const next = argv[i + 1];
      if (!next) throw new Error("--out requires a value");
      outDir = next;
      i++;
    } else if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
    } else if (arg === "-h" || arg === "--help") {
      printHelpAndExit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const storeId = positional[0];
  if (!storeId) {
    printHelpAndExit(1);
  }

  return {
    storeId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    outDir,
  };
}

function printHelpAndExit(code: number): never {
  const msg =
    "Usage: bun run scripts/capture-architecture.ts <storeId> " +
    "[--base-url http://localhost:3000] [--out docs/architecture/screenshots]";
  if (code === 0) {
    process.stdout.write(`${msg}\n`);
  } else {
    process.stderr.write(`${msg}\n`);
  }
  process.exit(code);
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function spawnCapture(
  cmd: readonly string[],
  options?: { timeoutMs?: number },
): Promise<SpawnResult> {
  const proc = Bun.spawn({
    cmd: [...cmd],
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (options?.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // already dead
      }
    }, options.timeoutMs);
  }

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (timer) clearTimeout(timer);

  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout: stdoutText,
    stderr: stderrText,
  };
}

async function commandExists(bin: string): Promise<boolean> {
  const r = await spawnCapture(["which", bin], { timeoutMs: 5_000 });
  return r.exitCode === 0 && r.stdout.trim().length > 0;
}

async function playwrightAvailable(): Promise<boolean> {
  const r = await spawnCapture(["bunx", "playwright", "--version"], { timeoutMs: 5_000 });
  return r.exitCode === 0;
}

type Driver = "agent-browser" | "playwright";

async function pickDriver(): Promise<Driver> {
  if (await commandExists("agent-browser")) return "agent-browser";
  if (await playwrightAvailable()) return "playwright";
  throw new Error(
    "Neither `agent-browser` nor `playwright` is available. " +
      "Install agent-browser: `npm i -g agent-browser && agent-browser install`.",
  );
}

function buildBootstrapScript(htmlBody: string, storeId: string): string {
  // Replace the page's document with the visualization HTML, after setting
  // ?storeId=... on the URL. The origin (and thus same-origin fetches) is
  // preserved across document.open/write/close.
  const encoded = Buffer.from(htmlBody, "utf8").toString("base64");
  return `(() => {
    const url = new URL(location.href);
    url.searchParams.set("storeId", ${JSON.stringify(storeId)});
    history.replaceState(null, "", url.toString());
    const html = atob(${JSON.stringify(encoded)});
    const decoded = new TextDecoder("utf-8").decode(
      Uint8Array.from(html, (c) => c.charCodeAt(0)),
    );
    document.open();
    document.write(decoded);
    document.close();
    return { ok: true, length: decoded.length };
  })()`;
}

function buildWaitForPopulatedScript(timeoutMs: number, intervalMs: number): string {
  // Polls the manifest card for non-empty text content. Resolves with an
  // object describing how it finished so the caller can warn if it timed out.
  return `(async () => {
    const deadline = Date.now() + ${timeoutMs};
    const interval = ${intervalMs};
    const selectors = [
      '[data-id="manifest"]',
      '#card-manifest',
      '.col-left .card',
    ];
    function findManifest() {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    }
    while (Date.now() < deadline) {
      const el = findManifest();
      if (el) {
        const fields = el.querySelector('.fields');
        const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
        const hasFields = fields && fields.children.length > 0;
        if (hasFields && text.length > 0 && !/^pending$/i.test(text)) {
          return { populated: true, waitedMs: Date.now() - (deadline - ${timeoutMs}) };
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    return { populated: false, waitedMs: ${timeoutMs} };
  })()`;
}

interface AgentBrowserEvalResult {
  result?: unknown;
}

function parseEvalJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  // agent-browser --json prints a JSON object; try to parse the last JSON value.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some versions wrap output; try to find the last balanced JSON object.
    const lastBrace = trimmed.lastIndexOf("{");
    if (lastBrace >= 0) {
      try {
        return JSON.parse(trimmed.slice(lastBrace));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

async function runAgentBrowser(
  args: readonly string[],
  opts?: { timeoutMs?: number },
): Promise<SpawnResult> {
  return spawnCapture(["agent-browser", ...args], { timeoutMs: opts?.timeoutMs ?? 60_000 });
}

async function agentBrowserEval(script: string, timeoutMs?: number): Promise<unknown> {
  // Pass JS via base64 to avoid shell-escaping concerns.
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const r = await runAgentBrowser(["eval", "-b", b64, "--json"], { timeoutMs });
  if (r.exitCode !== 0) {
    throw new Error(
      `agent-browser eval failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  const parsed = parseEvalJson(r.stdout);
  if (parsed && typeof parsed === "object" && "result" in parsed) {
    return (parsed as AgentBrowserEvalResult).result;
  }
  return parsed;
}

interface DetectedSelectors {
  manifest: string;
  firstShot: string;
  final: string;
}

const SELECTOR_CANDIDATES: DetectedSelectors[] = [
  {
    manifest: '[data-card-id="manifest"]',
    firstShot: '[data-card-id^="shot-"]',
    final: '[data-card-id="final"]',
  },
  {
    manifest: '[data-id="manifest"]',
    firstShot: '[data-id^="shot-"]',
    final: '[data-id="final"]',
  },
  {
    manifest: "#card-manifest",
    firstShot: ".card.shot",
    final: "#card-final",
  },
  {
    manifest: ".col-left .card",
    firstShot: ".col-mid .card",
    final: ".col-right .card",
  },
];

async function detectSelectors(): Promise<DetectedSelectors> {
  const probe = `(() => {
    const candidates = ${JSON.stringify(SELECTOR_CANDIDATES)};
    for (const c of candidates) {
      const m = document.querySelector(c.manifest);
      const s = document.querySelector(c.firstShot);
      const f = document.querySelector(c.final);
      if (m && f) {
        return { ...c, firstShotFound: !!s };
      }
    }
    return null;
  })()`;
  const result = await agentBrowserEval(probe, 15_000);
  if (!result || typeof result !== "object") {
    throw new Error("Could not detect any of the known card selectors in the page.");
  }
  const r = result as Record<string, unknown>;
  const manifest = typeof r.manifest === "string" ? r.manifest : null;
  const firstShot = typeof r.firstShot === "string" ? r.firstShot : null;
  const final = typeof r.final === "string" ? r.final : null;
  if (!manifest || !firstShot || !final) {
    throw new Error(`Selector detection returned malformed result: ${JSON.stringify(result)}`);
  }
  return { manifest, firstShot, final };
}

async function takeScreenshotAgentBrowser(
  target: ScreenshotTarget,
  absPath: string,
): Promise<void> {
  const args = ["screenshot"];
  if (target.selector) {
    args.push(target.selector, absPath);
  } else {
    args.push("--full", absPath);
  }
  const r = await runAgentBrowser(args, { timeoutMs: 60_000 });
  if (r.exitCode !== 0) {
    throw new Error(
      `screenshot failed for ${target.description} (${target.selector ?? "full page"}): ` +
        `${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

async function runWithAgentBrowser(
  args: CliArgs,
  htmlBody: string,
  absOutDir: string,
): Promise<void> {
  // 1. viewport
  const vp = await runAgentBrowser(
    ["set", "viewport", String(VIEWPORT_WIDTH), String(VIEWPORT_HEIGHT)],
    { timeoutMs: 15_000 },
  );
  if (vp.exitCode !== 0) {
    throw new Error(`Failed to set viewport: ${vp.stderr.trim() || vp.stdout.trim()}`);
  }

  // 2. navigate to dev server origin
  const opened = await runAgentBrowser(["open", args.baseUrl], { timeoutMs: 30_000 });
  if (opened.exitCode !== 0) {
    throw new Error(
      `Failed to open ${args.baseUrl}. Is the dev server running? ` +
        `(${opened.stderr.trim() || opened.stdout.trim()})`,
    );
  }

  // 3. inject visualization HTML in-place
  const bootstrap = buildBootstrapScript(htmlBody, args.storeId);
  await agentBrowserEval(bootstrap, 30_000);

  // 4. wait for the script's IIFE to attach + first poll to populate
  const populated = await agentBrowserEval(
    buildWaitForPopulatedScript(POPULATE_TIMEOUT_MS, POPULATE_POLL_INTERVAL_MS),
    POPULATE_TIMEOUT_MS + 5_000,
  );
  const wasPopulated =
    !!populated &&
    typeof populated === "object" &&
    (populated as { populated?: unknown }).populated === true;
  if (!wasPopulated) {
    process.stderr.write(
      `[warn] manifest card stayed empty after ${POPULATE_TIMEOUT_MS}ms; taking screenshots anyway. Is the storeId valid and the snapshot endpoint reachable?\n`,
    );
  }

  // 5. detect actual selectors present in this HTML
  const selectors = await detectSelectors();
  process.stdout.write(
    `[info] selectors: manifest=${selectors.manifest} shot=${selectors.firstShot} final=${selectors.final}\n`,
  );

  const targets: ScreenshotTarget[] = [
    { filename: "overview.png", selector: null, description: "overview (full page)" },
    { filename: "manifest.png", selector: selectors.manifest, description: "manifest card" },
    { filename: "shot.png", selector: selectors.firstShot, description: "first shot card" },
    { filename: "final.png", selector: selectors.final, description: "final card" },
  ];

  for (const target of targets) {
    const absPath = resolvePath(absOutDir, target.filename);
    await takeScreenshotAgentBrowser(target, absPath);
    process.stdout.write(`[ok] wrote ${absPath}\n`);
  }

  // best-effort cleanup
  await runAgentBrowser(["close"], { timeoutMs: 10_000 });
}

async function runWithPlaywright(
  args: CliArgs,
  htmlBody: string,
  absOutDir: string,
): Promise<void> {
  // Minimal fallback: use a tiny inline Node script via `bunx playwright` is not
  // a runnable test, so we shell out to a small bun child that imports playwright.
  // We only do this when playwright is already installed in node_modules.
  const driverSrc = `
    import { chromium } from "playwright";
    const args = JSON.parse(process.argv[2]);
    const htmlB64 = process.argv[3];
    const html = Buffer.from(htmlB64, "base64").toString("utf8");
    const SELECTOR_CANDIDATES = ${JSON.stringify(SELECTOR_CANDIDATES)};
    (async () => {
      const browser = await chromium.launch();
      const ctx = await browser.newContext({
        viewport: { width: ${VIEWPORT_WIDTH}, height: ${VIEWPORT_HEIGHT} },
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.goto(args.baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(({ html, storeId }) => {
        const url = new URL(location.href);
        url.searchParams.set("storeId", storeId);
        history.replaceState(null, "", url.toString());
        document.open();
        document.write(html);
        document.close();
      }, { html, storeId: args.storeId });
      // wait for populate
      const deadline = Date.now() + ${POPULATE_TIMEOUT_MS};
      let populated = false;
      while (Date.now() < deadline) {
        populated = await page.evaluate(() => {
          const el =
            document.querySelector('[data-card-id="manifest"]') ||
            document.querySelector('[data-id="manifest"]') ||
            document.querySelector('#card-manifest') ||
            document.querySelector('.col-left .card');
          if (!el) return false;
          const fields = el.querySelector('.fields');
          return !!(fields && fields.children.length > 0);
        });
        if (populated) break;
        await new Promise((r) => setTimeout(r, ${POPULATE_POLL_INTERVAL_MS}));
      }
      if (!populated) {
        process.stderr.write("[warn] manifest stayed empty; screenshotting anyway\\n");
      }
      // detect selectors
      const selectors = await page.evaluate((cands) => {
        for (const c of cands) {
          const m = document.querySelector(c.manifest);
          const f = document.querySelector(c.final);
          if (m && f) return c;
        }
        return null;
      }, SELECTOR_CANDIDATES);
      if (!selectors) {
        await browser.close();
        throw new Error("Could not detect card selectors");
      }
      const path = require("node:path");
      const overview = path.join(args.outDir, "overview.png");
      await page.screenshot({ path: overview, fullPage: true });
      const manifestEl = await page.$(selectors.manifest);
      if (manifestEl) await manifestEl.screenshot({ path: path.join(args.outDir, "manifest.png") });
      const shotEl = await page.$(selectors.firstShot);
      if (shotEl) await shotEl.screenshot({ path: path.join(args.outDir, "shot.png") });
      const finalEl = await page.$(selectors.final);
      if (finalEl) await finalEl.screenshot({ path: path.join(args.outDir, "final.png") });
      await browser.close();
      process.stdout.write(JSON.stringify({ selectors, populated }) + "\\n");
    })().catch((e) => {
      process.stderr.write(String(e && e.stack || e) + "\\n");
      process.exit(1);
    });
  `;
  const tmpFile = resolvePath(absOutDir, ".playwright-driver.mjs");
  await Bun.write(tmpFile, driverSrc);
  const htmlB64 = Buffer.from(htmlBody, "utf8").toString("base64");
  const payload = JSON.stringify({
    baseUrl: args.baseUrl,
    storeId: args.storeId,
    outDir: absOutDir,
  });
  const r = await spawnCapture(["bun", "run", tmpFile, payload, htmlB64], { timeoutMs: 120_000 });
  if (r.exitCode !== 0) {
    throw new Error(`playwright fallback failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  if (r.stdout.trim()) process.stdout.write(r.stdout);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const htmlPath = resolvePath(process.cwd(), "docs", "architecture", "index.html");
  const absOutDir = resolvePath(process.cwd(), args.outDir);

  const htmlBody = await readFile(htmlPath, "utf8");
  await mkdir(absOutDir, { recursive: true });

  const driver = await pickDriver();
  process.stdout.write(`[info] driver=${driver} baseUrl=${args.baseUrl} storeId=${args.storeId}\n`);

  if (driver === "agent-browser") {
    await runWithAgentBrowser(args, htmlBody, absOutDir);
  } else {
    await runWithPlaywright(args, htmlBody, absOutDir);
  }

  process.stdout.write(`[done] screenshots in ${absOutDir}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[fail] ${toErrorMessage(err)}\n`);
  process.exit(1);
});
