import { headers } from "next/headers";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";

type ProjectRow = { storeId: string; name: string; createdAt?: string };

async function fetchProjects(): Promise<ProjectRow[]> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const res = await fetch(`${proto}://${host}/api/projects`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { projects?: ProjectRow[] };
  return data.projects ?? [];
}

export default async function HomePage(): Promise<React.JSX.Element> {
  const projects = await fetchProjects();
  return (
    <main className="max-w-[64ch] mx-auto p-8 space-y-10 text-base leading-relaxed">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">braid-studio</h1>
        <p className="text-neutral-500">Granular video creation.</p>
      </header>
      <NewProjectForm />
      <section className="space-y-3">
        <h2 className="text-sm uppercase tracking-wide text-neutral-500">Projects</h2>
        {projects.length === 0 ? (
          <p className="text-neutral-500">No projects yet.</p>
        ) : (
          <ul className="space-y-1">
            {projects.map((p) => (
              <li key={p.storeId}>
                <a
                  href={`/projects/${p.storeId}`}
                  className="block py-2 text-neutral-100 hover:text-white"
                >
                  <div className="truncate">{p.name}</div>
                  <div className="text-xs text-neutral-600 font-mono">{p.storeId}</div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
