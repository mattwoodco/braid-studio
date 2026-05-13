import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BriefCheckpoint } from "@/lib/checkpoint";

export const dynamic = "force-dynamic";

type WebhookEvent = {
  type: string;
  id: string;
  created_at: string;
  data: { type: string; id: string; organization_id?: string; workspace_id?: string };
};

async function readRecentEvents(n: number): Promise<WebhookEvent[]> {
  const file = join(process.cwd(), "data", "webhooks", "events.jsonl");
  try {
    const txt = await readFile(file, "utf8");
    const lines = txt.trim().split("\n").filter((l) => l.length > 0);
    const events = lines
      .map((l) => {
        try {
          return JSON.parse(l) as WebhookEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is WebhookEvent => e !== null);
    return events.slice(-n).reverse();
  } catch {
    return [];
  }
}

async function readCheckpoints(): Promise<BriefCheckpoint[]> {
  const dataDir = join(process.cwd(), "data");
  const checkpoints: BriefCheckpoint[] = [];
  try {
    const pattern = join(dataDir, "**", "checkpoint.json");
    for await (const file of glob(pattern)) {
      try {
        const txt = await readFile(file, "utf8");
        checkpoints.push(JSON.parse(txt) as BriefCheckpoint);
      } catch {
      }
    }
  } catch {
  }
  checkpoints.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return checkpoints;
}

function statusBadge(status: string): string {
  if (status === "done") return "✓ done";
  if (status === "in_progress") return "⟳ running";
  if (status === "skipped") return "— skipped";
  return "· pending";
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { hour12: false });
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const [events, checkpoints] = await Promise.all([
    readRecentEvents(50),
    readCheckpoints(),
  ]);

  const lastEventByBrief = new Map<string, WebhookEvent>();
  for (const ev of events) {
    const bId = ev.data.id;
    if (!lastEventByBrief.has(bId)) lastEventByBrief.set(bId, ev);
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="refresh" content="5" />
        <title>Braid Sentinel Dashboard</title>
        <style>{`
          body { font-family: monospace; font-size: 13px; background: #0d0d0d; color: #ccc; margin: 0; padding: 16px; }
          h1 { font-size: 16px; color: #eee; margin-bottom: 8px; }
          h2 { font-size: 13px; color: #888; margin: 24px 0 6px; text-transform: uppercase; letter-spacing: .06em; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
          th { text-align: left; color: #666; padding: 4px 10px 4px 0; border-bottom: 1px solid #222; }
          td { padding: 4px 10px 4px 0; border-bottom: 1px solid #1a1a1a; vertical-align: top; }
          .done { color: #4caf50; }
          .running { color: #ff9800; }
          .pending { color: #555; }
          .skipped { color: #777; }
          .id { color: #888; }
          .empty { color: #444; font-style: italic; }
        `}</style>
      </head>
      <body>
        <h1>Braid Sentinel Dashboard</h1>
        <p style={{ color: "#555", margin: "0 0 16px" }}>
          Auto-refreshes every 5 s &mdash; {new Date().toLocaleString("en-US", { hour12: false })}
        </p>

        <h2>Briefs ({checkpoints.length})</h2>
        {checkpoints.length === 0 ? (
          <p className="empty">No checkpoints found in data/</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Brief ID</th>
                <th>Store</th>
                <th>Phase A</th>
                <th>Phase B</th>
                <th>Phase C</th>
                <th>Updated</th>
                <th>Last Event</th>
              </tr>
            </thead>
            <tbody>
              {checkpoints.map((cp) => {
                const lastEv = lastEventByBrief.get(cp.briefId);
                return (
                  <tr key={cp.briefId}>
                    <td className="id">{cp.briefId}</td>
                    <td className="id">{cp.storeId}</td>
                    <td>{statusBadge(cp.phaseA.status)}</td>
                    <td>{statusBadge(cp.phaseB.status)}</td>
                    <td>{statusBadge(cp.phaseC.status)}</td>
                    <td>{fmt(cp.updatedAt)}</td>
                    <td>{lastEv ? `${lastEv.data.type} @ ${fmt(lastEv.created_at)}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <h2>Recent Webhook Events ({events.length})</h2>
        {events.length === 0 ? (
          <p className="empty">No events received yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event ID</th>
                <th>Type</th>
                <th>Resource ID</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td className="id">{ev.id}</td>
                  <td>{ev.data.type}</td>
                  <td className="id">{ev.data.id}</td>
                  <td>{fmt(ev.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </body>
    </html>
  );
}
