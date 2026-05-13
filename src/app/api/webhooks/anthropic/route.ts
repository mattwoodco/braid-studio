import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const EVENTS_DIR = join(process.cwd(), "data", "webhooks");
const EVENTS_FILE = join(EVENTS_DIR, "events.jsonl");
const STALE_MS = 5 * 60 * 1000;

const seen = new Set<string>();

const dirReady: Promise<void> = mkdir(EVENTS_DIR, { recursive: true }).then(() => undefined);

type WebhookEventData = {
  type: string;
  id: string;
  organization_id?: string;
  workspace_id?: string;
};

type WebhookEnvelope = {
  type: "event";
  id: string;
  created_at: string;
  data: WebhookEventData;
};

function isEnvelope(v: unknown): v is WebhookEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.type === "event" &&
    typeof o.id === "string" &&
    typeof o.created_at === "string" &&
    typeof o.data === "object" &&
    o.data !== null
  );
}

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(header, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const secret = process.env.ANTHROPIC_WEBHOOK_SECRET;

  if (secret) {
    const sig = req.headers.get("x-webhook-signature");
    if (!verifySignature(rawBody, sig, secret)) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
  } else {
    console.warn("[webhook] ANTHROPIC_WEBHOOK_SECRET not set — accepting all events (dev mode)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!isEnvelope(parsed)) {
    return NextResponse.json({ error: "invalid_envelope" }, { status: 400 });
  }

  const envelope = parsed;
  const age = Math.abs(Date.now() - new Date(envelope.created_at).getTime());
  if (age > STALE_MS) {
    return NextResponse.json({ error: "stale_event" }, { status: 401 });
  }

  if (seen.has(envelope.id)) {
    return NextResponse.json({ ok: true });
  }
  seen.add(envelope.id);

  await dirReady;
  await appendFile(EVENTS_FILE, JSON.stringify(envelope) + "\n", "utf8");

  return NextResponse.json({ ok: true });
}
