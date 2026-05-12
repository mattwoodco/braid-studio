import {
  createMemory,
  createMemoryStore,
  listMemoryStores,
  updateMemoryStoreMetadata,
} from "@/lib/anthropic";
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
  const store = await createMemoryStore({
    name,
    description: brief ?? name,
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
    content:
      "# Rubric\n\nProduce an mp4 reflecting the brief. Each shot must be vivid. Final compose must verify with ffprobe and end with the file uploaded to a public URL.\n",
  });
  return NextResponse.json({ storeId: store.id, name });
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
