"use client";
import { use, useCallback, useEffect, useId, useRef, useState } from "react";

type Phase = "idle" | "drafting" | "studio-running" | "studio-idle";

type FeedItem = {
  key: string;
  kind: "info" | "thinking" | "message" | "tool_use" | "tool_result" | "status" | "error";
  text: string;
  meta?: string;
  ts: number;
};

type AgentInfo = {
  agent: {
    id: string | null;
    name: string;
    model: string;
    systemPromptExcerpt: string;
    tools: Array<{ type: string; mcpServer: string | null }>;
  };
  environment: {
    id: string | null;
    aptPackages: string[];
    mcpServers: Array<{ name: string; url: string }>;
    networking: { type: string; allowMcpServers: boolean };
  };
  vault: { id: string | null };
};

type Snapshot = {
  manifest: { name: string; brief: string; created_at: string } | null;
  shots: Array<{ n: number; prompt: string; video_url: string; updated_at: string }>;
  final: {
    shot_urls: string[];
    duration_seconds_per_clip: number;
    crossfade_ms: number;
    updated_at: string;
  } | null;
  draft: {
    mp4_filename: string;
    duration_seconds: number;
    file_bytes: number;
    wall_ms: number;
    model_used: string | null;
    updated_at: string;
  } | null;
};

type DraftResponse = {
  mp4LocalPath: string;
  shotUrls: string[];
  durationSeconds: number;
  fileBytes: number;
  wallMs: number;
  modelUsed: string | null;
};

function truncate(s: string, n = 240): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export default function ProjectPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}): React.JSX.Element {
  const { storeId } = use(params);
  const briefId = useId();
  const followupId = useId();
  const keyBase = useId();
  const counterRef = useRef(0);
  const nextKey = (): string => {
    counterRef.current += 1;
    return `${keyBase}-${counterRef.current}`;
  };

  const [brief, setBrief] = useState("");
  const briefHydratedRef = useRef(false);
  const [followup, setFollowup] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [draftResult, setDraftResult] = useState<DraftResponse | null>(null);
  const [studioMp4Url, setStudioMp4Url] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent-info")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AgentInfo | null) => {
        if (!cancelled && data) setAgentInfo(data);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [hydrated, setHydrated] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const lsKey = `braid-studio:${storeId}`;

  // hydrate persisted session + feed once
  useEffect(() => {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        const saved = JSON.parse(raw) as {
          sessionId?: string | null;
          feed?: FeedItem[];
          studioMp4Url?: string | null;
        };
        if (saved.sessionId) setSessionId(saved.sessionId);
        if (saved.feed) {
          const rekeyed = saved.feed.map((f) => ({ ...f, key: nextKey() }));
          setFeed(rekeyed);
        }
        if (saved.studioMp4Url) setStudioMp4Url(saved.studioMp4Url);
      }
    } catch {
      // ignore corrupt entry
    }
    setHydrated(true);
  }, [lsKey]);

  // persist whenever the studio state changes
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(lsKey, JSON.stringify({ sessionId, feed, studioMp4Url }));
    } catch {
      // quota / disabled
    }
  }, [hydrated, lsKey, sessionId, feed, studioMp4Url]);

  const etagRef = useRef<string | null>(null);
  const pollSnapshot = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/memory/${storeId}/snapshot`, {
        headers: etagRef.current ? { "If-None-Match": etagRef.current } : {},
      });
      if (res.status === 200) {
        etagRef.current = res.headers.get("ETag");
        const data = (await res.json()) as Snapshot;
        setSnapshot(data);
        if (!briefHydratedRef.current && data.manifest?.brief) {
          briefHydratedRef.current = true;
          setBrief(data.manifest.brief);
        }
      }
    } catch {
      // ignore transient errors
    }
  }, [storeId]);

  // one fetch on mount, and one whenever phase changes (catches the final
  // snapshot when drafting/studio finishes)
  useEffect(() => {
    void pollSnapshot();
  }, [pollSnapshot, phase]);

  // only interval-poll while something is actively producing snapshot updates
  useEffect(() => {
    const active = phase === "drafting" || phase === "studio-running";
    if (!active) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void pollSnapshot();
    }, 2000);
    return () => {
      clearInterval(id);
    };
  }, [phase, pollSnapshot]);

  function push(item: Omit<FeedItem, "key" | "ts">): void {
    setFeed((prev) => [...prev, { ...item, key: nextKey(), ts: Date.now() }]);
  }

  async function runDraft(): Promise<void> {
    if (brief.trim().length < 4) return;
    setPhase("drafting");
    setDraftResult(null);
    push({ kind: "info", text: "Draft: planning + 3× t2v + ffmpeg compose..." });
    try {
      const res = await fetch(`/api/projects/${storeId}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      const data = (await res.json()) as DraftResponse & { error?: string };
      if (!res.ok || data.error) {
        push({ kind: "error", text: data.error ?? "draft_failed" });
        setPhase("idle");
        return;
      }
      setDraftResult(data);
      push({
        kind: "info",
        text: `Draft done in ${(data.wallMs / 1000).toFixed(1)}s (model=${data.modelUsed})`,
      });
    } catch (err) {
      push({ kind: "error", text: err instanceof Error ? err.message : "draft_failed" });
    } finally {
      setPhase("idle");
    }
  }

  function attachStream(sid: string): void {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    const es = new EventSource(`/api/projects/${storeId}/studio/${sid}/events`);
    esRef.current = es;
    setPhase("studio-running");

    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as {
          type: string;
          text?: string;
          toolName?: string;
          input?: Record<string, unknown>;
          content?: string;
          isError?: boolean;
          stopReason?: string;
        };
        switch (event.type) {
          case "agent.thinking":
            push({ kind: "thinking", text: "(thinking)" });
            break;
          case "agent.message":
            push({ kind: "message", text: event.text ?? "" });
            break;
          case "agent.tool_use": {
            const args = event.input ? truncate(JSON.stringify(event.input)) : "";
            push({
              kind: "tool_use",
              text: event.toolName ?? "tool",
              meta: args,
            });
            // Capture upload_file URL if visible
            const input = event.input ?? {};
            const maybeUrl =
              typeof input.url === "string"
                ? input.url
                : typeof input.file_url === "string"
                  ? input.file_url
                  : null;
            if (event.toolName?.includes("upload") && maybeUrl) {
              setStudioMp4Url(maybeUrl);
            }
            break;
          }
          case "agent.tool_result":
            push({
              kind: "tool_result",
              text: event.isError ? "(error)" : "(ok)",
              meta: truncate(event.content ?? ""),
            });
            // Try to capture an mp4 url from any tool result
            if (event.content) {
              const m = event.content.match(/https?:\/\/\S+\.mp4\b/);
              if (m) setStudioMp4Url(m[0]);
            }
            break;
          case "session.status_idle":
            push({
              kind: "status",
              text: `idle (${event.stopReason ?? "end_turn"})`,
            });
            if (event.stopReason === "end_turn") {
              setPhase("studio-idle");
              es.close();
              esRef.current = null;
            }
            break;
          default:
            // ignore noisy types
            break;
        }
      } catch {
        // ignore
      }
    };
    es.onopen = () => {
      console.log("[stream] open", sid);
      push({ kind: "info", text: `stream open · ${sid.slice(0, 16)}…` });
    };
    es.onerror = (ev) => {
      console.error("[stream] error", ev, "readyState=", es.readyState);
      push({
        kind: "error",
        text: `stream error (readyState=${es.readyState})${es.readyState === 2 ? " — closed" : ""}`,
      });
    };
  }

  async function runStudio(): Promise<void> {
    if (brief.trim().length < 4) return;
    setFeed([]);
    setStudioMp4Url(null);
    push({ kind: "info", text: "Studio: creating session..." });
    try {
      const res = await fetch(`/api/projects/${storeId}/studio`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      const data = (await res.json()) as { sessionId?: string; error?: string };
      if (!res.ok || !data.sessionId) {
        push({ kind: "error", text: data.error ?? "studio_failed" });
        return;
      }
      setSessionId(data.sessionId);
      push({ kind: "info", text: `session ${data.sessionId}` });
      attachStream(data.sessionId);
    } catch (err) {
      push({ kind: "error", text: err instanceof Error ? err.message : "studio_failed" });
    }
  }

  async function sendFollowup(): Promise<void> {
    console.log("[followup] click", {
      sessionId,
      contentLen: followup.length,
      phase,
    });
    if (!sessionId) {
      push({ kind: "error", text: "followup: no sessionId (try Studio first)" });
      return;
    }
    if (followup.trim().length === 0) return;
    const content = followup;
    setFollowup("");
    push({ kind: "info", text: `→ ${content}` });
    const url = `/api/projects/${storeId}/studio/${sessionId}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const bodyText = await res.text();
      console.log("[followup] POST", url, "→", res.status, bodyText.slice(0, 200));
      if (!res.ok) {
        push({
          kind: "error",
          text: `followup POST ${res.status}: ${bodyText.slice(0, 160) || "(empty body)"}`,
        });
        return;
      }
      push({ kind: "info", text: "followup accepted, reconnecting stream…" });
      attachStream(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "followup_failed";
      console.error("[followup] fetch threw", err);
      push({ kind: "error", text: `followup threw: ${msg}` });
    }
  }

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  const draftFile =
    draftResult?.mp4LocalPath.split("/").pop() ?? snapshot?.draft?.mp4_filename ?? null;

  return (
    <main className="max-w-[64ch] mx-auto p-8 space-y-8 text-base leading-relaxed">
      <a href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
        ← projects
      </a>

      <textarea
        id={briefId}
        aria-label="Brief"
        rows={4}
        className="w-full bg-transparent text-neutral-100 placeholder-neutral-600 focus:outline-none resize-y text-base leading-relaxed"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder="paste a brief…"
      />

      <div className="flex gap-3 items-center">
        <button
          type="button"
          onClick={runDraft}
          disabled={phase !== "idle" || brief.trim().length < 4}
          className="px-3 py-1.5 rounded-full bg-amber-600 hover:bg-amber-500 text-white text-sm disabled:opacity-40"
        >
          {phase === "drafting" ? "Drafting…" : "Draft"}
        </button>
        <button
          type="button"
          onClick={runStudio}
          disabled={phase === "drafting" || brief.trim().length < 4}
          className="px-3 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-40"
        >
          {phase === "studio-running" ? "Studio running…" : "Studio"}
        </button>
        {phase === "drafting" && (
          <span className="text-[11px] text-neutral-500 italic">~30–60s, no live events</span>
        )}
      </div>

      {(draftFile || studioMp4Url || (snapshot && snapshot.shots.length > 0)) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {draftFile && (
            <FullscreenVideo
              label="draft"
              src={`/api/finals/${draftFile}`}
              caption="composed draft"
            />
          )}
          {studioMp4Url && (
            <FullscreenVideo label="studio" src={studioMp4Url} caption="studio upload" />
          )}
          {snapshot?.shots.map((shot) =>
            shot.video_url ? (
              <FullscreenVideo
                key={`shot-${shot.n}`}
                label={`shot ${shot.n}`}
                src={shot.video_url}
                caption={shot.prompt}
              />
            ) : (
              <div key={`shot-${shot.n}`} className="space-y-1">
                <div className="w-full aspect-video rounded bg-neutral-900 grid place-items-center text-xs text-neutral-600">
                  rendering…
                </div>
                <p className="text-[11px] text-neutral-500 line-clamp-2">
                  <span className="text-neutral-400">{shot.n}.</span> {shot.prompt}
                </p>
              </div>
            ),
          )}
        </div>
      )}

      {sessionId && phase !== "studio-running" && (
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span>
            session <span className="font-mono text-neutral-400">{sessionId.slice(0, 16)}…</span>{" "}
            {phase === "studio-idle" ? "(idle)" : "(reconnect to check)"}
          </span>
          <button
            type="button"
            onClick={() => attachStream(sessionId)}
            className="text-emerald-400 hover:text-emerald-300"
          >
            reconnect
          </button>
          <button
            type="button"
            onClick={() => {
              esRef.current?.close();
              esRef.current = null;
              setSessionId(null);
              setFeed([]);
              setStudioMp4Url(null);
              setPhase("idle");
              try {
                localStorage.removeItem(lsKey);
              } catch {
                // ignore
              }
            }}
            className="text-neutral-500 hover:text-neutral-300"
          >
            clear
          </button>
        </div>
      )}

      {agentInfo && (
        <AgentTopology
          info={agentInfo}
          sessionId={sessionId}
          phase={phase}
          storeId={storeId}
          toolCount={feed.filter((f) => f.kind === "tool_use").length}
        />
      )}

      <DreamsPanel storeId={storeId} sessionId={sessionId} />

      {(sessionId || feed.length > 0) && (
        <AgentPanel phase={phase} sessionId={sessionId} feed={feed} />
      )}

      {feed.length > 0 ? (
        <ChatTranscript feed={feed} />
      ) : (
        phase === "idle" &&
        !sessionId && (
          <p className="text-xs text-neutral-500 italic">
            Click <span className="text-emerald-400">Studio</span> to start a live agent session —
            you'll see its thinking, tool calls, and messages here.
          </p>
        )
      )}

      {sessionId && (
        <div className="flex gap-2">
          <input
            id={followupId}
            aria-label="Follow-up"
            type="text"
            value={followup}
            onChange={(e) => setFollowup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendFollowup();
            }}
            placeholder="follow-up…"
            className="flex-1 bg-transparent text-neutral-100 placeholder-neutral-600 focus:outline-none text-sm"
          />
          <button
            type="button"
            onClick={sendFollowup}
            disabled={followup.trim().length === 0}
            className="px-3 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-40"
          >
            Send
          </button>
        </div>
      )}
    </main>
  );
}

type ChatTurn =
  | { kind: "system"; key: string; text: string; tone: "info" | "status" | "error" }
  | { kind: "user"; key: string; text: string }
  | { kind: "thinking"; key: string }
  | { kind: "message"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      name: string;
      args: string | null;
      result: string | null;
      status: "running" | "ok" | "error";
      count: number;
    };

function buildTranscript(feed: FeedItem[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const f of feed) {
    if (f.kind === "info") {
      if (f.text.startsWith("→ ")) {
        turns.push({ kind: "user", key: f.key, text: f.text.slice(2) });
      } else {
        turns.push({ kind: "system", key: f.key, text: f.text, tone: "info" });
      }
    } else if (f.kind === "status") {
      turns.push({ kind: "system", key: f.key, text: f.text, tone: "status" });
    } else if (f.kind === "error") {
      turns.push({ kind: "system", key: f.key, text: f.text, tone: "error" });
    } else if (f.kind === "thinking") {
      const last = turns[turns.length - 1];
      if (!last || last.kind !== "thinking") turns.push({ kind: "thinking", key: f.key });
    } else if (f.kind === "message") {
      turns.push({ kind: "message", key: f.key, text: f.text });
    } else if (f.kind === "tool_use") {
      const last = turns[turns.length - 1];
      if (
        last &&
        last.kind === "tool" &&
        last.name === f.text &&
        last.status !== "running"
      ) {
        last.count += 1;
        last.status = "running";
        last.args = f.meta ?? last.args;
        last.result = null;
      } else {
        turns.push({
          kind: "tool",
          key: f.key,
          name: f.text,
          args: f.meta ?? null,
          result: null,
          status: "running",
          count: 1,
        });
      }
    } else if (f.kind === "tool_result") {
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t && t.kind === "tool" && t.status === "running") {
          t.result = f.meta ?? null;
          t.status = f.text === "(error)" ? "error" : "ok";
          break;
        }
      }
    }
  }
  return turns;
}

function FullscreenVideo({
  label,
  src,
  caption,
}: {
  label: string;
  src: string;
  caption: string;
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement | null>(null);
  function onClick(): void {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  }
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onClick}
        className="block w-full aspect-video rounded bg-black overflow-hidden group relative"
        title="click to fullscreen"
      >
        <video
          ref={ref}
          src={src}
          preload="metadata"
          muted
          playsInline
          className="w-full h-full object-cover"
        />
        <span className="absolute top-1 left-1 text-[10px] uppercase tracking-wide bg-black/70 text-neutral-200 rounded px-1.5 py-0.5">
          {label}
        </span>
        <span className="absolute inset-0 bg-black/0 group-hover:bg-black/30 grid place-items-center transition-colors">
          <span className="opacity-0 group-hover:opacity-100 text-xs text-white">⛶ fullscreen</span>
        </span>
      </button>
      <p className="text-[11px] text-neutral-500 line-clamp-2">{caption}</p>
    </div>
  );
}

function ChatTranscript({ feed }: { feed: FeedItem[] }): React.JSX.Element {
  const turns = buildTranscript(feed);
  return (
    <section className="space-y-3 max-h-[32rem] overflow-y-auto pr-1">
      {turns.map((turn) => {
        if (turn.kind === "system") {
          const tone =
            turn.tone === "error"
              ? "text-red-400"
              : turn.tone === "status"
                ? "text-yellow-400"
                : "text-neutral-500";
          return (
            <div key={turn.key} className={`text-[11px] ${tone} text-center`}>
              {turn.text}
            </div>
          );
        }
        if (turn.kind === "user") {
          return (
            <div key={turn.key} className="flex justify-end">
              <div className="max-w-[80%] bg-emerald-700/80 text-white rounded-2xl rounded-br-sm px-4 py-2 break-words">
                {turn.text}
              </div>
            </div>
          );
        }
        if (turn.kind === "thinking") {
          return (
            <div
              key={turn.key}
              className="flex items-center gap-2 text-[11px] text-neutral-500 italic"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-neutral-600 animate-pulse" />
              thinking…
            </div>
          );
        }
        if (turn.kind === "message") {
          return (
            <div key={turn.key} className="flex justify-start">
              <div className="max-w-[85%] bg-neutral-900 text-neutral-100 rounded-2xl rounded-bl-sm px-4 py-2.5 whitespace-pre-wrap break-words leading-relaxed">
                {turn.text}
              </div>
            </div>
          );
        }
        return <ToolBubble key={turn.key} turn={turn} />;
      })}
    </section>
  );
}

function ToolBubble({
  turn,
}: {
  turn: Extract<ChatTurn, { kind: "tool" }>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const accent =
    turn.status === "error"
      ? "border-red-800/80 bg-red-950/30"
      : turn.status === "ok"
        ? "border-neutral-800 bg-neutral-900/60"
        : "border-blue-800/60 bg-blue-950/30";
  const dot =
    turn.status === "running"
      ? "bg-blue-400 animate-pulse"
      : turn.status === "error"
        ? "bg-red-400"
        : "bg-emerald-400";
  const summary = (() => {
    if (!turn.args) return null;
    try {
      const obj = JSON.parse(turn.args) as Record<string, unknown>;
      if (typeof obj.command === "string") return obj.command;
      const input = obj.input as Record<string, unknown> | undefined;
      if (input && typeof input.prompt === "string") return input.prompt;
      if (typeof obj.path === "string") return obj.path;
    } catch {
      // not JSON; fall through
    }
    return turn.args;
  })();
  return (
    <div className="flex justify-start">
      <div className={`max-w-[85%] w-full border rounded-lg ${accent} text-xs font-mono`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-neutral-900/50 rounded-lg"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
          <span className="text-neutral-200">{turn.name}</span>
          {turn.count > 1 && (
            <span className="text-[10px] font-mono text-neutral-400 bg-neutral-800 rounded px-1">
              ×{turn.count}
            </span>
          )}
          {summary && (
            <span className="text-neutral-500 truncate flex-1 ml-1">
              {summary.length > 80 ? `${summary.slice(0, 80)}…` : summary}
            </span>
          )}
          <span className="text-neutral-600 text-[10px] ml-auto">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="px-3 pb-3 space-y-2 border-t border-neutral-800/60">
            {turn.args && <CodeBlock label="input" raw={turn.args} />}
            {turn.result !== null && (
              <CodeBlock label="result" raw={turn.result || "(no output)"} />
            )}
            {turn.status === "running" && (
              <div className="text-[11px] text-blue-300">running…</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentTopology({
  info,
  sessionId,
  phase,
  storeId,
  toolCount,
}: {
  info: AgentInfo;
  sessionId: string | null;
  phase: Phase;
  storeId: string;
  toolCount: number;
}): React.JSX.Element {
  const sessionActive = phase === "studio-running";
  const sessionDot = sessionActive
    ? "bg-emerald-400 animate-pulse"
    : sessionId
      ? "bg-neutral-500"
      : "bg-neutral-700";
  return (
    <section className="space-y-2 text-sm">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        Claude Managed Agents
      </div>

      {/* Agent */}
      <div className="border border-neutral-800 rounded-lg p-3 space-y-2">
        <Row label="agent" id={info.agent.id} accent="text-amber-300">
          <span className="text-neutral-200">{info.agent.name}</span>
          <span className="text-neutral-500"> · {info.agent.model}</span>
        </Row>
        {info.agent.systemPromptExcerpt && (
          <p className="text-[12px] text-neutral-500 italic line-clamp-2">
            “{info.agent.systemPromptExcerpt}”
          </p>
        )}
        {info.agent.tools.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {info.agent.tools.map((t) => (
              <span
                key={`${t.type}-${t.mcpServer ?? ""}`}
                className="text-[11px] font-mono text-neutral-400 border border-neutral-800 rounded px-1.5 py-0.5"
              >
                {t.mcpServer ? `mcp:${t.mcpServer}` : t.type.replace("_20260401", "")}
              </span>
            ))}
          </div>
        )}

        {/* Environment (nested) */}
        <div className="ml-3 pl-3 border-l border-neutral-800 space-y-2 pt-1">
          <Row label="environment" id={info.environment.id} accent="text-sky-300">
            <span className="text-neutral-500">
              {info.environment.networking.type} · mcp{" "}
              {info.environment.networking.allowMcpServers ? "on" : "off"}
            </span>
          </Row>
          {info.environment.aptPackages.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {info.environment.aptPackages.map((pkg) => (
                <span
                  key={`apt-${pkg}`}
                  className="text-[11px] font-mono text-neutral-400 border border-neutral-800 rounded px-1.5 py-0.5"
                >
                  apt:{pkg}
                </span>
              ))}
            </div>
          )}
          {info.environment.mcpServers.length > 0 && (
            <div className="space-y-0.5">
              {info.environment.mcpServers.map((m) => (
                <div key={`mcp-${m.name}`} className="text-[11px] font-mono text-neutral-500">
                  <span className="text-emerald-300">mcp:{m.name}</span>{" "}
                  <span className="text-neutral-600">→ {m.url}</span>
                </div>
              ))}
            </div>
          )}

          {/* Session (nested) */}
          <div className="ml-3 pl-3 border-l border-neutral-800 space-y-1 pt-1">
            <Row label="session" id={sessionId} accent="text-emerald-300" dot={sessionDot}>
              <span className="text-neutral-500">
                {sessionActive
                  ? "running"
                  : sessionId
                    ? phase === "studio-idle"
                      ? "idle"
                      : "paused"
                    : "—"}
              </span>
            </Row>
            {sessionId && (
              <div className="text-[11px] font-mono text-neutral-500">
                <span className="text-neutral-600">resources:</span> memory_store{" "}
                <span className="text-neutral-400">{storeId.slice(0, 18)}…</span>
                {" · "}
                {toolCount} tool {toolCount === 1 ? "call" : "calls"}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({
  label,
  id,
  accent,
  dot,
  children,
}: {
  label: string;
  id: string | null;
  accent: string;
  dot?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
      <span className={`text-[10px] uppercase tracking-wide ${accent}`}>{label}</span>
      <span className="text-sm">{children}</span>
      {id && (
        <span className="text-[10px] font-mono text-neutral-600 ml-auto">{id.slice(0, 24)}…</span>
      )}
    </div>
  );
}

function formatMaybeJson(raw: string): { pretty: string; isJson: boolean } {
  const trimmed = raw.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return { pretty: raw, isJson: false };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return { pretty: JSON.stringify(parsed, null, 2), isJson: true };
  } catch {
    return { pretty: raw, isJson: false };
  }
}

function highlightJson(src: string): React.JSX.Element[] {
  // Token order matters: strings (incl. keys) first, then numbers, then literals.
  const re =
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g;
  const out: React.JSX.Element[] = [];
  let last = 0;
  let m: RegExpExecArray | null = re.exec(src);
  let i = 0;
  while (m !== null) {
    if (m.index > last) {
      out.push(<span key={`t${i++}`}>{src.slice(last, m.index)}</span>);
    }
    const [token, key, str, num, lit] = m;
    if (key) {
      out.push(
        <span key={`t${i++}`} className="text-sky-300">
          {token}
        </span>,
      );
    } else if (str) {
      out.push(
        <span key={`t${i++}`} className="text-emerald-300">
          {token}
        </span>,
      );
    } else if (num) {
      out.push(
        <span key={`t${i++}`} className="text-amber-300">
          {token}
        </span>,
      );
    } else if (lit) {
      out.push(
        <span key={`t${i++}`} className="text-violet-300">
          {token}
        </span>,
      );
    }
    last = m.index + token.length;
    m = re.exec(src);
  }
  if (last < src.length) {
    out.push(<span key={`t${i++}`}>{src.slice(last)}</span>);
  }
  return out;
}

function CodeBlock({ label, raw }: { label: string; raw: string }): React.JSX.Element {
  const { pretty, isJson } = formatMaybeJson(raw);
  const [copied, setCopied] = useState(false);
  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(pretty);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className="text-[10px] text-neutral-500 hover:text-neutral-200 transition-colors"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="text-[12px] text-neutral-300 whitespace-pre-wrap break-words bg-neutral-900/60 rounded p-2 leading-relaxed">
        {isJson ? highlightJson(pretty) : pretty}
      </pre>
    </div>
  );
}

type ToolCall = {
  key: string;
  name: string;
  meta?: string;
  status: "running" | "ok" | "error";
  ts: number;
  count: number;
};

function deriveToolCalls(feed: FeedItem[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of feed) {
    if (item.kind === "tool_use") {
      const last = calls[calls.length - 1];
      if (last && last.name === item.text) {
        last.count += 1;
        last.status = "running";
        last.meta = item.meta ?? last.meta;
      } else {
        calls.push({
          key: item.key,
          name: item.text,
          meta: item.meta,
          status: "running",
          ts: item.ts,
          count: 1,
        });
      }
    } else if (item.kind === "tool_result") {
      for (let i = calls.length - 1; i >= 0; i--) {
        const c = calls[i];
        if (c && c.status === "running") {
          c.status = item.text === "(error)" ? "error" : "ok";
          break;
        }
      }
    }
  }
  return calls;
}

function phaseLabel(phase: Phase, lastThinking: boolean, runningTools: number): {
  label: string;
  dot: string;
} {
  if (phase === "studio-running") {
    if (runningTools > 0) return { label: "calling tool", dot: "bg-blue-400" };
    if (lastThinking) return { label: "thinking", dot: "bg-amber-400 animate-pulse" };
    return { label: "streaming", dot: "bg-emerald-400 animate-pulse" };
  }
  if (phase === "drafting") return { label: "drafting", dot: "bg-amber-400 animate-pulse" };
  if (phase === "studio-idle") return { label: "idle", dot: "bg-neutral-500" };
  return { label: "ready", dot: "bg-neutral-600" };
}

function toolAccent(name: string): string {
  if (name.includes("fal") || name.includes("submit_job")) return "border-amber-700 text-amber-300";
  if (name.includes("memory") || name.includes("write") || name.includes("read"))
    return "border-blue-800 text-blue-300";
  if (name.includes("upload")) return "border-emerald-800 text-emerald-300";
  return "border-neutral-700 text-neutral-300";
}

function AgentPanel({
  phase,
  sessionId,
  feed,
}: {
  phase: Phase;
  sessionId: string | null;
  feed: FeedItem[];
}): React.JSX.Element {
  const toolCalls = deriveToolCalls(feed);
  const totalToolCalls = toolCalls.reduce((s, c) => s + c.count, 0);
  const runningTools = toolCalls.filter((c) => c.status === "running").length;
  const messages = feed.filter((f) => f.kind === "message").length;
  const errors = feed.filter((f) => f.kind === "error").length;
  const lastThinking = feed.length > 0 && feed[feed.length - 1]?.kind === "thinking";
  const status = phaseLabel(phase, lastThinking, runningTools);
  const lastMessage = [...feed].reverse().find((f) => f.kind === "message");

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${status.dot}`} />
          <span className="text-sm text-neutral-200">{status.label}</span>
          {sessionId && (
            <span className="text-[11px] font-mono text-neutral-500 ml-1">
              {sessionId.slice(0, 16)}…
            </span>
          )}
        </div>
        <div className="flex gap-3 text-[11px] text-neutral-400">
          <span>
            <span className="text-neutral-200">{totalToolCalls}</span> tools
          </span>
          <span>
            <span className="text-neutral-200">{messages}</span> msgs
          </span>
          {errors > 0 && (
            <span className="text-red-400">
              <span className="text-red-300">{errors}</span> errors
            </span>
          )}
        </div>
      </div>

      {toolCalls.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {toolCalls.map((call) => (
            <div
              key={call.key}
              title={call.meta ?? call.name}
              className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] font-mono ${toolAccent(call.name)} ${
                call.status === "running" ? "bg-neutral-900" : "bg-neutral-950/50"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  call.status === "running"
                    ? "bg-current animate-pulse"
                    : call.status === "error"
                      ? "bg-red-400"
                      : "bg-emerald-400"
                }`}
              />
              <span>{call.name}</span>
              {call.count > 1 && (
                <span className="text-[10px] text-neutral-500">×{call.count}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {lastMessage && (
        <p className="text-xs text-neutral-300 line-clamp-3 italic border-l-2 border-neutral-800 pl-2">
          {lastMessage.text}
        </p>
      )}
    </section>
  );
}

type DreamView = {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  model: string | null;
  outputs: Array<{ type: "memory_store"; memory_store_id: string }>;
  sessionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function DreamsPanel({
  storeId,
  sessionId,
}: {
  storeId: string;
  sessionId: string | null;
}): React.JSX.Element {
  const [dreams, setDreams] = useState<DreamView[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState(
    "Distill the brand voice across these ad iterations. Surface recurring shot patterns, color palettes, motion choices, and copy lines that landed. Drop dead-end aesthetics. Output should read like a director's brief usable for a future spot.",
  );
  const [showInstructions, setShowInstructions] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const r = await fetch(`/api/projects/${storeId}/dreams`);
      if (!r.ok) return;
      const data = (await r.json()) as { dreams?: DreamView[] };
      setDreams(data.dreams ?? []);
    } catch {
      // ignore
    } finally {
      setRefreshing(false);
    }
  }, [storeId]);

  // initial fetch once per mount
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActive = dreams.some((d) => d.status === "pending" || d.status === "running");

  // only poll when (a) auto-poll is on AND (b) there's an active dream
  useEffect(() => {
    if (!autoPoll || !hasActive) return;
    const id = setInterval(() => {
      void refresh();
    }, 4000);
    return () => {
      clearInterval(id);
    };
  }, [autoPoll, hasActive, refresh]);

  async function startDream(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { instructions };
      if (sessionId) body.sessionIds = [sessionId];
      const r = await fetch(`/api/projects/${storeId}/dreams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as { dream?: DreamView; error?: string; message?: string };
      if (!r.ok || !data.dream) {
        setError(data.message ?? data.error ?? `HTTP ${r.status}`);
      } else {
        setDreams((prev) => [data.dream as DreamView, ...prev]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "dream_failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(dreamId: string): Promise<void> {
    try {
      await fetch(`/api/projects/${storeId}/dreams/${dreamId}`, { method: "DELETE" });
      void refresh();
    } catch {
      // ignore
    }
  }

  const active = dreams.find((d) => d.status === "pending" || d.status === "running");
  const completed = dreams.filter((d) => d.status === "completed");
  const autoPollId = `${storeId}-autopoll`;

  return (
    <section className="space-y-3 border border-violet-900/40 rounded-lg p-4 bg-violet-950/10">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-violet-300 font-mono">
            ★ Dreams
          </span>
          <span className="text-[10px] text-neutral-500">research preview</span>
        </div>
        <h3 className="text-sm text-neutral-100 font-medium">Distill brand memory while you sleep</h3>
        <p className="text-[12px] text-neutral-400 leading-relaxed">
          A Dream reads this project's memory store + past Studio sessions and writes a
          <span className="text-neutral-200"> new</span> memory store: deduped, organized, with stale
          ideas dropped and recurring patterns surfaced. Use it after several revision rounds to
          crystallize the brand voice — then attach the output store to the next ad and start ahead.
        </p>
        <div className="flex items-center gap-3 text-[11px] text-neutral-500 pt-1">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              id={autoPollId}
              type="checkbox"
              checked={autoPoll}
              onChange={(e) => setAutoPoll(e.target.checked)}
              className="accent-violet-500"
            />
            <span>auto-refresh{hasActive && autoPoll ? " (active)" : ""}</span>
          </label>
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            disabled={refreshing}
            className="text-violet-300 hover:text-violet-200 disabled:opacity-40"
          >
            {refreshing ? "refreshing…" : "refresh now"}
          </button>
          {!autoPoll && hasActive && (
            <span className="text-amber-400">a dream is running — auto-refresh is off</span>
          )}
        </div>
      </header>

      <div className="flex items-start gap-2 flex-wrap">
        <button
          type="button"
          onClick={startDream}
          disabled={busy || active !== undefined}
          className="px-3 py-1.5 rounded-full bg-violet-600 hover:bg-violet-500 text-white text-sm disabled:opacity-40"
        >
          {active ? `Dreaming… (${active.status})` : busy ? "Starting…" : "Dream this project"}
        </button>
        <button
          type="button"
          onClick={() => setShowInstructions((v) => !v)}
          className="text-[11px] text-violet-300 hover:text-violet-200 underline underline-offset-2 py-1.5"
        >
          {showInstructions ? "hide" : "edit"} instructions
        </button>
        {sessionId && (
          <span className="text-[11px] text-neutral-500 py-1.5">
            includes current session{" "}
            <span className="font-mono text-neutral-400">{sessionId.slice(0, 14)}…</span>
          </span>
        )}
      </div>

      {showInstructions && (
        <textarea
          rows={4}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          className="w-full text-[12px] bg-neutral-950 border border-neutral-800 rounded p-2 text-neutral-200 focus:outline-none focus:border-violet-700"
        />
      )}

      {error && <p className="text-[12px] text-red-400">{error}</p>}

      {active && (
        <div className="flex items-center justify-between gap-2 text-[12px] bg-neutral-950/60 rounded p-2 border border-violet-900/40">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse shrink-0" />
            <span className="text-neutral-300">{active.status}</span>
            <span className="font-mono text-[11px] text-neutral-500 truncate">{active.id}</span>
          </div>
          <button
            type="button"
            onClick={() => cancel(active.id)}
            className="text-[11px] text-neutral-500 hover:text-red-400"
          >
            cancel
          </button>
        </div>
      )}

      {completed.length > 0 && (
        <ul className="space-y-1.5">
          {completed.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-2 text-[12px] bg-neutral-950/40 rounded p-2 border border-neutral-800"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-neutral-400 font-mono text-[11px] truncate">{d.id}</span>
                {d.outputs[0] && (
                  <span className="text-[11px] text-neutral-500 truncate">
                    → <span className="text-violet-300">{d.outputs[0].memory_store_id.slice(0, 18)}…</span>
                  </span>
                )}
              </div>
              {d.updatedAt && (
                <span className="text-[10px] text-neutral-600 shrink-0">
                  {new Date(d.updatedAt).toLocaleTimeString()}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {dreams.length === 0 && !busy && (
        <p className="text-[11px] text-neutral-500 italic">
          No dreams yet. Run a few Studio iterations first, then dream to compress what worked into
          a reusable brand memory.
        </p>
      )}
    </section>
  );
}
