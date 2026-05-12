# Inspiration & Vision — braid-studio TDD ledger extension

This extension is **not** a new product. It is an evaluation harness that
makes every prompt change to `infra/agent.yaml` falsifiable. The "user" is
the developer iterating on the agent's video-direction prompt; the "value"
is institutional memory across runs.

## Principles

1. **The acceptance script is the contract.** Anything not measured by
   `scripts/acceptance.ts` does not exist. No parallel test framework.
2. **Append-only.** Ledger rows and `PERF_LOG.md` entries are never
   rewritten — only superseded by newer rows referencing the prior `run_id`.
3. **Red before green.** Every new assertion ships failing, then a prompt
   edit (not a code edit) flips it green. Code edits are the exception.
4. **The manifest is the seam.** The agent writes `/memory/final.json` and
   `/memory/shots/*.json`. The harness inspects those files plus the SSE
   event stream — never the agent's internal state.
5. **No new src/ endpoints.** The 4-question gate from NEXT_STEPS applies:
   prompt → memory → MCP → endpoint. Stop at the first "yes."

## References

- Existing baseline: `scripts/acceptance.ts` already validates three lanes
  (draft, studio, studio-followup) with ffprobe assertions on the final
  mp4. This extension layers a ledger and assertion table on top.
- LLM-eval prior art worth mirroring philosophically (not vendoring):
  Anthropic's outcome-evaluation primitives (`span.outcome_evaluation_*`),
  OpenAI Evals' graded-assertion table, and the "golden traces" pattern
  from production agent harnesses.

## Non-goals

- No web UI for the ledger. CLI tables only.
- No DB. Ledger is `data/perf/<run-id>.json` line-per-lane files.
- No CI hosting. Runs are developer-triggered locally.
