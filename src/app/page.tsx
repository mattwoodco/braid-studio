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
    <main className="max-w-3xl mx-auto p-8 space-y-8">
      <h1 className="text-2xl font-bold">braid-studio</h1>
      <p className="text-neutral-400 text-sm">
        Granular video creation. Pick a project or create one.
      </p>
      <NewProjectForm />
      <section>
        <h2 className="text-lg font-semibold mb-3">Projects</h2>
        {projects.length === 0 ? (
          <p className="text-neutral-500 text-sm">No projects yet.</p>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => (
              <li key={p.storeId}>
                <a
                  href={`/projects/${p.storeId}`}
                  className="block border border-neutral-800 rounded p-3 hover:bg-neutral-900"
                >
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-neutral-500">{p.storeId}</div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
