# Tech — braid-studio TDD ledger extension

> Revised after Phase 1 specialist review. Section "Revisions vs. v0" at the
> bottom records what changed and why.

## Stack (inherited, unchanged)

- Runtime: Bun 1.3.x
- Framework: Next.js 16 (App Router) — touched only via SSE event consumption
- Agent platform: Anthropic Managed Agents (`@anthropic-ai/sdk`)
- Video model: fal MCP → `fal-ai/ltx-2.3/text-to-video/fast`
- Compose: `ffmpeg` (apt package in the agent container; system `ffmpeg`
  locally for `composeClips` in `src/lib/ffmpeg.ts`)
- Validation: zod 4
- Lint/format: biome 1.9

**Zero new dependencies.**

## Files this buildout touches

| Path                              | Action  | Reason                                    |
|-----------------------------------|---------|-------------------------------------------|
| `scripts/acceptance.ts`           | extend  | Add assertion table, ledger emission, `--report` |
| `src/lib/anthropic.ts`            | extend  | Add `span.*` cases to `mapIncomingEvent`; preserve `usage`, `stop_reason` payload, `tool_result` content |
| `infra/agent.yaml`                | extend  | (Future phases) prompt-side feature work  |
| `docs/PERF_LOG.md`                | create  | Append-only findings log                  |
| `docs/product.md`                 | create  | Buildout scope record                     |
| `docs/tech.md`                    | create  | This file                                 |
| `docs/inspiration-vision.md`      | create  | Principles                                |
| `docs/sentinel.log`               | create  | Watcher log                               |
| `data/perf/<run-id>.ndjson`       | create  | Ledger entries (gitignored)               |
| `.gitignore`                      | extend  | Add `data/perf/`                          |

**No new files under `src/`.** One existing src file (`src/lib/anthropic.ts`)
gets extended to widen the event seam — this is unavoidable; the harness
can't measure what the SSE consumer drops.

## Seam-widening (Phase 2 prerequisite)

The current SSE consumer in `scripts/acceptance.ts:128-145` projects events
down to `{ type, stopReason, toolName, text }`. Three fields the ledger
needs are present in the raw event but lost in projection:

1. **`input` on tool-use events** (`src/lib/anthropic.ts:458-470`). Already
   passed through as `Record<string, unknown>`. `streamUntilIdle` must
   collect `{ toolName, input.prompt, input.negative_prompt }` into a
   per-run `toolUses[]` attached to `RunContext`. Required by V1, V2, V3,
   V6 assertions.

2. **`span.*` events** (`src/lib/anthropic.ts:445-497`). Currently fall
   through to `type: "other"` with no extraction. Add cases for
   `span.model_request_end` (extract `usage.input_tokens`,
   `usage.output_tokens`, `usage.cache_read_input_tokens`,
   `usage.cache_creation_input_tokens`) and `span.mcp_tool_use_end` (extract
   per-call wall_ms, fal model id, cost where reported). Required by every
   row's `tokens` and `fal_jobs[]` fields.

3. **`session.status_idle.stop_reason`** (`src/lib/anthropic.ts:490-494`).
   Currently flattened to a string. Preserve the full payload so
   `requires_action` cases keep their `actions[]` array. Required by error
   surfacing and by V4's two-pass refinement signal.

4. **`agent.tool_result` content** — currently not captured. Capture for
   `submit_job` and `check_job` results so the harness can correlate a
   fal `video.url` to the shot it backs without re-reading memory.

## Ledger schema (T2) — revised

Append-only NDJSON, one file per acceptance run at
`data/perf/<run-id>.ndjson`. **One row per `(lane, assertion)` pair**, plus
one row-per-lane summary. Storage is cheap; joins later are expensive.

### Lane-summary row

```json
{
  "kind": "lane",
  "run_id": "2026-05-11T14-22-03Z-a1b2",
  "ts": "2026-05-11T14:22:03.123Z",
  "lane": "studio",
  "git_sha": "<repo HEAD at run time>",
  "agent_yaml_sha256": "<hash of infra/agent.yaml at run time>",
  "agent_revision_id": "<from createSession response>",
  "agent_id": "<env AGENT_ID>",
  "session_id": "<from createSession>",
  "brief_sha256": "<hash of the brief string used>",
  "model": "claude-sonnet-4-5",
  "wall_ms": 240123,
  "ttft_ms": 1820,
  "tokens": {
    "in": 0,
    "out": 0,
    "cache_read": 0,
    "cache_creation": 0
  },
  "est_cost_usd": 0.72,
  "cost_breakdown": {
    "agent_usd": 0.04,
    "fal_usd": 0.68,
    "fal_jobs": 3
  },
  "fal_jobs": [
    {
      "shot_idx": 1,
      "model": "fal-ai/ltx-2.3/text-to-video/fast",
      "wall_ms": 38000,
      "cost_usd": 0.24,
      "prompt_sha256": "<hash of input.prompt>"
    }
  ],
  "shot_count": 3,
  "template": "hook-build-payoff",
  "stop_reason": { "type": "end_turn" },
  "always_validate": {
    "manifest_schema": "pass",
    "shot_grammar":    "pass",
    "ffprobe":         "pass"
  },
  "error": null
}
```

### Assertion row

```json
{
  "kind": "assertion",
  "run_id": "2026-05-11T14-22-03Z-a1b2",
  "ts": "2026-05-11T14:22:03.123Z",
  "lane": "studio",
  "assertion_id": "V6.negative_prompt",
  "status": "pass" | "fail" | "skipped",
  "observed": "negative_prompt absent on 3/3 submit_job calls",
  "expected": "non-empty string on every submit_job call",
  "evidence_event_ids": ["evt_…"]
}
```

Notes:
- `agent_yaml_sha256 + git_sha + brief_sha256` is the join key for T3's
  Δ-by-prompt-change comparison. Without `brief_sha256`, "score went up"
  can be hidden by accidentally easier briefs.
- `tokens.cache_read` is the single biggest variable in real cost on
  Sonnet 4.5; including `cache_read` and `cache_creation` separately makes
  `est_cost_usd` auditable.
- `assertions[]` was **not** inlined into the lane row — separate rows let
  T3 build a per-assertion trend column without re-parsing arrays.
- `status: "skipped"` is reserved for assertions that cannot evaluate
  because their input is missing (e.g. no `mcp_tool_use` events to grade
  prompt grammar). Schema failure does NOT skip downstream feature
  assertions — they run and fail loudly so regressions are visible.

## Assertion harness (T1) — revised

```ts
type Assertion = {
  id: string;                    // e.g. "V1.grammar"
  lane: Lane;
  evaluate: (ctx: RunContext) => Promise<AssertionResult>;
  target_phase: string | null;   // "phase-2" | null (informational only)
};

type AssertionResult = {
  status: "pass" | "fail" | "skipped";
  observed: string;
  expected: string;
  evidence_event_ids?: string[];
};
```

`target_phase` is metadata for `--report` to filter "expected to be red
this week" without polluting pass-rate. There is **no** `expected_status`
field — that was Phase-1 review feedback: encoding "supposed to fail" as
a row property turns the ledger into a vibes document.

## Trend report (T3)

`bun scripts/acceptance.ts --report` does three things, in one ASCII pane:

1. **Per-lane medians (last 7d vs prior 7d):** `wall_ms`, `ttft_ms`,
   `est_cost_usd`, `tokens.cache_read / tokens.in` (cache hit rate).
2. **Per-assertion pass-rate** grouped by `agent_yaml_sha256`, so a prompt
   change either flips a column green or leaves the column red.
3. **`fal_jobs[]` per-shot wall_ms** to localize regressions to a single
   shot — e.g. "studio +30s came entirely from shot 2."

Implementation budget: ~50 LOC of straight NDJSON read + `Map`-reduce.

## Always-validate (Phase 4) — revised

Three checks. They populate `always_validate` in the lane-summary row but
**do not gate feature assertions**:

1. **Manifest schema** — zod parse of `/memory/final.json`.
2. **Shot-prompt grammar** — regex match on every `mcp_tool_use`
   `input.prompt` captured by the widened seam.
3. **Output probe** — `ffprobe` on the final mp4: duration > 14s, codec
   h264, audio track when audio is requested.

If a check fails, that row is recorded as `fail`. Feature assertions in
the same lane still run; assertions whose input is genuinely absent record
`skipped` with a reason in `observed`.

## First red rows (order-of-ops)

Per solution-architect review, the first ledger commits are:

1. **Always-validate #2, restricted to "every `submit_job` has a non-empty
   `prompt`."** Green-on-arrival. Proves the widened seam works.
2. **V6 — `negative_prompt non-empty`.** Red on arrival because nothing in
   `infra/agent.yaml:21-75` instructs the agent to populate it. Green flip
   is a one-line prompt edit. **This is the canonical first red→green
   ledger commit.**

S1 (template enum) and S3 (voice tokens) are deferred until after V6 —
they require the agent to *write* a new memory field, which conflates
"prompt edit" with "assertion edit" in one commit and hides which side
moved the trend.

S3 specifically requires a prior prompt change that has the agent write
`/memory/style_tokens.json` (3 chosen tokens with provenance), so the
harness has an oracle. Without that, the assertion is unfalsifiable.

## Env vars (inherited, unchanged)

`ANTHROPIC_API_KEY`, `FAL_API_KEY`, `AGENT_ID`, `ENV_ID`, `VAULT_ID`.
No new env vars.

## Revisions vs. v0

Removed:
- `expected_status: "red"|"green"` field on assertion rows. Replaced with
  a separate `target_phase` metadata field on the assertion *definition*,
  not the result. Reason: encoding "this is supposed to fail" as run
  metadata poisons T3 pass-rate.
- Always-validate "skip every feature assertion if a check fails." Reason:
  masks real feature regressions.

Added:
- `git_sha`, `agent_revision_id`, `session_id`, `brief_sha256` on lane row.
- `tokens.cache_read`, `tokens.cache_creation`.
- `cost_breakdown: { agent_usd, fal_usd, fal_jobs }`.
- `fal_jobs[]` per-shot span data.
- `ttft_ms` (time-to-first-token).
- Separate `kind: "assertion"` rows alongside `kind: "lane"` rows.
- Explicit "seam-widening" section listing the four `src/lib/anthropic.ts`
  extensions Phase 2 cannot proceed without.

Sources for the schema refinements: Braintrust trace schema, Inspect AI
log schema, Promptfoo assertion model, Anthropic's evals guide, VBench's
dimension-decomposition pattern. (Full URLs in `docs/sentinel.log` Phase
1 entry.)
