"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";

export function NewProjectForm(): React.JSX.Element {
  const router = useRouter();
  const nameId = useId();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (name.trim().length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = (await res.json()) as { storeId?: string; error?: string };
      if (!res.ok || !data.storeId) {
        setError(data.error ?? "failed");
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
    <form onSubmit={onSubmit} className="flex gap-2 items-end">
      <div className="flex-1">
        <label htmlFor={nameId} className="block text-sm text-neutral-400 mb-1">
          New project
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Coffee Q3"
          className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100"
          disabled={loading}
        />
      </div>
      <button
        type="submit"
        className="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded text-white disabled:opacity-50"
        disabled={loading || name.trim().length === 0}
      >
        {loading ? "Creating..." : "Create"}
      </button>
      {error && <span className="text-red-400 text-sm">{error}</span>}
    </form>
  );
}
