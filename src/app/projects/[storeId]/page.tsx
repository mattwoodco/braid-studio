"use client";
import { use, useEffect, useId, useRef, useState } from "react";

type Phase = "idle" | "drafting" | "studio-running" | "studio-idle";

type FeedItem = {
  key: string;
  kind: "info" | "thinking" | "message" | "tool_use" | "tool_result" | "status" | "error";
  text: string;
  meta?: string;
  ts: number;
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
  const [followup, setFollowup] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [draftResult, setDraftResult] = useState<DraftResponse | null>(null);
  const [studioMp4Url, setStudioMp4Url] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

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
    es.onerror = () => {
      push({ kind: "error", text: "stream connection lost" });
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
    if (!sessionId || followup.trim().length === 0) return;
    const content = followup;
    setFollowup("");
    push({ kind: "info", text: `→ ${content}` });
    try {
      const res = await fetch(`/api/projects/${storeId}/studio/${sessionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        push({ kind: "error", text: "followup failed" });
        return;
      }
      attachStream(sessionId);
    } catch (err) {
      push({ kind: "error", text: err instanceof Error ? err.message : "followup_failed" });
    }
  }

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  return (
    <main className="max-w-4xl mx-auto p-6 space-y-6">
      <a href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← projects
      </a>
      <div>
        <label htmlFor={briefId} className="block text-sm text-neutral-400 mb-1">
          Brief
        </label>
        <textarea
          id={briefId}
          rows={3}
          className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="15-second ad for a coffee shop: sunrise, espresso, couple at window..."
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={runDraft}
          disabled={phase !== "idle" || brief.trim().length < 4}
          className="px-4 py-2 rounded bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40"
        >
          {phase === "drafting" ? "Drafting..." : "Draft (~48s)"}
        </button>
        <button
          type="button"
          onClick={runStudio}
          disabled={phase === "drafting" || brief.trim().length < 4}
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
        >
          {phase === "studio-running" ? "Studio running..." : "Studio (~5 min)"}
        </button>
      </div>

      {draftResult && (
        <section className="border border-neutral-800 rounded p-4 space-y-2">
          <h3 className="font-semibold">Draft result</h3>
          <p className="text-xs text-neutral-400 break-all">{draftResult.mp4LocalPath}</p>
          <p className="text-xs text-neutral-500">
            {(draftResult.fileBytes / 1024).toFixed(0)} KB ·{" "}
            {draftResult.durationSeconds.toFixed(2)}s · wall{" "}
            {(draftResult.wallMs / 1000).toFixed(1)}s
          </p>
        </section>
      )}

      {studioMp4Url && (
        <section className="border border-neutral-800 rounded p-4 space-y-2">
          <h3 className="font-semibold">Studio mp4</h3>
          <video controls src={studioMp4Url} className="w-full max-h-96" />
          <p className="text-xs text-neutral-500 break-all">{studioMp4Url}</p>
        </section>
      )}

      {feed.length > 0 && (
        <section className="border border-neutral-800 rounded p-4 space-y-1 max-h-96 overflow-y-auto text-sm font-mono">
          {feed.map((f) => (
            <div key={f.key} className="flex gap-2">
              <span
                className={
                  f.kind === "thinking"
                    ? "text-neutral-500 italic"
                    : f.kind === "message"
                      ? "text-neutral-100"
                      : f.kind === "tool_use"
                        ? "text-blue-400"
                        : f.kind === "tool_result"
                          ? "text-emerald-400"
                          : f.kind === "status"
                            ? "text-yellow-400"
                            : f.kind === "error"
                              ? "text-red-400"
                              : "text-neutral-400"
                }
              >
                [{f.kind}]
              </span>
              <span className="flex-1 break-words">
                {f.text}
                {f.meta ? <span className="text-neutral-500"> · {f.meta}</span> : null}
              </span>
            </div>
          ))}
        </section>
      )}

      {sessionId && (
        <div className="space-y-2">
          <label htmlFor={followupId} className="block text-sm text-neutral-400">
            Follow-up
          </label>
          <div className="flex gap-2">
            <input
              id={followupId}
              type="text"
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
              placeholder='e.g. "regenerate shot 2 with cooler tone"'
              className="flex-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100"
            />
            <button
              type="button"
              onClick={sendFollowup}
              disabled={followup.trim().length === 0}
              className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
