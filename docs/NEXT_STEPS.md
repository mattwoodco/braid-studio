# Next steps

Paradigm constraints (don't violate):
- **Local-only.** No public ingress. The agent runs in Anthropic's container, talks
  to fal's hosted MCP, returns results via the session event stream.
- **Least code.** No DB, no auth, no relay, no sibling services. Memory stores
  hold all state. Today: 17 source files, ~2,500 LOC.
- **Max Managed Agents.** Built-in tools (Bash, file ops, web_search, web_fetch),
  container packages, MCP server attachment, vaults, memory store mounts — use
  these instead of writing equivalents.

Validated baseline today: three lanes green end-to-end.
- Draft: 35.2s, ~$0.72, no agent
- Studio: 240s, ~$0.72, Managed Agents session
- Studio follow-up: 207s, ~$0.24 — surgical shot retry via `user.message`

---

## Critical (blocks usability)

The suite is curl-only without these. ~2 dev days total for a single UI pass.

### 1. Chat-mode Studio UI works end-to-end
The page exists at `src/app/projects/[storeId]/page.tsx` but the follow-up flow
hasn't been validated visually. Wire: SSE event log → final `<video>` →
text input that POSTs a follow-up `user.message` and re-opens the stream.
~half a day. State machine work, no architectural change.

### 2. Per-shot `<video>` tiles
The manifest has `shot_urls`; the page should render each as a small `<video>`
so the marketer can say *"shot 2"* with intent. Without this, granular retry
is a backend feature with no front door. ~2 hours.

### 3. Failure surfacing
When fal 422s or the agent ends on `session.status_idle.stop_reason:
requires_action`, the UI must render the error explicitly. Today the user
sees a hang. ~2 hours.

### 4. Project archive / delete
Memory stores pile up across dev runs. Needs: a "delete project" button +
`infra/cleanup.ts` that archives stores with `metadata.braid_studio == "v1"`
older than N days. Without this, the project list becomes unscannable inside
a week. ~half a day.

---

## Important (week-1 to be useful beyond dev)

### 5. Brand state seeding UX
Per-project `/memory/rubric.md` and `/memory/voice.md` are wired in
`src/app/api/projects/route.ts` but the only edit path is via `createMemory`.
Add a "brand" tab in the studio page with two textareas + save buttons that
call the existing `createMemory` / `updateMemory` helpers. Pure UI work.

### 6. Audio (voice + music)
A TV ad without sound is hollow. fal MCP includes audio models. Update the
agent's system prompt to optionally call `submit_job` against an ElevenLabs
voice model and a MusicGen track, add `audio_url` to the manifest, extend
`composeClips` to overlay audio with `-i audio.mp3 -map 0:v -map N:a -shortest`.
Cleanest expansion of the existing model.

### 7. Variable shot count + aspect ratio + duration
Today everything is hardcoded to 3 × 5s @ 16:9. Marketers want 6 × 5s @ 9:16
(TikTok) or 1 × 30s @ 1:1 (Instagram). Pass `shots`, `duration_seconds_per_clip`,
`aspect` through the body → manifest → compose. Pure passthrough work; the
agent's system prompt already mentions "default 3 shots" so it'll generalize.

### 8. Cost surfacing
Each studio run is ~$0.72; followup ~$0.24. The chat page should show running
cost (3 fal jobs × $0.24 = ~$0.72 estimated, plus agent token cost parsed from
`span.model_request_end` events). Without this, marketers can't budget; without
budgeting, they don't use the tool.

### 9. Live shot previews during generation
Today the user waits 4 minutes staring at the SSE log. The agent's
`agent.mcp_tool_use(submit_job)` events carry intermediate state. When each
shot's `check_job` returns a URL, surface that to the UI immediately as a
preview tile. Marketer sees shot 1 ready while shots 2 and 3 are still
cooking. Same SSE pipe, smarter rendering. ~half a day.

---

## Nice-to-have

### 10. MCP servers for marketer tools
Official remote MCP servers exist for:
- **Notion** — brand briefs and campaign plans
- **Figma** — asset library tokens and vector files
- **Slack** — approval flows, status notifications
- **Google Drive / Workspace** — raw footage, hero shots, briefs

Attach via the same `mcp_servers` array in `infra/agent.yaml`. Each one unlocks
a workflow class. Pick **Notion** first.

### 11. Variant generation
"Give me 5 versions of this ad." Fan out 5 parallel sessions against the same
project; gallery view picks the best. Backend already supports parallel
sessions; this is a route + UI change.

### 12. Approval queue + memory versions
Memory stores keep version history natively (verified live in the experiment).
Approve = pin a version. Mark as "current". `restoreMemoryVersion` reverts.
The experiment had this; port the routes (~150 LOC).

### 13. Auto-grade with `user.define_outcome` rubric
Currently the rubric is text the agent reads. The harness supports outcome
evaluation as a first-class feature with `span.outcome_evaluation_*` events.
Wire the rubric as a real outcome → the agent self-grades and re-shoots
failing shots without our prompting. Free quality bump.

### 14. Multi-project brand inheritance
"Acme Holiday 2025" project inherits `/memory/rubric.md` from a parent
"Acme Brand" project. The agent reads both; per-project overrides win.
Implementable as a session with two memory stores in `resources` (parent
read-only, child read-write). No new code beyond the route signature.

### 15. Export presets
TV broadcast (h264 high, 8 Mbps), Reels (h264 baseline, 4 Mbps), Web
(2 Mbps). Three preset flag values into `composeClips`. ~30 LOC.

---

## Deliberately NOT doing

These would violate the paradigm:

- **No database.** Memory stores hold all state. Adding sqlite would
  pull in drizzle, schema migrations, dev seed scripts — see the experiment.
- **No worker queue / relay.** The agent does long-running work natively in
  its container.
- **No custom-tool bridge.** MCP servers cover everything we need.
- **No auth in v0.** Single-user local. When multi-user lands, Anthropic's
  vault model gives per-user credential isolation for free.
- **No webhook ingestion.** The session event stream is the only channel.
- **No file storage we own.** fal storage URLs are public + cheap; our local
  `data/finals/` is just a cache.

---

## Recommended next 1-2 days

1. Do **#1 + #2 + #3 + #4** as a single UI pass (~1.5 days, all front-end,
   no architectural change). That makes the suite demo-able to a real marketer.
2. Then **#6 (audio)**. The difference between "tech demo" and "I'd use this."
3. Then **#9 (live shot previews)**. The wait is the most felt friction.

After that, **#10 (Notion MCP)** is where the harness's connection layer earns
its keep and a marketer's existing workflow becomes a tool the agent can use.

Everything past that (variants, approvals, multi-project inheritance, outcome
auto-grading) is real value but doesn't change the architecture — it's UI +
small additions to the existing manifest/agent contract. The core suite is done.

---

## Script variations — agent-driven, zero new code paths

The script is the cheapest lever and the agent is already the right place to
pull it. Today the system prompt asks for "N shots reflecting the brief" with
no narrative structure. That's a one-line system-prompt change away from being
a real creative engine. Everything below lives in `infra/agent.yaml`, not in
`src/`.

### S1. Named narrative templates (system-prompt only)
Add a template registry the agent picks from based on the brief:
- **Hook → Build → Payoff** (default 3-shot, generic CPG)
- **Problem → Agitate → Solve** (DR / performance ads)
- **Day-in-the-life** (4–6 shots, longitudinal)
- **Before / After** (2 shots, transformation; pairs with #15 export presets)
- **Testimonial-cut** (B-roll behind implied VO; pairs with #6 audio)
- **Product-as-hero** (single subject, multiple angles + lighting passes)

Implementation: a `Templates:` block in the system prompt enumerating each
with its shot count, beat structure, and a one-line "use when" rule. Agent
picks at plan time, writes the chosen template to `/memory/final.json` as
`template: "..."`. Zero new code in `src/`. ~40 lines of prompt.

### S2. Parallel-variant fan-out via the agent, not the route
Instead of #11's "spawn 5 sessions from the backend," let the agent itself
emit N parallel `submit_job` calls under N different templates **in a single
turn**, writing `/memory/variants/<i>.json`. The harness already supports
parallel tool use in one turn — we're just declaring it in the prompt.
Backend change: route reads `/memory/variants/*.json` instead of one
`final.json`. ~10 LOC.

### S3. Voice memory drives tone, not the brief
`/memory/voice.md` is mounted but the agent treats it as ambient. Make the
system prompt explicit: "Before planning shots, extract three concrete style
tokens from `/memory/voice.md` (e.g. `lighting=warm-tungsten`,
`pace=slow-cut`, `palette=desaturated`) and append them to every shot prompt
verbatim." That single instruction converts brand state from decoration into
a constraint the agent can't drift from.

### S4. Counterfactual scripts as a built-in tool
After the manifest is written, agent self-prompts: *"name one shot whose
removal would weaken this script most, and one whose replacement would
strengthen it most."* Write to `/memory/critique.json`. Free quality signal
with no new infra; pairs naturally with #13 outcome-grading.

---

## Video techniques — push the model, not the pipeline

`ltx-2.3/text-to-video/fast` responds dramatically to prompt structure. The
biggest quality wins are in *how the agent writes prompts*, not in switching
models or adding post.

### V1. Shot-grammar contract in the system prompt
Every shot prompt must contain, in order: `[lens] [subject] [action]
[camera-move] [lighting] [palette] [pace]`. Example: *"50mm, barista's
hands, tamping espresso, slow push-in, golden-hour rim light, warm amber,
3-second sustained beat."* Models hallucinate less when the prompt is
structurally consistent. Add a one-paragraph schema + 3 worked examples to
the prompt — no code change.

### V2. Camera-move vocabulary lock
Constrain the agent to a fixed list: `static, slow-push, slow-pull,
tracking-left, tracking-right, handheld-subtle, crane-up, whip-pan`. Open
"camera move" prompting produces inconsistent motion. A closed vocabulary
gives the marketer a finite set they can ask for verbatim
("`tracking-right` on shot 2"). ~10 lines in the prompt.

### V3. Continuity tokens across shots
The agent should reuse a `continuity_seed_phrase` (e.g. *"warm amber
afternoon, polished walnut bar, blue ceramic cups"*) verbatim across every
shot prompt in a single script. Stored at `/memory/final.json#continuity`.
Same memory, different shots → models render the same world. Cheapest
visual-coherence win available.

### V4. Two-pass refinement on the same shot
For any shot the agent's own critique (S4) flags, the follow-up turn already
supports surgical retry. Extend the prompt: if `/memory/critique.json` exists
and flags a shot, the agent regenerates that shot once with the
critique-derived adjustment **before** declaring `DONE`. Turns the critique
into a closed loop with no new endpoints.

### V5. Aspect-aware composition hints
When the marketer asks for `9:16` (TikTok) or `1:1` (Instagram), the
**prompt** must change too — center the subject, avoid wide horizons,
prefer vertical motion. Add an aspect → composition rule block to the
system prompt that the agent consults at plan time. Pairs with #7 but is
agent-side, not backend.

### V6. Negative prompts as a first-class field
`fal-ai/ltx-2.3` accepts negative prompts. The agent should populate
`input.negative_prompt` with a fixed string ("text overlays, watermarks,
distorted faces, low-frame-rate stutter, plastic skin") plus brand-specific
additions from `/memory/voice.md`. One field, large quality lift.

---

## Managed Agents as the primary driver

A standing rule for everything above: **if it can live in the agent's prompt,
memory, or tool-use, it MUST live there.** The backend's job is to mount
state, compose the final mp4, and stream events — nothing else.

Concrete tests for any new feature before writing code:
1. *Can a system-prompt change accomplish this?* If yes, do that.
2. *Can a memory file accomplish this?* If yes, mount it and let the agent read/write.
3. *Can an existing MCP server accomplish this?* If yes, attach it in `agent.yaml`.
4. *Does this need a new endpoint?* Only then.

This ordering preserves the 17-file / ~2.5K-LOC baseline. Each item in §S
and §V above clears tests 1–3; none requires test 4.

---

## Red/green TDD harness — extend `scripts/acceptance.ts`, don't fork it

The existing `acceptance.ts` already runs the three-lane validation
(draft / studio / studio-followup). It is the test bed. Extend it; do not
build a parallel framework.

### T1. Per-feature acceptance rows (red first)
Each new capability above adds **one assertion** and **one row** to a
results table:

| feature        | assert                                                                | status |
|----------------|-----------------------------------------------------------------------|--------|
| S1 templates   | `/memory/final.json#template` ∈ known set                             | red    |
| S2 variants    | `/memory/variants/*.json` count ≥ requested N                         | red    |
| S3 voice tokens| every shot prompt contains all 3 tokens extracted from `voice.md`     | red    |
| S4 critique    | `/memory/critique.json` exists after end_turn                         | red    |
| V1 grammar     | every shot prompt matches the 7-slot regex                            | red    |
| V2 camera moves| `camera_move` field ∈ closed vocabulary                               | red    |
| V3 continuity  | `continuity_seed_phrase` byte-equal across every shot prompt          | red    |
| V4 two-pass    | when critique flags shot K, shot K's `updated_at` > initial timestamp | red    |
| V6 negatives   | every `submit_job` carries non-empty `negative_prompt`                | red    |

TDD loop: write the assert → run → observe red → edit
`infra/agent.yaml` system prompt → re-run → green. No `src/` edits in most
rows. Commit each green row separately so regressions bisect cleanly.

### T2. Performance ledger (`data/perf/<run-id>.json`)
Each acceptance run writes one JSON line per lane:

```
{ run_id, ts, lane, model, wall_ms, est_cost_usd, tokens_in, tokens_out,
  shot_count, template, asserts_passed, asserts_failed }
```

Append-only. The ledger lives in `data/perf/` (already gitignored alongside
`data/finals/`). One `bun scripts/acceptance.ts --ledger` flag, ~30 LOC
addition to the existing script. No new file required.

### T3. Trend report — `bun scripts/acceptance.ts --report`
Reads the ledger, prints a one-screen table: per-lane median wall_ms,
median cost, pass-rate, and Δ vs. the prior week. This is the single
artifact that tells us whether a prompt change made things better or
worse. ~50 LOC.

### T4. Findings log (`docs/PERF_LOG.md`)
Every prompt change that flips a red row green gets a one-paragraph entry:
the change, the before/after numbers from T3, and the date. This is the
institutional memory the system prompt can't carry on its own. Append-only.

Recommended discipline:
- Never merge a prompt change without one new ledger row showing it green.
- Never delete a ledger row; mark superseded by `run_id`.
- If a previously-green row goes red on a later run, that's the only kind
  of regression that blocks merging.

---

## Always validate

Three checks run on every acceptance pass; if any fail, the run is red
regardless of mp4 output:

1. **Manifest schema** — `/memory/final.json` parses against the inline
   zod schema already in `src/lib/anthropic.ts` (extend it with the new
   `template`, `continuity` fields).
2. **Shot-prompt grammar** — every prompt the agent submitted to fal
   matches V1's 7-slot regex. Pulled from `span.mcp_tool_use` events
   already in the SSE stream; no new instrumentation.
3. **Output probe** — `ffprobe` on the final mp4 confirms duration,
   codec, and audio track presence (when audio is requested per #6).

Validation that *isn't* in the acceptance script doesn't exist. The script
is the contract.

---

## Suggested execution order for this extension

1. **T1 + T2 + T3** first (one half-day). Without the ledger, every claim
   below is unfalsifiable.
2. **V1 + V3 + V6** as a single prompt change (one hour). Largest visible
   quality lift per byte of prompt edited. Measure with T3.
3. **S1 + S3** together (one hour). Templates + voice tokens convert the
   agent from "generic video bot" to "this brand's video bot."
4. **S4 + V4** as a closed loop (half-day). First place the agent
   self-corrects without us prompting — biggest paradigm win.
5. **S2** last (half-day). Parallel variants are only useful once 1–4
   make single variants reliably good.

After step 5, every entry in this section is green in the ledger and the
backend has not gained a single new line of business logic.
