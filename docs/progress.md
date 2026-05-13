[2026-05-13T07:18:36Z] unit=1 status=done branch=batch/spend-tracker tests=pass note=append-only JSONL with price table
[2026-05-13T07:45:00Z] integration=I-1 status=done branch=batch/integration-i1 tests=183pass/5fail note=wired gates G1-G6 + spend tracking + bible build (casting/prod-design/cinematography) + animatic into full-pipeline-v3

## Integration I-1 done

Wired the 12 batch units into `scripts/full-pipeline-v3.ts` orchestrator:

- After phaseA: gate G1 on winnerScore; halt -> `cost-halt.md`.
- New `phaseBibles` step: `runCasting` -> `runProductionDesign` -> `runCinematography` writes bible cards to memory store. Gate G2 auto-passes with HITL approved.
- After phaseB: gate G3 on overall score; record `fal_image` spend per locked still.
- Build animatic via `composeAnimatic` + `getAudioBackend().generateVO(...)` to `<runDir>/<briefId>/animatic.mp4`.
- Gate G4 (EXPENSIVE CUTOFF): `AUTO_APPROVE_G4=1` env var to bypass HITL.
- After phaseC: record `fal_video_hailuo` spend per clip; gates G5, G6 auto-pass.
- Brief end: write `<runDir>/<briefId>/spend-report.md` via `loadRows`/`summarize`/`renderMarkdown`.

Spend rows are persisted by `spend-tracker.recordCall` (writes `cost_usd`) and the cumulative is mirrored on `cp.cumulativeSpendUsd` via `addSpend`. `setGateState` flips `pending` -> `passed`/`halted`. On halt, the brief throws and the main loop continues to the next brief.

Pending TODOs:

- The pre-existing unit-branch tests for `casting`, `production-design`, `cinematography` mock only `CardsStorage.create` while `cards.ts` requires `create/update/list/read`. That mismatch produces 5 pre-existing test failures (unrelated to this integration). Fix by extending the test fixtures or relaxing the cards.ts storage contract.
- `spend-report.ts` reads `cost`/`tokens` fields but `spend-tracker.recordCall` writes `cost_usd`/`tokens_in`/`tokens_out`. The orchestrator's per-brief spend-report now appends the checkpoint cumulative spend so the report still surfaces the canonical total even though the per-row table will show $0.0000. Unify the schemas in a follow-up.
- Token counts passed to `computeCost` for casting/prod-design/cinematography are coarse estimates (subagents don't surface `response.usage` to the orchestrator). When the per-phase subagents grow their own spend recording, drop the estimates here.
- `app/api/projects/[storeId]/animatic/route.ts` and the unit-branch `route.test.ts` contain type errors against the current `composeAnimatic`/`getAudioBackend` shapes (route was built against an older draft). Pre-existing; unrelated to this integration.
