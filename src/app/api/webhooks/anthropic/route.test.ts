import { createHmac } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const EVENTS_DIR = join(process.cwd(), "data", "webhooks");
const EVENTS_FILE = join(EVENTS_DIR, "events.jsonl");

function makeEnvelope(id: string, created_at?: string) {
  return {
    type: "event" as const,
    id,
    created_at: created_at ?? new Date().toISOString(),
    data: {
      type: "agent.run.completed",
      id: "run_abc",
      organization_id: "org_1",
      workspace_id: "ws_1",
    },
  };
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeRequest(
  body: unknown,
  opts: { secret?: string; sig?: string | null } = {},
): Request {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.sig !== null) {
    const header =
      opts.sig !== undefined
        ? opts.sig
        : opts.secret
          ? sign(raw, opts.secret)
          : undefined;
    if (header !== undefined) headers["x-webhook-signature"] = header;
  }
  return new Request("http://localhost/api/webhooks/anthropic", {
    method: "POST",
    headers,
    body: raw,
  });
}

beforeEach(async () => {
  await rm(EVENTS_DIR, { recursive: true, force: true });
  await mkdir(EVENTS_DIR, { recursive: true });
  delete process.env.ANTHROPIC_WEBHOOK_SECRET;
});

afterEach(async () => {
  await rm(EVENTS_DIR, { recursive: true, force: true });
  delete process.env.ANTHROPIC_WEBHOOK_SECRET;
});

async function readLines(): Promise<string[]> {
  try {
    const txt = await readFile(EVENTS_FILE, "utf8");
    return txt
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

describe("POST /api/webhooks/anthropic", () => {
  test("valid event is appended to events.jsonl", async () => {
    const { POST } = await import("./route");

    const env = makeEnvelope("evt_valid_1");
    const req = makeRequest(env);
    const res = await POST(req);
    const json = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);

    const lines = await readLines();
    expect(lines).toHaveLength(1);
    const stored = JSON.parse(lines[0] ?? "{}") as { id: string };
    expect(stored.id).toBe("evt_valid_1");
  });

  test("stale event returns 401 and is not appended", async () => {
    const { POST } = await import("./route");

    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const env = makeEnvelope("evt_stale_1", sixMinutesAgo);
    const req = makeRequest(env);
    const res = await POST(req);
    const json = (await res.json()) as { error: string };

    expect(res.status).toBe(401);
    expect(json.error).toBe("stale_event");

    const lines = await readLines();
    expect(lines).toHaveLength(0);
  });

  test("bad signature returns 401 when secret is set", async () => {
    process.env.ANTHROPIC_WEBHOOK_SECRET = "mysecret";
    const { POST } = await import("./route");

    const env = makeEnvelope("evt_badsig_1");
    const req = makeRequest(env, { sig: "badhexvalue" });
    const res = await POST(req);
    const json = (await res.json()) as { error: string };

    expect(res.status).toBe(401);
    expect(json.error).toBe("invalid_signature");

    const lines = await readLines();
    expect(lines).toHaveLength(0);
  });

  test("duplicate event.id returns 200 but skips append", async () => {
    const { POST } = await import("./route");

    const env = makeEnvelope("evt_dedup_1");
    const req1 = makeRequest(env);
    const req2 = makeRequest(env);

    const res1 = await POST(req1);
    expect(res1.status).toBe(200);

    const res2 = await POST(req2);
    expect(res2.status).toBe(200);

    const lines = await readLines();
    expect(lines).toHaveLength(1);
  });
});
