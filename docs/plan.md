# braid-studio Plan — Cost-Aware Self-Improving Video Ads via Managed Agents

**Prepared:** 2026-05-13
**Author:** engineering, informed by 5 hours of live pipeline runs and the mining of 479 critic envelopes from the v3 sweep.
**Companion document:** `docs/managed-agents-tv-ads-research/EXECUTIVE_IMPROVEMENT_PLAN.md` (architecture A/B/C analysis).

---

## TL;DR

We commit to **Architecture A (Language-Anchored Studio)** from the executive plan, sequenced as **5 phases over ~6 engineering weeks**. Each phase ships a measurable improvement AND a hard cost guarantee:

| Phase | Lever | Per-spot cost after this phase | Time |
|---|---|---|---|
| 0 — already done | median panel + craft rubrics + checkpoints | $5–12 per brief, 1–2h wall | shipped |
| 1 — Outcomes-driven stage gates | hard halt below threshold; cap budget per gate | $4–8 (most concepts halt at G1/G3) | 1 week |
| 2 — Memory bibles (CharacterCard / SettingCard / ShotCard) | kills subject-continuity failures (38% of v3 failures) | $4–8 | 2 weeks |
| 3 — Locked audio + animatic gate (the "expensive cutoff") | no video budget below G4 | $2–5 if rejected, **$15–25 if approved** | 2 weeks |
| 4 — Dreams + taste memory | self-improving taste prior across projects | quality compounds, cost stable | 1 week |

Naive prompt-to-video baseline: **$80–150** per 30s spot. After Phase 3: **$15–25**. After Phase 4: same cost, monotonically better.

---

## Empirical evidence from the v3 run (mined from `data/full-pipeline-v3/.../patterns.md`)

479 critic envelopes across 22 craft-grounded aspects. Variance is the truth signal — high variance = the rubric discriminates; low variance = the aspect is dead weight.

### Top discriminators (keep, weight up, prioritise in re-runs)

| Aspect | Variance | Mean | Verdict |
|---|---|---|---|
| rule_of_thirds | 0.053 | 0.68 | **#1 discriminator** — composition is what separates winners |
| brand_placement_timing | 0.050 | 0.68 | UGC briefs hiding the product (luxury-genre timing applied to UGC) is the dominant failure mode |
| subject_continuity | 0.038 | 0.64 | "red hoodie / gray hoodie" wardrobe drift between shots; this is what Architecture A's CharacterCards fix |
| premise_clarity | 0.033 | 0.59 | comedy genre — opening with the solution before the problem |
| lighting_consistency | 0.032 | 0.72 | strong signal even with high mean |
| verisimilitude | 0.028 | 0.53 | doc-only; the operational definition discriminates well |
| hook_speed | 0.026 | 0.68 | confirms our earlier finding: from 0.004 (generic) → 0.026 (operational) when given anchors |
| surprise_factor | 0.024 | 0.58 | rewards genuine novelty over conventional choices |

### Dead aspects (drop or redefine in next rubric pass)

| Aspect | Variance | Diagnosis |
|---|---|---|
| brand_dignity | **0.001** | Critics gave all candidates 0.85+ — the operational def doesn't discriminate |
| show_dont_tell | 0.007 | Universally high; either Claude's script gen already does this, or the anchor language is too lenient |
| emotional_payoff | 0.009 | Only 3 samples (anthem-genre overlay) — too few to judge |

### Recurring low-band issues (these become Dream seeds)

The miner surfaced specific operational failure modes that should feed the taste-memory store:

- **Composition:** "centered subject with no negative space," "POV with no compositional guidance," "rapid jump cuts favor centered subjects for clarity."
- **Brand timing:** "UGC format hides product until end (luxury-genre timing)," "brand appears mid-way when UGC demands front-loading," "Generic product naming with no brand mention."
- **Subject continuity:** "red hoodie contradicts gray hoodie established in shots 0 and 2," "generic 'protagonist' label with no physical identity markers," "no hair color, skin tone, or persistent physical features specified."
- **Premise clarity (comedy):** "opens with solution (phone payment) not the problem," "no premise setup if this appears in first 2 seconds," "all resolution beats with no problem setup."

These are the seeds of compound improvement. Phase 4 turns them into a read-only "taste prior" that primes every future session.

---

## Architectural commitment

We adopt **Architecture A** (Language-Anchored Studio) from the executive plan, but slot it onto the existing v3 codebase as additive modules rather than a greenfield rewrite. The core insight of A — that **structural intent flows as JSON between agents, gated by outcomes, anchored in memory, sharpened over time by dreams** — is exactly the shape our v3 data validates.

### What we already have (Phase 0 — done)

- `src/lib/critic-panel.ts` — N-seat median consensus, carry-forward floor, smoothed convergence.
- `src/lib/craft-rubrics.ts` — 16 craft aspects + genre overlays with operational definitions + scoring anchors.
- `src/lib/claude-judge.ts` — brief-grounded vision judge, minimal-rewrite guard, adaptive best-of-N.
- `src/lib/checkpoint.ts` + `scripts/supervisor.ts` — resume-on-crash; survived multiple real failures.
- `src/lib/pattern-miner.ts` + `scripts/mine-patterns.ts` — produces the variance ranking above.
- `scripts/sentinel.ts` — log-tail watchdog with optional diagnostic-agent on faults.
- `scripts/full-pipeline-v3.ts` — three-phase loop with genre-overlay rubrics + checkpoints.

### What we will not rebuild

The supervisor + sentinel + checkpoint trio is doing its job; it survived a JSON-parse failure mid-Phase-A on the afrofuturist brief without losing the other 7. We keep it. We will eventually drop `scripts/supervisor.ts` only once a Managed-Agents *coordinator-agent* (Architecture A's Creative Director) provides the same supervision via outcomes, not before.

---

## Phase 1 — Outcomes-driven stage gates (1 week)

**Goal:** every phase has a hard `user.define_outcome` rubric. When a gate fails, the loop halts immediately and surfaces. No more silent overruns.

### Design

```
G1 — Script:        rubric across SCRIPT_CRAFT + genre overlay; pass mean ≥ 0.72
G2 — Cards:         binary (CharacterCard + SettingCard present and brand-fit); pass HITL or auto if confidence ≥ 0.85
G3 — Storyboard:    rubric across STORY_CRAFT + genre overlay; pass mean ≥ 0.74
G4 — Animatic:      rubric across pacing/A-V/CTA + HITL approve; **EXPENSIVE CUTOFF** — no video below this line
G5 — Per-clip:      per-shot vision judge against ShotCard; pass mean ≥ 0.72
G6 — Final:         end-to-end ad rubric + brand/legal check; pass HITL
```

Each gate uses `user.define_outcome { rubric, maxIterations: 3 }`. The session yields `span.outcome_evaluation_start`/`_end` events; the orchestrator subscribes via existing `streamSession()` and treats `satisfied` as gate pass.

### Spend cap

Per-gate cumulative budget tracked in `checkpoint.json` (extend the schema). If `cumulativeSpend ≥ gateBudget[gate]` and gate hasn't passed, abort and write a `cost-halt.md` report. Default budgets:

| Gate | Cumulative cap |
|---|---|
| G1 | $0.50 |
| G2 | $0.70 |
| G3 | $2.00 |
| G4 | $5.00 (still gates here; no video) |
| G5 | $15.00 |
| G6 | $25.00 |

### Files to add/modify

- **NEW** `src/lib/gates.ts` — gate config, `passGate(phase, consensus): boolean`, budget tracking.
- **NEW** `src/lib/spend-tracker.ts` — every Anthropic / FAL call adds a row to `<runDir>/<briefId>/spend.jsonl`. Reads usage from Anthropic SDK response (`response.usage`) and FAL submission cost (constant per model).
- **EDIT** `src/lib/checkpoint.ts` — add `cumulativeSpend: number` + `gateState: { G1: "pending" | "passed" | "halted", ... }`.
- **EDIT** `scripts/full-pipeline-v3.ts` — between each phase, call `passGate()`. If false, write a `cost-halt.md` and return early for that brief.

### Cost effect

Most of our v3 briefs reached Phase B v2 with strong scores. Under gates: any concept that doesn't clear G1 ($0.50 sunk) is killed before Phase B begins. The expected savings: **~30-40% of briefs that get to Phase C today would halt at G3 before any video spend, saving $3-8 per killed brief.**

---

## Phase 2 — Memory bibles (CharacterCard / SettingCard / ShotCard) (2 weeks)

**Goal:** anchor identity in JSON memory so subject_continuity (variance 0.038, top-3 discriminator) stops being the dominant failure mode.

### Cards (Zod schemas in `src/lib/cards.ts`)

```typescript
type CharacterCard = {
  id: string;
  name: string;
  age_range: string;
  ethnicity: string;
  height: string;
  build: string;
  hair: { length: string; color: string; texture: string };
  wardrobe: { shot_indices: number[]; description: string }[];
  speaking_voice?: { tone: string; pace: string; accent?: string };
  brand_role: "hero" | "supporting" | "non-brand";
};

type SettingCard = {
  id: string;
  location_type: string;
  time_of_day: string;
  weather: string;
  lighting: { primary_source: string; quality: "hard" | "soft" | "diffuse"; color_temp_k: number };
  palette: { dominant: string[]; accents: string[] };
  practical_elements: string[];
  audio_ambience: string;
};

type ShotCard = {
  n: number;
  characters: string[];  // CharacterCard.id refs
  setting: string;       // SettingCard.id ref
  framing: "ECU" | "CU" | "MS" | "WS" | "EWS";
  composition: "thirds-left" | "thirds-right" | "center-intentional" | "diagonal" | "negative-space-heavy";
  camera_motion: "static" | "push-in" | "pull-out" | "pan-L" | "pan-R" | "dolly" | "handheld-drift";
  duration_seconds: number;
  emotional_beat: string;
  on_screen_text?: string;
};
```

### Subagents

- **Casting Director** (Sonnet): consumes winning script → emits `CharacterCard[]` to `/memory/bible/characters/`.
- **Production Designer** (Sonnet): consumes script + characters → `SettingCard[]`.
- **Cinematographer** (Sonnet): consumes script + characters + settings → `ShotCard[]`. Every shot's prompt is *derived* from its ShotCard, not free-written.

### Memory mount

`memstore_project_{id}` (rw) is already the per-brief store. We add a path discipline:

```
/memory/bible/characters/{characterId}.json
/memory/bible/settings/{settingId}.json
/memory/bible/shots/v{N}.json   (array of ShotCard)
/memory/scripts/v{N}/*           (existing)
/memory/critiques/{phase}/v{N}/* (existing)
```

Every downstream agent (Storyboard Artist, Animator) reads this read-only and treats it as ground truth. Wardrobe drift becomes a SCHEMA ERROR caught at storyboard-prompt-generation time.

### Why this maps to the v3 data

The recurring failure "red hoodie contradicts gray hoodie" exists because today's storyboard prompts are free-text scene descriptions with no identity backbone. CharacterCard makes that contradiction structurally impossible — every shot that mentions character X has to use X's wardrobe block.

### Files

- **NEW** `src/lib/cards.ts` — Zod schemas + Bible read/write helpers via the existing storage seam.
- **NEW** `src/lib/phases/casting.ts`, `production-design.ts`, `cinematography.ts` — three subagent calls; each one is a Claude `messages.create` with a structured-tool-use response writing into the bible.
- **EDIT** `scripts/full-pipeline-v3.ts` — between Phase A and Phase B, run casting → production design → cinematography. Phase B's still-prompt generation now reads ShotCards instead of script.scenes.

---

## Phase 3 — Locked audio + animatic gate (2 weeks)

**Goal:** the "expensive cutoff" of the executive plan. **No video budget below G4.** Pacing locked by audio waveform, not video render variance.

### Components

1. **VO subagent** (Sonnet + ElevenLabs MCP, or stub initially): produces locked VO from script. Emits `/memory/audio/vo.wav` + `/memory/audio/vo-timing.json` (per-line word timings).
2. **Music subagent** (Sonnet + Suno MCP / stub): produces music bed matching format duration. Emits `/memory/audio/music.wav`.
3. **SFX subagent**: per ShotCard, emits per-shot SFX cues. `/memory/audio/sfx-{n}.wav`.
4. **Animatic compiler** (`src/lib/animatic.ts`): stitches approved Phase B stills + locked audio into an MP4 timeline. Shot durations derived from VO timing JSON (if VO-led) or from ShotCard durations (if visual-led). FFmpeg compose; same code path as Phase C but on STILLS not video clips.
5. **G4 gate**: panel scores the animatic on pacing / A-V synergy / CTA / overall craft. If `mean ≥ 0.74` AND a HITL approval landed (or `--auto-approve` for batch runs), Phase C is unlocked.

### What this prevents

Currently Phase C bills $0.05-1.50 per shot in video generation BEFORE we know if the timing is right. After Phase 3, that bill comes only after a human looked at the animatic. A failed concept halts at $2-5 sunk (stills + audio), never burns the $15-25 video budget.

### Files

- **NEW** `src/lib/audio.ts` — stubs for ElevenLabs / Suno (real wiring deferred to MCP server in Phase 5 if needed).
- **NEW** `src/lib/animatic.ts` — `composeAnimatic(stills[], audio, timing): mp4Path`.
- **NEW** `src/app/api/projects/[storeId]/animatic/route.ts` — POST that triggers animatic compose + writes deliverable for HITL review.
- **EDIT** `scripts/full-pipeline-v3.ts` — insert G4 between Phase B and Phase C.

---

## Phase 4 — Dreams + Taste Memory (1 week)

**Goal:** the self-improvement core. Every completed project distills its lessons into a read-only taste store that primes every future session.

### Per the Anthropic Dreams API (research preview)

Reference: `https://platform.claude.com/docs/en/managed-agents/dreams`

A Dream takes (`memory_store_id`, `session_ids[]`) and produces a **new** memory store. The input is never mutated. Output is a curated, deduplicated summary of "what mattered" across the inputs. The endpoint is `POST /v1/dreams` with the `dreaming-2026-04-21` beta header. We already have `createDream` wired in `src/lib/anthropic.ts:648`.

### The taste-memory architecture

```
                +-----------------------+
                |  Project memory store |   <- per-brief, rw
                |  /memory/bible/*      |
                |  /memory/critiques/*  |
                +-----------+-----------+
                            |
                            v
                +-----------------------+
                |  POST /v1/dreams      |   <- nightly (or per-completed-project)
                |  inputs: project +    |
                |   critique session    |
                |   ids                 |
                +-----------+-----------+
                            |
                            v
                +-----------------------+
                |  Taste memory store   |   <- /memory/taste/v{N}.json
                |  - winning patterns   |
                |  - failure modes      |
                |  - genre-specific     |
                |    operational rules  |
                +-----------+-----------+
                            |
                            v
                Mounted READ-ONLY on every future
                pipeline session (every brief, every phase).
                The critic panel's rubric instructions
                include "consult /mnt/memory-taste/v{N}.json".
```

### What the Dream produces (instructions to the curator)

The `instructions` field of `createDream` tells the curator what to extract. Our taste instructions, derived from what the pattern miner surfaces:

```
You are curating CRAFT TASTE for a video-ad studio from completed projects.

Read every critique envelope under /memory/critiques/**. For each aspect:
1. Aggregate scores into bands. Bucket high-band (≥0.85) and low-band (<0.5).
2. Extract the RECURRING patterns (≥2 occurrences) in each band.
3. Cross-reference with the BRIEF GENRE (luxury, ugc, doc, comedy, horror, anthem, editorial, thriller).

Write the curated lessons to /memory/taste/v{N}.json with this shape:
{
  "winning_patterns": {
    "<aspect>": {
      "<genre>": ["pattern with ≥2 occurrences at score ≥ 0.85", ...]
    }
  },
  "failure_modes": {
    "<aspect>": {
      "<genre>": ["pattern with ≥2 occurrences at score < 0.5", ...]
    }
  },
  "operational_overrides": {
    "<aspect>": "If the brief is in genre X, the operational definition should add ..."
  }
}

Only include patterns that appear ≥2 times. Cap to 2KB per genre to stay under the 100KB memory cap.
```

### Wiring

- **NEW** `src/lib/taste-dream.ts` — `runTasteDream(briefStoreIds[], tasteStoreId)`. Calls `createDream` + polls `getDream` until status=completed; output store id is the new taste version.
- **NEW** `scripts/curate-taste.ts` — CLI that picks all completed brief stores in a run dir and runs the Dream.
- **EDIT** `scripts/full-pipeline-v3.ts` — at startup, if `BRAID_TASTE_STORE` env var is set, mount it read-only on every session resource list.
- **EDIT** every `runPanel` rubric — add a line: "If `/mnt/taste/v{N}.json` exists, weight your scoring by its operational_overrides for this genre."

### The compounding-improvement guarantee

The first run produces taste/v1. The second run loads v1 as a read-only mount, runs, then curates v2 = Dream(taste/v1 + new project stores). The seat envelope variance ranking from this plan's empirical section literally becomes operational overrides in the rubric — "if the genre is UGC and the aspect is brand_placement_timing, penalize hiding the brand past the 5s mark by 0.3."

This is the self-improving loop. Architecture A's `Dream Curator` agent from the exec plan, made concrete.

---

## Phase 5 — Cost telemetry (1 week)

**Goal:** stop guessing. Every call writes its real token + dollar cost to a local sqlite; the per-brief deliverable includes an exact spend.

### Wiring

- **NEW** `src/lib/spend-tracker.ts` — `recordCall({ kind, tokens, model, durationMs }): void`. Append to `<runDir>/spend.jsonl`. Compute dollar cost from a per-model price table.
- **EDIT** `src/lib/anthropic.ts` — wrap every SDK call to extract `usage` and forward to `spend-tracker`.
- **EDIT** `src/lib/fal.ts` + `src/lib/fal-image.ts` — record fixed-cost rows per call.
- **EDIT** `src/lib/checkpoint.ts` — `cumulativeSpend: number` updated after every recorded call.
- **NEW** `scripts/spend-report.ts` — reads `spend.jsonl`, produces a Markdown table per brief.

Per-call data shape:

```
{
  "ts": "2026-05-13T05:42:33.123Z",
  "briefId": "comedy-bank-app-ugc",
  "phase": "B",
  "version": "v2",
  "aspect": "premise_clarity",  // optional
  "seat": 1,                     // optional
  "kind": "agent_session" | "claude_messages" | "fal_image" | "fal_video" | "dream",
  "model": "claude-sonnet-4-5",
  "tokens_in": 4321,
  "tokens_out": 612,
  "cached_tokens_in": 0,
  "duration_ms": 8123,
  "cost_usd": 0.034
}
```

The cumulative-spend column on `checkpoint.json` is what gates use to enforce caps.

---

## Adoption order and exit criteria

| Phase | Ship when | Exit criterion |
|---|---|---|
| 0 | done | — |
| 1 (gates + spend) | end of week 1 | a brief halts at G1 below threshold; cost reported within 10% of actual invoice |
| 2 (bibles) | end of week 3 | subject_continuity variance in next mined run < 0.020 (the failure mode is structurally impossible) |
| 3 (animatic gate) | end of week 5 | a rejected brief costs ≤ $5; an approved brief costs $15–25 |
| 4 (Dreams) | end of week 6 | taste store v2 mounted; next run's overall ≥ previous run's overall on the same brief |
| 5 (telemetry) | continuous from week 1 | every brief deliverable shows exact spend |

After Phase 4, the system is **monotonically improving**: every new project both consumes the taste prior AND contributes to v3 of it. The exec plan's "compound interest" path is live.

---

## What we explicitly defer

- **Architecture B (Pixel-anchored, ComfyUI + LoRA Trainer)** — only worth the +4 weeks if a project lands with ≥ 2 recurring characters. Triggerable later by adding `pipeline: "pixel"` flag to a Brief.
- **Architecture C (Geometry-anchored, Blender/Splatfacto/Move.ai)** — enterprise tier. Hold until paid demand.
- **MCP servers for ElevenLabs/Suno/Topaz/Veo.** Use direct API SDKs in Phase 3, refactor into MCP only if the tools start being shared across orchestrators (Studio app, Slack bot, etc.).
- **Replacing the supervisor with a Creative Director coordinator agent.** The supervisor + checkpoint proven robust; defer until Phase 2's cards exist so a coordinator has structured input to plan against.

---

## How to verify the plan after each phase

After every phase ships, run the same 3 baseline briefs (luxury / UGC / thriller) and the 5 new v3 briefs (afrofuturist with the JSON-retry fix, tokyo, comedy, fragrance, vintage). Mine the resulting stores. Compare four metrics:

1. **Discrimination quality**: the variance ranking should keep the top-8 aspects above 0.020 and continue to surface new high-variance aspects from the genre overlays.
2. **Per-brief cost**: must trend down phase-over-phase.
3. **Phase B convergence iterations**: phase-over-phase, the average iterations to reach `all-locked` should drop (carry-forward + taste prior compound).
4. **Score floor**: the *minimum* per-shot score across a brief should rise — no shot left at 0.5.

If any of these regresses two phases in a row, halt rollout and run the pattern miner on that phase's run to diagnose.

---

## What is committed by this plan

- 5 new lib files, 3 new route files, 4 new scripts.
- Edits to 4 existing lib files + the v3 orchestrator.
- ~6 engineering weeks.
- No additional managed-agent runtime cost during build (each phase is exercisable by a single brief at ~$5 of live spend).

Approve and I begin with Phase 1 (gates + spend tracker) immediately.
