import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type SpendRow = {
  ts: string;
  briefId: string;
  phase: string;
  kind: string;
  model: string;
  tokens: number;
  durationMs: number;
  cost: number;
};

export type BriefSummary = {
  briefId: string;
  total: number;
  byPhase: Record<string, number>;
  byKind: Record<string, number>;
};

export type Summary = {
  byBrief: BriefSummary[];
  grandTotal: number;
};

export function summarize(rows: SpendRow[]): Summary {
  const map = new Map<string, BriefSummary>();
  let grandTotal = 0;
  for (const row of rows) {
    const cost = Number.isFinite(row.cost) ? row.cost : 0;
    grandTotal += cost;
    let entry = map.get(row.briefId);
    if (!entry) {
      entry = { briefId: row.briefId, total: 0, byPhase: {}, byKind: {} };
      map.set(row.briefId, entry);
    }
    entry.total += cost;
    entry.byPhase[row.phase] = (entry.byPhase[row.phase] ?? 0) + cost;
    entry.byKind[row.kind] = (entry.byKind[row.kind] ?? 0) + cost;
  }
  const byBrief = Array.from(map.values()).sort((a, b) =>
    a.briefId.localeCompare(b.briefId),
  );
  return { byBrief, grandTotal };
}

function fmt(n: number): string {
  return `$${n.toFixed(4)}`;
}

function renderRecord(label: string, rec: Record<string, number>): string {
  const keys = Object.keys(rec).sort();
  if (keys.length === 0) return `_no ${label}_`;
  return keys.map((k) => `${k}=${fmt(rec[k] ?? 0)}`).join(", ");
}

export function renderMarkdown(summary: Summary): string {
  const lines: string[] = [];
  lines.push("# Spend Report");
  lines.push("");
  if (summary.byBrief.length === 0) {
    lines.push("_no spend records found_");
    lines.push("");
    lines.push(`**Grand total:** ${fmt(summary.grandTotal)}`);
    return lines.join("\n");
  }
  for (const brief of summary.byBrief) {
    lines.push(`## ${brief.briefId}`);
    lines.push("");
    lines.push(`- Total: ${fmt(brief.total)}`);
    lines.push(`- By phase: ${renderRecord("phases", brief.byPhase)}`);
    lines.push(`- By kind: ${renderRecord("kinds", brief.byKind)}`);
    lines.push("");
    lines.push("| Phase | Cost |");
    lines.push("|---|---|");
    for (const phase of Object.keys(brief.byPhase).sort()) {
      lines.push(`| ${phase} | ${fmt(brief.byPhase[phase] ?? 0)} |`);
    }
    lines.push("");
    lines.push("| Kind | Cost |");
    lines.push("|---|---|");
    for (const kind of Object.keys(brief.byKind).sort()) {
      lines.push(`| ${kind} | ${fmt(brief.byKind[kind] ?? 0)} |`);
    }
    lines.push("");
  }
  lines.push(`**Grand total:** ${fmt(summary.grandTotal)}`);
  return lines.join("\n");
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = entry.name;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      const nested = await walk(full);
      for (const p of nested) out.push(p);
    } else if (entry.isFile() && name === "spend.jsonl") {
      out.push(full);
    }
  }
  return out;
}

function inferBriefId(runDir: string, filePath: string): string {
  const rel = relative(runDir, filePath);
  const parts = rel.split(sep);
  if (parts.length >= 2) return parts[0] ?? "unknown";
  return "unknown";
}

function parseRow(line: string, fallbackBriefId: string): SpendRow | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const briefId =
    typeof obj.briefId === "string" && obj.briefId.length > 0
      ? obj.briefId
      : fallbackBriefId;
  const ts = typeof obj.ts === "string" ? obj.ts : "";
  const phase = typeof obj.phase === "string" ? obj.phase : "unknown";
  const kind = typeof obj.kind === "string" ? obj.kind : "unknown";
  const model = typeof obj.model === "string" ? obj.model : "unknown";
  const tokens = typeof obj.tokens === "number" ? obj.tokens : 0;
  const durationMs = typeof obj.durationMs === "number" ? obj.durationMs : 0;
  const cost = typeof obj.cost === "number" ? obj.cost : 0;
  return { ts, briefId, phase, kind, model, tokens, durationMs, cost };
}

export async function loadRows(runDir: string): Promise<SpendRow[]> {
  const files = await walk(runDir);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const fallbackBriefId = inferBriefId(runDir, file);
      const content = await readFile(file, "utf8");
      const rows: SpendRow[] = [];
      for (const line of content.split("\n")) {
        const row = parseRow(line, fallbackBriefId);
        if (row) rows.push(row);
      }
      return rows;
    }),
  );
  return perFile.flat();
}

export type PrintFn = (s: string) => void;

export async function main(
  argv: string[],
  print: PrintFn = (s) => {
    console.log(s);
  },
): Promise<void> {
  const runDir = argv[0];
  if (!runDir) {
    print("usage: bun run scripts/spend-report.ts <runDir>");
    return;
  }
  const rows = await loadRows(runDir);
  const summary = summarize(rows);
  print(renderMarkdown(summary));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
