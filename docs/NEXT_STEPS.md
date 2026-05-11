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
