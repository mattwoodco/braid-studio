# braid-studio

A granular video creation tool for marketers. Two lanes:

- **Draft** (~48s): one Claude call plans N shots; parallel fal text-to-video; local ffmpeg compose. No agent, no session.
- **Studio** (~5 min): Anthropic Managed Agent runs inside a sandbox container with apt-installed ffmpeg and the fal MCP server. Persistent memory store; granular per-shot retries via follow-up `user.message`.

## Setup

1. Symlink `.env.local` from the sibling `braid` repo (inherits `ANTHROPIC_API_KEY`, `FAL_API_KEY`):

   ```
   ln -s ../braid/.env.local .env.local
   ```

2. Install deps:

   ```
   bun install
   ```

3. Provision the agent, environment, and vault:

   ```
   bun run setup
   ```

   This is idempotent and appends `AGENT_ID`, `ENV_ID`, `VAULT_ID` to `.env.local`.

## Run

```
bun run dev
```

## Acceptance

```
bun run acceptance
```

Hits real Anthropic + fal. Produces mp4s under `data/finals/`.
