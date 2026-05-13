"use client";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

function deriveName(brief: string): string {
  const lines = brief
    .split("\n")
    .map((line) => line.replace(/[*_`#>~]/g, "").replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  const meaningful =
    lines.find((line) => line.length >= 16 && !/^shot\s*\d+$/i.test(line)) ?? lines[0] ?? "";
  if (!meaningful) return "Untitled";
  return meaningful.length > 80 ? `${meaningful.slice(0, 77).trimEnd()}…` : meaningful;
}

export function NewProjectForm(): React.JSX.Element {
  const router = useRouter();
  const briefId = useId();
  const [brief, setBrief] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (brief.trim().length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: deriveName(brief), brief: brief.trim() }),
      });
      const text = await res.text();
      let data: { storeId?: string; error?: string; message?: string } = {};
      try {
        data = text ? (JSON.parse(text) as typeof data) : {};
      } catch {
        // non-JSON body — leave data empty so we fall through to the error path
      }
      if (!res.ok || !data.storeId) {
        const detail = data.message ?? data.error ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
        setError(`create failed: ${detail}`);
        return;
      }
      router.push(`/projects/${data.storeId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <textarea
        id={briefId}
        aria-label="Brief"
        rows={5}
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        placeholder="paste a brief…"
        maxLength={4000}
        className="w-full bg-transparent text-neutral-100 placeholder-neutral-600 focus:outline-none resize-y text-sm leading-relaxed"
        disabled={loading}
      />
      <div className="flex gap-3 items-center">
        <button
          type="submit"
          className="bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded-full text-white text-sm disabled:opacity-40"
          disabled={loading || brief.trim().length === 0}
        >
          {loading ? "Creating…" : "Create"}
        </button>
        <span className="text-[11px] text-neutral-500 truncate">
          {brief.trim() ? deriveName(brief) : `${brief.length}/4000`}
        </span>
        {error && <span className="text-red-400 text-xs">{error}</span>}
      </div>
    </form>
  );
}
