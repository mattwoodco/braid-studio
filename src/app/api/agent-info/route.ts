import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";

export const dynamic = "force-dynamic";

type McpServer = { type: string; name: string; url: string };
type Tool = { type: string; mcp_server_name?: string };
type AgentYaml = {
  name?: string;
  model?: string;
  environment?: {
    packages?: { apt?: string[] };
    networking?: { type?: string; allow_mcp_servers?: boolean };
  };
  mcp_servers?: McpServer[];
  tools?: Tool[];
  system_prompt?: string;
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

export async function GET(): Promise<Response> {
  let raw: string;
  try {
    raw = await readFile(resolvePath(process.cwd(), "infra", "agent.yaml"), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "agent_yaml_missing", message }, { status: 500 });
  }
  const parsed = parseYaml(raw) as AgentYaml;

  const promptLines = (parsed.system_prompt ?? "").split("\n");
  const firstNonEmpty = promptLines.find((line) => line.trim().length > 0) ?? "";
  const excerpt =
    firstNonEmpty.length > 220 ? `${firstNonEmpty.slice(0, 217)}…` : firstNonEmpty;

  const info: AgentInfo = {
    agent: {
      id: process.env.AGENT_ID ?? null,
      name: parsed.name ?? "unknown",
      model: parsed.model ?? "unknown",
      systemPromptExcerpt: excerpt,
      tools: (parsed.tools ?? []).map((t) => ({
        type: t.type,
        mcpServer: t.mcp_server_name ?? null,
      })),
    },
    environment: {
      id: process.env.ENV_ID ?? process.env.ENVIRONMENT_ID ?? null,
      aptPackages: parsed.environment?.packages?.apt ?? [],
      mcpServers: (parsed.mcp_servers ?? []).map((m) => ({ name: m.name, url: m.url })),
      networking: {
        type: parsed.environment?.networking?.type ?? "unknown",
        allowMcpServers: parsed.environment?.networking?.allow_mcp_servers ?? false,
      },
    },
    vault: { id: process.env.VAULT_ID ?? null },
  };

  return Response.json(info, { headers: { "Cache-Control": "no-store" } });
}
