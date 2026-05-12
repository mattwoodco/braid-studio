# Run Claude with DeepSeek backend

Copy and paste the block below into your terminal.

```sh
#!/bin/sh
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=sk-secret
export ANTHROPIC_MODEL=deepseek-v4-flash
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
exec claude --dangerously-skip-permissions "$@"
```

## One-liner

```sh
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ANTHROPIC_AUTH_TOKEN=sk-secret ANTHROPIC_MODEL=deepseek-v4-flash CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude --dangerously-skip-permissions
```

Replace `sk-secret` with your actual DeepSeek API key before running.
