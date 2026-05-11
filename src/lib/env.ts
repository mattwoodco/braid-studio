/**
 * Environment variable schema. Validates at module load.
 *
 * The full set of vars is required for the Studio lane. The Draft lane only
 * needs ANTHROPIC_API_KEY + FAL_API_KEY; setup.ts only needs ANTHROPIC_API_KEY.
 * To keep things simple and fail-fast, we validate everything at first import
 * but allow callers (setup.ts, acceptance) to import a partial schema if needed.
 */
import { z } from "zod";

const FullEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY missing"),
  FAL_API_KEY: z.string().min(1, "FAL_API_KEY missing"),
  AGENT_ID: z.string().min(1, "AGENT_ID missing (run `bun infra/setup.ts`)"),
  ENV_ID: z.string().min(1, "ENV_ID missing (run `bun infra/setup.ts`)"),
  VAULT_ID: z.string().min(1, "VAULT_ID missing (run `bun infra/setup.ts`)"),
});

export type Env = z.infer<typeof FullEnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;
  const parsed = FullEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.message).join("; ");
    throw new Error(`[env] invalid environment: ${missing}`);
  }
  _env = parsed.data;
  return _env;
}

// Partial schema for setup.ts (which provisions the IDs).
const SetupEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  FAL_API_KEY: z.string().min(1),
});

export function getSetupEnv(): z.infer<typeof SetupEnvSchema> {
  const parsed = SetupEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `[env] setup needs ANTHROPIC_API_KEY and FAL_API_KEY in .env.local`,
    );
  }
  return parsed.data;
}
