#!/usr/bin/env bun
/**
 * One-shot provisioning for braid-studio.
 *
 * Find-or-create:
 *   - Environment "braid-studio-env" with apt:[ffmpeg, imagemagick], limited
 *     networking + allow_mcp_servers.
 *   - Vault "braid-studio-vault" with a static_bearer credential bound to the
 *     fal MCP server (token = FAL_API_KEY).
 *   - Agent matching the name in infra/agent.yaml ("braid-video-director-v1")
 *     with system_prompt, fal MCP server, agent_toolset_20260401 + mcp_toolset.
 *
 * Appends AGENT_ID, ENV_ID, VAULT_ID to .env.local if missing.
 * Re-runs are idempotent: logs "reused" and skips if env vars already present.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import YAML from "yaml";

const BETA = "managed-agents-2026-04-01";
const REPO_ROOT = resolve(import.meta.dir, "..");
const ENV_PATH = resolve(REPO_ROOT, ".env.local");
const AGENT_YAML_PATH = resolve(REPO_ROOT, "infra/agent.yaml");

const ENVIRONMENT_NAME = "braid-studio-env";
const VAULT_NAME = "braid-studio-vault";
const FAL_MCP_URL = "https://mcp.fal.ai/mcp";

const log = (m: string): void => {
  process.stdout.write(`[setup] ${m}\n`);
};

interface AgentYaml {
  name: string;
  model: string;
  system_prompt: string;
}

function loadAgentYaml(): AgentYaml {
  const text = readFileSync(AGENT_YAML_PATH, "utf8");
  const parsed: unknown = YAML.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("agent.yaml: top-level value is not an object");
  }
  const rec = parsed as Record<string, unknown>;
  const name = rec.name;
  const model = rec.model;
  const system_prompt = rec.system_prompt;
  if (typeof name !== "string" || name.length === 0)
    throw new Error("agent.yaml: name");
  if (typeof model !== "string" || model.length === 0)
    throw new Error("agent.yaml: model");
  if (typeof system_prompt !== "string" || system_prompt.length === 0)
    throw new Error("agent.yaml: system_prompt");
  return { name, model, system_prompt };
}

function readEnvText(): string {
  if (!existsSync(ENV_PATH)) return "";
  return readFileSync(ENV_PATH, "utf8");
}

function hasEnvKey(key: string): boolean {
  return new RegExp(`^${key}=`, "m").test(readEnvText());
}

function getEnvValue(key: string): string | null {
  const m = readEnvText().match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? (m[1] ?? null) : null;
}

function appendEnvIfMissing(key: string, value: string): "appended" | "kept" {
  if (hasEnvKey(key)) return "kept";
  const text = readEnvText();
  const lead = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(ENV_PATH, `${lead}${key}=${value}\n`);
  return "appended";
}

interface NamedItem {
  id: string;
  name?: string;
  display_name?: string;
}

async function findByField<T extends NamedItem>(
  iter: AsyncIterable<T>,
  field: "name" | "display_name",
  value: string,
): Promise<T | null> {
  for await (const item of iter) {
    if (item[field] === value) return item;
  }
  return null;
}

async function ensureEnvironment(client: Anthropic): Promise<string> {
  const envs = (
    client as unknown as {
      beta: {
        environments: {
          create: (p: Record<string, unknown>) => Promise<{ id: string; name: string }>;
          update: (
            id: string,
            p: Record<string, unknown>,
          ) => Promise<{ id: string; name: string }>;
          list: (p?: Record<string, unknown>) => AsyncIterable<{ id: string; name: string }>;
        };
      };
    }
  ).beta.environments;

  const desiredConfig = {
    type: "cloud",
    packages: { type: "packages", apt: ["ffmpeg", "imagemagick"] },
    networking: {
      type: "limited",
      allow_mcp_servers: true,
      allow_package_managers: true,
      allowed_hosts: [
        "fal.media",
        "v2.fal.media",
        "v3.fal.media",
        "*.fal.media",
        "fal.run",
        "*.fal.run",
        "queue.fal.run",
        "rest.alpha.fal.ai",
        "*.fal.ai",
        "mcp.fal.ai",
      ],
    },
  };

  const existing = await findByField(
    envs.list({ betas: [BETA] }),
    "name",
    ENVIRONMENT_NAME,
  );
  if (existing) {
    // Ensure config is correct (idempotent update).
    const updated = await envs.update(existing.id, {
      config: desiredConfig,
      betas: [BETA],
    });
    log(`environment reused + updated: ${updated.id}`);
    return updated.id;
  }
  const created = await envs.create({
    name: ENVIRONMENT_NAME,
    description: "braid-studio: ffmpeg + imagemagick + fal MCP access",
    config: desiredConfig,
    betas: [BETA],
  });
  log(`environment created: ${created.id}`);
  return created.id;
}

async function ensureVault(client: Anthropic, falKey: string): Promise<string> {
  const vaults = (
    client as unknown as {
      beta: {
        vaults: {
          create: (p: Record<string, unknown>) => Promise<{ id: string; display_name: string }>;
          list: (p?: Record<string, unknown>) => AsyncIterable<{
            id: string;
            display_name: string;
          }>;
          credentials: {
            create: (
              vaultId: string,
              params: Record<string, unknown>,
            ) => Promise<{ id: string }>;
            list: (
              vaultId: string,
              params?: Record<string, unknown>,
            ) => AsyncIterable<{ id: string; auth?: { mcp_server_url?: string } }>;
          };
        };
      };
    }
  ).beta.vaults;

  let vaultId: string;
  const existing = await findByField(
    vaults.list({ betas: [BETA] }),
    "display_name",
    VAULT_NAME,
  );
  if (existing) {
    log(`vault reused: ${existing.id}`);
    vaultId = existing.id;
  } else {
    const created = await vaults.create({
      display_name: VAULT_NAME,
      metadata: { braid_studio: "v1" },
      betas: [BETA],
    });
    log(`vault created: ${created.id}`);
    vaultId = created.id;
  }

  // Check for existing fal credential
  let hasFalCred = false;
  for await (const c of vaults.credentials.list(vaultId, { betas: [BETA] })) {
    if (c.auth?.mcp_server_url === FAL_MCP_URL) {
      hasFalCred = true;
      break;
    }
  }
  if (!hasFalCred) {
    await vaults.credentials.create(vaultId, {
      auth: {
        type: "static_bearer",
        token: falKey,
        mcp_server_url: FAL_MCP_URL,
      },
      display_name: "fal-static-bearer",
      betas: [BETA],
    });
    log("vault: fal static_bearer credential created");
  } else {
    log("vault: fal static_bearer credential reused");
  }

  return vaultId;
}

async function ensureAgent(client: Anthropic, agent: AgentYaml): Promise<string> {
  const agents = (
    client as unknown as {
      beta: {
        agents: {
          create: (p: Record<string, unknown>) => Promise<{ id: string; name: string }>;
          list: (p?: Record<string, unknown>) => AsyncIterable<{ id: string; name: string }>;
        };
      };
    }
  ).beta.agents;

  const existing = await findByField(agents.list({ betas: [BETA] }), "name", agent.name);
  if (existing) {
    log(`agent reused: ${existing.id}`);
    return existing.id;
  }
  const created = await agents.create({
    name: agent.name,
    model: agent.model,
    description: "Granular video director for marketers; ffmpeg + fal MCP.",
    system: agent.system_prompt,
    mcp_servers: [{ type: "url", name: "fal", url: FAL_MCP_URL }],
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "fal",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
      },
    ],
    metadata: { braid_studio: "v1" },
    betas: [BETA],
  });
  log(`agent created: ${created.id}`);
  return created.id;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const falKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    process.stderr.write("[setup] ANTHROPIC_API_KEY not set\n");
    process.exit(1);
  }
  if (!falKey) {
    process.stderr.write("[setup] FAL_API_KEY not set\n");
    process.exit(1);
  }

  const agent = loadAgentYaml();
  log(`agent yaml: ${agent.name} (model=${agent.model})`);

  const client = new Anthropic({ apiKey });

  // Each step is independent; if env var already set we still verify against
  // remote in case .env.local was hand-edited.
  let envId: string;
  if (hasEnvKey("ENV_ID")) {
    const existing = getEnvValue("ENV_ID");
    if (existing && existing.length > 0) {
      log(`ENV_ID present (${existing}) — using; not provisioning environment`);
      envId = existing;
    } else {
      envId = await ensureEnvironment(client);
    }
  } else {
    envId = await ensureEnvironment(client);
  }

  let vaultId: string;
  if (hasEnvKey("VAULT_ID")) {
    const existing = getEnvValue("VAULT_ID");
    if (existing && existing.length > 0) {
      log(`VAULT_ID present (${existing}) — using; not provisioning vault`);
      vaultId = existing;
    } else {
      vaultId = await ensureVault(client, falKey);
    }
  } else {
    vaultId = await ensureVault(client, falKey);
  }

  let agentId: string;
  if (hasEnvKey("AGENT_ID")) {
    const existing = getEnvValue("AGENT_ID");
    if (existing && existing.length > 0) {
      log(`AGENT_ID present (${existing}) — using; not provisioning agent`);
      agentId = existing;
    } else {
      agentId = await ensureAgent(client, agent);
    }
  } else {
    agentId = await ensureAgent(client, agent);
  }

  log(`.env.local: ENV_ID ${appendEnvIfMissing("ENV_ID", envId)}`);
  log(`.env.local: VAULT_ID ${appendEnvIfMissing("VAULT_ID", vaultId)}`);
  log(`.env.local: AGENT_ID ${appendEnvIfMissing("AGENT_ID", agentId)}`);
  log("done.");
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `[setup] error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    if (err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  });
}
