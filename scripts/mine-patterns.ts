/**
 * Mine pattern data from one or more memory stores.
 *
 * Usage:
 *   bun scripts/mine-patterns.ts <storeId> [<storeId> ...] [--out=path.md]
 */
import { minePatterns, reportToMarkdown } from "@/lib/pattern-miner";
import { writeFile } from "node:fs/promises";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const storeIds: string[] = [];
  let outPath: string | null = null;
  for (const a of args) {
    if (a.startsWith("--out=")) outPath = a.slice("--out=".length);
    else storeIds.push(a);
  }
  if (storeIds.length === 0) {
    console.error("usage: bun scripts/mine-patterns.ts <storeId> [<storeId> ...] [--out=path]");
    process.exit(1);
  }
  console.log(`mining ${storeIds.length} store(s)...`);
  const report = await minePatterns(storeIds);
  const md = reportToMarkdown(report);
  if (outPath) {
    await writeFile(outPath, md);
    console.log(`wrote ${outPath}`);
  } else {
    console.log(md);
  }
  // Print quick summary to stdout regardless.
  console.error(`\n=== SUMMARY: ${report.totalSeatEnvelopes} seat envelopes across ${report.byAspect.size} aspects ===`);
  const sorted = [...report.byAspect.entries()].sort(
    (a, b) => b[1].variance - a[1].variance,
  );
  for (const [a, s] of sorted.slice(0, 8)) {
    console.error(`  ${a}: mean=${s.mean.toFixed(2)} var=${s.variance.toFixed(3)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
