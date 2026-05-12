# Product — braid-studio TDD ledger extension

## Who

A single developer (currently: matt@mattwood.co) iterating on the
`infra/agent.yaml` system prompt that drives braid-studio's video-director
Managed Agent. Future: any teammate who edits the prompt.

## Problem

Today, a prompt change is a vibes-only commit. The dev runs `bun acceptance`
once, sees a video, and merges. There is no record of whether the change
made cost go up, wall-time go down, or quality go sideways. After ten such
changes, regressions are invisible.

## Scope (this buildout)

- **T1** Per-feature assertion rows (S1–S4, V1–V6) wired into `acceptance.ts`.
- **T2** Append-only ledger at `data/perf/<run-id>.json` (one line per lane).
- **T3** `--report` flag that prints per-lane medians and Δ vs prior week.
- **T4** `docs/PERF_LOG.md` — append-only narrative for each prompt change
  that flipped a red row to green.
- **Always-validate** three checks (schema, prompt grammar, ffprobe) that
  gate every acceptance run regardless of feature flag.

## Out of scope

- Script-variation / video-technique prompt changes themselves (S1–S4,
  V1–V6 in NEXT_STEPS). Those land *after* the ledger so each one is
  measurable on day one.
- UI changes (NEXT_STEPS #1–#9).
- New MCP server attachments (#10).

## Success criteria

1. `bun scripts/acceptance.ts` writes a new `data/perf/<run-id>.ndjson` on
   every run, even on failure. NDJSON with separate `kind: "lane"` and
   `kind: "assertion"` rows (see `docs/tech.md`).
2. `bun scripts/acceptance.ts --report` prints the trend table in <1s and
   groups Δ by `agent_yaml_sha256` (not by date).
3. At least one red assertion row exists at merge time (V6 negative_prompt
   is the canonical first red), so the ledger has something to flip green.
4. `docs/PERF_LOG.md` has one entry per merged prompt change going forward.
5. No new files under `src/`. One existing src file
   (`src/lib/anthropic.ts`) gets extended to widen the SSE event seam —
   unavoidable per Phase 1 review.

## Canonical first red→green commit

Per Phase 1 review, the first measurable ledger commit is **V6
(`negative_prompt` non-empty on every `submit_job`)**. It is red today
because nothing in `infra/agent.yaml:21-75` instructs the agent to populate
the field. A one-line prompt edit flips it green. That commit is the
proof the harness is doing its job.

## GTM

Internal-only dev tool. No external surface.
