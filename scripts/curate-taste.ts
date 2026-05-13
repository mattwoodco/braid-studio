/**
 * Curate taste from completed brief memory stores via Dreams.
 *
 * Usage:
 *   bun scripts/curate-taste.ts <storeId> [<storeId> ...] [--previous=<tasteStoreId>]
 *   bun scripts/curate-taste.ts --run-dir=<path> [--previous=<tasteStoreId>]
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runTasteDream } from "@/lib/taste-dream";

type CheckpointShape = { storeId?: unknown };

async function readStoreIdsFromRunDir(runDir: string): Promise<string[]> {
  const entries = await readdir(runDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cpPath = join(runDir, entry.name, "checkpoint.json");
    try {
      const raw = await readFile(cpPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const storeId = (parsed as CheckpointShape).storeId;
      if (typeof storeId === "string" && storeId.length > 0) ids.push(storeId);
    } catch {
      // skip directories without a checkpoint
    }
  }
  return ids;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const briefStoreIds: string[] = [];
  let runDir: string | null = null;
  let previousTasteStoreId: string | undefined;

  for (const a of args) {
    if (a.startsWith("--run-dir=")) runDir = a.slice("--run-dir=".length);
    else if (a.startsWith("--previous=")) previousTasteStoreId = a.slice("--previous=".length);
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    } else {
      briefStoreIds.push(a);
    }
  }

  if (runDir) {
    const found = await readStoreIdsFromRunDir(runDir);
    briefStoreIds.push(...found);
  }

  if (briefStoreIds.length === 0) {
    console.error(
      "usage: bun scripts/curate-taste.ts <storeId> [<storeId> ...] [--previous=<tasteStoreId>]\n" +
        "       bun scripts/curate-taste.ts --run-dir=<path> [--previous=<tasteStoreId>]",
    );
    process.exit(1);
  }

  console.log(`curating taste from ${briefStoreIds.length} brief store(s)...`);
  if (previousTasteStoreId) console.log(`anchoring on previous taste: ${previousTasteStoreId}`);

  const result = await runTasteDream({
    briefStoreIds,
    ...(previousTasteStoreId ? { previousTasteStoreId } : {}),
  });

  console.log(`new taste store: ${result.tasteStoreId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
