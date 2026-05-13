import {
  createMemory,
  createMemoryStore,
  listMemoryStores,
  updateMemoryStoreMetadata,
} from "@/lib/anthropic";
import { RUBRIC_TEMPLATE } from "@/lib/rubric";
/**
 * POST /api/projects     create a new project (memory store)
 * GET  /api/projects     list projects (memory stores filtered by metadata)
 */
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  name: z.string().min(1).max(255),
  brief: z.string().max(4000).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { name, brief } = parsed.data;
  try {
    const description = (brief ?? name)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1000);
    const store = await createMemoryStore({
      name,
      description,
    });
    await updateMemoryStoreMetadata(store.id, {
      braid_studio: "v1",
      project_name: name,
    });
    await createMemory(store.id, {
      path: "/memory/manifest.json",
      content: JSON.stringify(
        { name, brief: brief ?? null, created_at: new Date().toISOString() },
        null,
        2,
      ),
    });
    await createMemory(store.id, {
      path: "/memory/rubric.md",
      content: RUBRIC_TEMPLATE,
    });
    return NextResponse.json({ storeId: store.id, name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/projects] create failed:", message);
    return NextResponse.json({ error: "create_failed", message }, { status: 500 });
  }
}

export async function GET(): Promise<Response> {
  const stores = await listMemoryStores({ metadata: { braid_studio: "v1" } });
  return NextResponse.json({
    projects: stores.map((s) => {
      const out: { storeId: string; name: string; createdAt?: string } = {
        storeId: s.id,
        name: s.metadata?.project_name ?? s.name,
      };
      if (s.createdAt) out.createdAt = s.createdAt;
      return out;
    }),
  });
}
