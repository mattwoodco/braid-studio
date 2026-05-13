/**
 * The ONE Anthropic SDK seam for braid-studio.
 *
 * Ported from the experiment's `apps/web/lib/anthropic.ts` (verified live
 * against `@anthropic-ai/sdk@0.95.1`). Trimmed to what the two lanes need:
 *   - memory stores: create, list (with metadata filter), list memories,
 *     create memory, update memory
 *   - sessions: create, send event, stream session, post custom-tool result
 */
import Anthropic, { APIError } from "@anthropic-ai/sdk";

// ---------- Public DTOs ----------

export type MemoryStore = {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  metadata?: Record<string, string>;
};
export type MemoryEntry = {
  id: string;
  path: string;
  content: string;
  updatedAt: string;
};

// ---------- Errors ----------

export class MissingAnthropicKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set. Add it to .env.local.");
    this.name = "MissingAnthropicKeyError";
  }
}

// ---------- Singleton client ----------

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new MissingAnthropicKeyError();
  _client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  return _client;
}

// ---------- Retry helper ----------

const RETRY_DELAYS_MS = [200, 800, 3200] as const;

function isRetryable(err: unknown): boolean {
  if (err instanceof APIError) {
    const s = err.status;
    if (s === 429) return true;
    if (typeof s === "number" && s >= 500 && s < 600) return true;
  }
  if (typeof err === "object" && err !== null && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (s === 429) return true;
    if (typeof s === "number" && s >= 500 && s < 600) return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryable(err)) throw err;
      const delay = RETRY_DELAYS_MS[attempt] ?? 1000;
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------- Helpers ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// ---------- Memory stores ----------

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

interface SdkMemoryStoreLike {
  id: string;
  name: string;
  description?: string | null;
  created_at?: string;
  metadata?: Record<string, string> | null;
}

function toMemoryStore(raw: SdkMemoryStoreLike): MemoryStore {
  const out: MemoryStore = { id: raw.id, name: raw.name };
  if (raw.description) out.description = raw.description;
  if (raw.created_at) out.createdAt = raw.created_at;
  if (raw.metadata) out.metadata = raw.metadata;
  return out;
}

interface MemoryStoresResourceLike {
  create: (params: {
    name: string;
    description?: string;
    metadata?: Record<string, string>;
  }) => Promise<SdkMemoryStoreLike>;
  list: (params?: {
    include_archived?: boolean;
  }) => AsyncIterable<SdkMemoryStoreLike>;
  update: (
    memoryStoreId: string,
    params: { metadata?: Record<string, string | null> | null },
  ) => Promise<SdkMemoryStoreLike>;
  memories: {
    create: (
      memoryStoreId: string,
      params: { path: string; content: string; view?: "full" | "basic" },
    ) => Promise<SdkMemoryLike>;
    list: (
      memoryStoreId: string,
      params: { path_prefix?: string; view: "full" | "basic" },
    ) => AsyncIterable<unknown>;
    update: (
      memoryId: string,
      params: {
        memory_store_id: string;
        content?: string;
        path?: string;
        view?: "full" | "basic";
      },
    ) => Promise<SdkMemoryLike>;
  };
}

function getMemoryStores(client: Anthropic): MemoryStoresResourceLike {
  return (client as unknown as { beta: { memoryStores: MemoryStoresResourceLike } }).beta
    .memoryStores;
}

export async function createMemoryStore(input: {
  name: string;
  description?: string;
  metadata?: Record<string, string>;
}): Promise<MemoryStore> {
  const r = getMemoryStores(getAnthropic());
  const params: {
    name: string;
    description?: string;
    metadata?: Record<string, string>;
  } = { name: input.name };
  if (input.description !== undefined) params.description = input.description;
  if (input.metadata !== undefined) params.metadata = input.metadata;
  const raw = await withRetry(() => r.create(params));
  return toMemoryStore(raw);
}

export async function updateMemoryStoreMetadata(
  storeId: string,
  metadata: Record<string, string | null>,
): Promise<MemoryStore> {
  const r = getMemoryStores(getAnthropic());
  const raw = await withRetry(() => r.update(storeId, { metadata }));
  return toMemoryStore(raw);
}

/**
 * Lists memory stores filtered to those whose metadata includes EVERY entry
 * in `metadata` (string equality on each key/value).
 */
export async function listMemoryStores(
  filter: { metadata?: Record<string, string> } = {},
): Promise<MemoryStore[]> {
  const r = getMemoryStores(getAnthropic());
  const out: MemoryStore[] = [];
  const wanted = filter.metadata ?? {};
  for await (const item of r.list({})) {
    const md = (item as SdkMemoryStoreLike).metadata ?? {};
    let match = true;
    for (const [k, v] of Object.entries(wanted)) {
      if (md[k] !== v) {
        match = false;
        break;
      }
    }
    if (match) out.push(toMemoryStore(item as SdkMemoryStoreLike));
  }
  return out;
}

// ---------- Memories ----------

interface SdkMemoryLike {
  id: string;
  path: string;
  content?: string | null;
  updated_at: string;
  type?: string;
}

function isMemory(item: unknown): item is SdkMemoryLike {
  if (typeof item !== "object" || item === null) return false;
  const rec = item as Record<string, unknown>;
  if (rec.type === "memory_prefix") return false;
  return typeof rec.id === "string" && typeof rec.path === "string";
}

function toMemoryEntry(raw: SdkMemoryLike): MemoryEntry {
  return {
    id: raw.id,
    path: raw.path,
    content: raw.content ?? "",
    updatedAt: raw.updated_at,
  };
}

export async function listMemories(
  storeId: string,
  opts: { prefix?: string } = {},
): Promise<MemoryEntry[]> {
  const r = getMemoryStores(getAnthropic());
  const params: { path_prefix?: string; view: "full" } = { view: "full" };
  if (opts.prefix !== undefined) params.path_prefix = opts.prefix;
  const page = r.memories.list(storeId, params);
  const out: MemoryEntry[] = [];
  for await (const item of page) {
    if (isMemory(item)) out.push(toMemoryEntry(item));
  }
  return out;
}

export async function createMemory(
  storeId: string,
  input: { path: string; content: string },
): Promise<MemoryEntry> {
  const r = getMemoryStores(getAnthropic());
  const raw = await withRetry(() =>
    r.memories.create(storeId, {
      path: input.path,
      content: input.content,
      view: "full",
    }),
  );
  return toMemoryEntry({
    id: raw.id,
    path: raw.path,
    content: raw.content ?? input.content,
    updated_at: raw.updated_at,
  });
}

export async function updateMemory(
  storeId: string,
  memoryId: string,
  input: { content: string },
): Promise<MemoryEntry> {
  const r = getMemoryStores(getAnthropic());
  const raw = await withRetry(() =>
    r.memories.update(memoryId, {
      memory_store_id: storeId,
      content: input.content,
      view: "full",
    }),
  );
  return toMemoryEntry({
    id: raw.id,
    path: raw.path,
    content: raw.content ?? input.content,
    updated_at: raw.updated_at,
  });
}

// ---------- Sessions ----------

export type SessionId = string;

export type SessionResource = {
  type: "memory_store";
  memory_store_id: string;
  access?: "read_only" | "read_write";
  instructions?: string;
};

export type MultiagentCoordinatorConfig = {
  type: "coordinator";
  agents: Array<{ id: string; type: "self" }>;
};

export type CreateSessionInput = {
  agentId: string;
  environmentId: string;
  resources?: SessionResource[];
  vaultIds?: string[];
  title?: string;
  multiagent?: MultiagentCoordinatorConfig;
};

export type CreatedSession = { sessionId: SessionId };

export type OutgoingSessionEvent =
  | { type: "user.message"; content: string }
  | { type: "user.define_outcome"; rubric: string; maxIterations?: number }
  | {
      type: "user.custom_tool_result";
      customToolUseId: string;
      content: string | object;
      isError?: boolean;
    };

export type IncomingSessionEvent =
  | { type: "agent.thinking"; sessionId: SessionId; eventId: string; raw: unknown }
  | {
      type: "agent.message";
      sessionId: SessionId;
      eventId: string;
      text: string;
      raw: unknown;
    }
  | {
      type: "agent.tool_use";
      sessionId: SessionId;
      eventId: string;
      toolName: string;
      input: Record<string, unknown>;
      raw: unknown;
    }
  | {
      type: "agent.tool_result";
      sessionId: SessionId;
      eventId: string;
      content: string;
      isError: boolean;
      raw: unknown;
    }
  | {
      type: "session.status_idle";
      sessionId: SessionId;
      eventId: string;
      stopReason: string;
      raw: unknown;
    }
  | {
      type: "session.status_running";
      sessionId: SessionId;
      eventId: string;
      raw: unknown;
    }
  | {
      type: "other";
      sessionId: SessionId;
      eventId: string;
      rawType: string;
      raw: unknown;
    };

interface SdkSessionsResource {
  create: (params: {
    agent: string;
    environment_id: string;
    resources?: Array<{
      type: "memory_store";
      memory_store_id: string;
      access?: "read_only" | "read_write";
      instructions?: string;
    }>;
    vault_ids?: string[];
    title?: string;
    betas: string[];
  }) => Promise<unknown>;
  events: {
    send: (
      sessionId: string,
      params: {
        events: Array<Record<string, unknown>>;
        betas: string[];
      },
    ) => Promise<unknown>;
    stream: (
      sessionId: string,
      params: { betas: string[] },
    ) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  };
}

function getSessions(client: Anthropic): SdkSessionsResource {
  return (client as unknown as { beta: { sessions: SdkSessionsResource } }).beta.sessions;
}

function toSdkOutgoing(event: OutgoingSessionEvent): Record<string, unknown> {
  switch (event.type) {
    case "user.message":
      return {
        type: "user.message",
        content: [{ type: "text", text: event.content }],
      };
    case "user.define_outcome": {
      const out: Record<string, unknown> = {
        type: "user.define_outcome",
        description: event.rubric,
        rubric: { type: "text", content: event.rubric },
      };
      if (event.maxIterations !== undefined) {
        out.max_iterations = event.maxIterations;
      }
      return out;
    }
    case "user.custom_tool_result": {
      const text =
        typeof event.content === "string" ? event.content : JSON.stringify(event.content);
      const out: Record<string, unknown> = {
        type: "user.custom_tool_result",
        custom_tool_use_id: event.customToolUseId,
        content: [{ type: "text", text }],
      };
      if (event.isError !== undefined) out.is_error = event.isError;
      return out;
    }
  }
}

export function mapIncomingEvent(raw: unknown, sessionId: SessionId): IncomingSessionEvent {
  const rec = asRecord(raw);
  if (!rec) {
    return { type: "other", sessionId, eventId: "", rawType: "", raw };
  }
  const rawType = asString(rec.type);
  const eventId = asString(rec.id);

  switch (rawType) {
    case "agent.thinking":
      return { type: "agent.thinking", sessionId, eventId, raw };
    case "agent.message": {
      const blocks = Array.isArray(rec.content) ? rec.content : [];
      const parts: string[] = [];
      for (const block of blocks) {
        const b = asRecord(block);
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
      return { type: "agent.message", sessionId, eventId, text: parts.join(""), raw };
    }
    case "agent.tool_use":
    case "agent.mcp_tool_use":
    case "agent.custom_tool_use": {
      const input = asRecord(rec.input) ?? {};
      return {
        type: "agent.tool_use",
        sessionId,
        eventId,
        toolName: asString(rec.name) || asString(rec.tool_name),
        input,
        raw,
      };
    }
    case "agent.tool_result":
    case "agent.mcp_tool_result": {
      const contentRaw = rec.content;
      let content = "";
      if (typeof contentRaw === "string") {
        content = contentRaw;
      } else if (Array.isArray(contentRaw)) {
        const parts: string[] = [];
        for (const b of contentRaw) {
          const r = asRecord(b);
          if (r && typeof r.text === "string") parts.push(r.text);
        }
        content = parts.join("");
      }
      const isError = rec.is_error === true;
      return { type: "agent.tool_result", sessionId, eventId, content, isError, raw };
    }
    case "session.status_running":
      return { type: "session.status_running", sessionId, eventId, raw };
    case "session.status_idle": {
      const stop = asRecord(rec.stop_reason);
      const stopReason = stop ? asString(stop.type, "end_turn") : "end_turn";
      return { type: "session.status_idle", sessionId, eventId, stopReason, raw };
    }
    default:
      return { type: "other", sessionId, eventId, rawType, raw };
  }
}

// ---------- Managed-Agent client seam ----------

export interface ManagedAgentClient {
  createSession(input: CreateSessionInput): Promise<CreatedSession>;
  sendEvent(sessionId: SessionId, event: OutgoingSessionEvent): Promise<void>;
  streamSession(sessionId: SessionId): AsyncIterable<IncomingSessionEvent>;
}

const defaultManagedAgentClient: ManagedAgentClient = {
  async createSession(input) {
    const params: {
      agent: string;
      environment_id: string;
      resources?: Array<{
        type: "memory_store";
        memory_store_id: string;
        access?: "read_only" | "read_write";
        instructions?: string;
      }>;
      vault_ids?: string[];
      title?: string;
      multiagent?: MultiagentCoordinatorConfig;
      betas: string[];
    } = {
      agent: input.agentId,
      environment_id: input.environmentId,
      betas: [MANAGED_AGENTS_BETA],
    };
    if (input.resources && input.resources.length > 0) {
      params.resources = input.resources.map((r) => {
        const o: {
          type: "memory_store";
          memory_store_id: string;
          access?: "read_only" | "read_write";
          instructions?: string;
        } = { type: "memory_store", memory_store_id: r.memory_store_id };
        if (r.access !== undefined) o.access = r.access;
        if (r.instructions !== undefined) o.instructions = r.instructions;
        return o;
      });
    }
    if (input.vaultIds && input.vaultIds.length > 0) {
      params.vault_ids = input.vaultIds;
    }
    if (input.title !== undefined) params.title = input.title;
    if (input.multiagent !== undefined) params.multiagent = input.multiagent;

    const raw = await withRetry(() =>
      getSessions(getAnthropic()).create(params as Parameters<SdkSessionsResource["create"]>[0]),
    );
    const rec = asRecord(raw);
    if (!rec || typeof rec.id !== "string") {
      throw new Error("anthropic: sessions.create returned unexpected shape");
    }
    return { sessionId: rec.id };
  },
  async sendEvent(sessionId, event) {
    await withRetry(() =>
      getSessions(getAnthropic()).events.send(sessionId, {
        events: [toSdkOutgoing(event)],
        betas: [MANAGED_AGENTS_BETA],
      }),
    );
  },
  streamSession(sessionId) {
    return streamSessionDefault(sessionId);
  },
};

let _managedAgentClient: ManagedAgentClient = defaultManagedAgentClient;

export function setManagedAgentClient(impl: ManagedAgentClient): void {
  _managedAgentClient = impl;
}

export function resetManagedAgentClient(): void {
  _managedAgentClient = defaultManagedAgentClient;
}

export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  return _managedAgentClient.createSession(input);
}

export async function sendEvent(sessionId: SessionId, event: OutgoingSessionEvent): Promise<void> {
  return _managedAgentClient.sendEvent(sessionId, event);
}

export async function postCustomToolResult(
  sessionId: SessionId,
  customToolUseId: string,
  content: string | object,
  opts: { isError?: boolean } = {},
): Promise<void> {
  const event: OutgoingSessionEvent = {
    type: "user.custom_tool_result",
    customToolUseId,
    content,
  };
  if (opts.isError !== undefined) event.isError = opts.isError;
  await sendEvent(sessionId, event);
}

// ---------- Dreams (research preview) ----------
//
// Dreams curate + deduplicate memory across past sessions. Input: a memory
// store and up to 100 session_ids. Output: a NEW memory store (input is never
// mutated). Useful for distilling brand voice, recurring shot patterns, and
// client preferences from many iterative ad-revision sessions.
//
// The SDK (@anthropic-ai/sdk@0.95.2) does not yet expose `client.beta.dreams`,
// so we call the REST endpoint directly with the dreaming beta header.

const DREAMING_BETA = "dreaming-2026-04-21";
const ANTHROPIC_API_BASE = "https://api.anthropic.com";

export type DreamStatus = "pending" | "running" | "completed" | "failed" | "canceled";

export type Dream = {
  id: string;
  status: DreamStatus;
  model: string | null;
  inputs: Array<
    | { type: "memory_store"; memory_store_id: string }
    | { type: "sessions"; session_ids: string[] }
  >;
  outputs: Array<{ type: "memory_store"; memory_store_id: string }>;
  sessionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  usage: Record<string, unknown> | null;
  raw: unknown;
};

function dreamHeaders(): Record<string, string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new MissingAnthropicKeyError();
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": `${MANAGED_AGENTS_BETA},${DREAMING_BETA}`,
  };
}

function toDream(raw: unknown): Dream {
  const rec = asRecord(raw) ?? {};
  const inputsRaw = Array.isArray(rec.inputs) ? rec.inputs : [];
  const outputsRaw = Array.isArray(rec.outputs) ? rec.outputs : [];
  const inputs: Dream["inputs"] = [];
  for (const item of inputsRaw) {
    const r = asRecord(item);
    if (!r) continue;
    if (r.type === "memory_store" && typeof r.memory_store_id === "string") {
      inputs.push({ type: "memory_store", memory_store_id: r.memory_store_id });
    } else if (r.type === "sessions" && Array.isArray(r.session_ids)) {
      inputs.push({
        type: "sessions",
        session_ids: r.session_ids.filter((s): s is string => typeof s === "string"),
      });
    }
  }
  const outputs: Dream["outputs"] = [];
  for (const item of outputsRaw) {
    const r = asRecord(item);
    if (r && r.type === "memory_store" && typeof r.memory_store_id === "string") {
      outputs.push({ type: "memory_store", memory_store_id: r.memory_store_id });
    }
  }
  return {
    id: asString(rec.id),
    status: (asString(rec.status, "pending") as DreamStatus) ?? "pending",
    model: typeof rec.model === "string" ? rec.model : null,
    inputs,
    outputs,
    sessionId: typeof rec.session_id === "string" ? rec.session_id : null,
    createdAt: typeof rec.created_at === "string" ? rec.created_at : null,
    updatedAt: typeof rec.updated_at === "string" ? rec.updated_at : null,
    usage: asRecord(rec.usage),
    raw,
  };
}

export type CreateDreamInput = {
  memoryStoreId: string;
  sessionIds?: string[];
  model?: string;
  instructions?: string;
};

export async function createDream(input: CreateDreamInput): Promise<Dream> {
  const inputs: Array<Record<string, unknown>> = [
    { type: "memory_store", memory_store_id: input.memoryStoreId },
  ];
  if (input.sessionIds && input.sessionIds.length > 0) {
    inputs.push({ type: "sessions", session_ids: input.sessionIds.slice(0, 100) });
  }
  const body: Record<string, unknown> = {
    inputs,
    model: input.model ?? "claude-sonnet-4-6",
  };
  if (input.instructions !== undefined) body.instructions = input.instructions;
  const res = await withRetry(async () => {
    const r = await fetch(`${ANTHROPIC_API_BASE}/v1/dreams`, {
      method: "POST",
      headers: dreamHeaders(),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`dreams.create ${r.status}: ${text.slice(0, 400)}`);
      (err as Error & { status?: number }).status = r.status;
      throw err;
    }
    return r.json();
  });
  return toDream(res);
}

export async function getDream(dreamId: string): Promise<Dream> {
  const res = await withRetry(async () => {
    const r = await fetch(`${ANTHROPIC_API_BASE}/v1/dreams/${dreamId}`, {
      headers: dreamHeaders(),
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`dreams.retrieve ${r.status}: ${text.slice(0, 400)}`);
      (err as Error & { status?: number }).status = r.status;
      throw err;
    }
    return r.json();
  });
  return toDream(res);
}

export async function listDreams(): Promise<Dream[]> {
  const res = await withRetry(async () => {
    const r = await fetch(`${ANTHROPIC_API_BASE}/v1/dreams`, {
      headers: dreamHeaders(),
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`dreams.list ${r.status}: ${text.slice(0, 400)}`);
      (err as Error & { status?: number }).status = r.status;
      throw err;
    }
    return r.json();
  });
  const rec = asRecord(res);
  const data = rec && Array.isArray(rec.data) ? rec.data : [];
  return data.map(toDream);
}

export async function cancelDream(dreamId: string): Promise<Dream> {
  const res = await withRetry(async () => {
    const r = await fetch(`${ANTHROPIC_API_BASE}/v1/dreams/${dreamId}/cancel`, {
      method: "POST",
      headers: dreamHeaders(),
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`dreams.cancel ${r.status}: ${text.slice(0, 400)}`);
      (err as Error & { status?: number }).status = r.status;
      throw err;
    }
    return r.json();
  });
  return toDream(res);
}

function streamSessionDefault(sessionId: SessionId): AsyncIterable<IncomingSessionEvent> {
  return {
    [Symbol.asyncIterator]() {
      let inner: AsyncIterator<unknown> | null = null;
      return {
        async next(): Promise<IteratorResult<IncomingSessionEvent>> {
          if (!inner) {
            const stream = await getSessions(getAnthropic()).events.stream(sessionId, {
              betas: [MANAGED_AGENTS_BETA],
            });
            inner = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          }
          const next = await inner.next();
          if (next.done) return { value: undefined, done: true };
          return { value: mapIncomingEvent(next.value, sessionId), done: false };
        },
        async return(): Promise<IteratorResult<IncomingSessionEvent>> {
          if (inner?.return) {
            try {
              await inner.return();
            } catch {
              // ignore
            }
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

export function streamSession(sessionId: SessionId): AsyncIterable<IncomingSessionEvent> {
  return _managedAgentClient.streamSession(sessionId);
}
