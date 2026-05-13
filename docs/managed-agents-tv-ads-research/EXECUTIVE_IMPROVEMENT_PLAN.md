# Executive Improvement Plan — Managed-Agent Architectures for TV-Grade Video Ads

**Prepared:** 2026-05-13
**Audience:** braid-studio engineering + creative leadership
**Source research:** `.research/managed-agents-tv-ads/`

---

## TL;DR

We can cut compute spend per 30-second ad from **$80–150 to $15–25** *and* lift creative quality by re-architecting around Claude Managed Agents with three principles:

1. **Defer paid video generation.** Insert a still + animatic + locked-audio gate before any fal/Veo/Sora/Runway call.
2. **Treat the brief as a structured "show bible."** Persist `ScriptBeat`, `CharacterCard`, `ShotCard`, `SettingCard` JSON in Managed Agents memory stores, mounted read-only into every downstream agent.
3. **Run a planner-executor multi-agent crew** (Creative Director coordinator + 6 specialists + 3-judge critic panel) with rubric-driven `outcomes` between every stage.

We present **three alternative architectures** that share these principles but differ on *where structural constraint lives*. Recommended adoption order: **A → B → C**.

---

## Where we are today

`scripts/full-pipeline-v3.ts` + `src/lib/critic-panel.ts` already implement multi-agent panels with median-consensus rubrics across **Phase A (script)** and **Phase B (storyboard prompts)**. **Phase C (video)** then dispatches all shots to fal.ai in parallel via `src/app/api/projects/[storeId]/draft/route.ts` `generateAndCompose`. Strengths and gaps:

- ✅ Multiagent critic panel with median consensus is correct shape.
- ✅ Memory-store versioning of drafts/critiques with parent lineage.
- ✅ `constrain` mode regenerates only failing shots.
- ❌ **No still / animatic stage** between Phase B text prompts and Phase C paid video. *Initial* spend on every project is sunk on un-vision-judged video.
- ❌ **No locked audio** — pacing is whatever fal returns.
- ❌ `apply` endpoint for critique-driven regen exists but isn't wired into the UI.
- ❌ Dreams / taste store is stubbed; house style is lost between projects.
- ❌ ffmpeg compose runs in-process every draft; no clip cache; constrain regens re-download locked clips.

---

## Architecture A — Language-Anchored Studio (LAS)  *[Recommended default]*

Structural intent flows as **JSON between agents**. Lowest setup cost; smallest delta from current code.

### Agent roster (Managed Agents multi-agent coordinator, max 20)

| Agent | Model | Responsibility | Reads | Writes |
|---|---|---|---|---|
| Creative Director | Opus 4.7 | brief, plan, gate decisions | brief, memory `/bible/*`, all phase outputs | `/plan/v{N}.json` |
| Writer (×3 seats) | Sonnet 4.6 / Haiku 4.5 | script variants | brief, `/bible/*` | `/scripts/v{N}/seat{i}.json` (ScriptBeat[]) |
| Casting Director | Sonnet 4.6 | CharacterCards + ElevenLabs voice IDs | winning script | `/bible/characters/{id}.json` |
| Production Designer | Sonnet 4.6 | SettingCard(s) + LUT pick | winning script + cards | `/bible/settings/{id}.json` |
| Cinematographer | Sonnet 4.6 | ShotCard[] with per-model overrides | winning script, cards, settings | `/bible/shots/v{N}.json` |
| Storyboard Artist | Sonnet 4.6 + Flux/MJ via MCP | hero stills per shot, vision-judge loop | shots, characters, settings | `/stills/v{N}/shot{n}.png` + judge scores |
| VO/Audio Designer | Sonnet 4.6 + ElevenLabs/Suno via MCP | locked VO, music, SFX, derive shot durations from waveform | script, cards | `/audio/{vo,music,sfx}.wav` + timing.json |
| Critic Panel (3 seats × per-phase) | Opus 4.7 / Sonnet 4.6 / Haiku 4.5 ensemble | rubric scoring | phase artifact | `/critiques/{phase}/seat{i}.json` |
| **Animator** *(gated)* | Sonnet 4.6 + Hailuo/Kling/Veo via MCP | promote approved stills to I2V | locked stills + timing | `/clips/{n}.mp4` |
| Editor | Sonnet 4.6 + ffmpeg/Topaz/Magnific via MCP | conform, color, upscale | clips + audio | `/finals/v{N}.mp4` |
| Dream Curator | Opus 4.7 via `/v1/dreams` | weekly memory consolidation | recent sessions | `/taste/*` (read-only mount into future sessions) |

### Memory layout (Managed Agents memory stores)

Three stores attached per project session (≤ 8 store limit, well within budget):

- `memstore_project_{id}` (read-write) — `/bible/*`, `/scripts/*`, `/shots/*`, `/stills/*`, `/audio/*`, `/clips/*`, `/finals/*`, `/critiques/*`, `/plan/*`.
- `memstore_brand_{org}` (read-only) — distinctive brand assets, palette, voice IDs, logo files (mounted via Files API at `/mnt/files/brand/`).
- `memstore_taste_{org}` (read-only) — Dream-curated lessons from past projects.

Memory cap is 100 KB / memory; ScriptBeats and ShotCards comfortably fit; PNGs/audio live in `/mnt/session/outputs/` via Files API.

### Stage gates (Managed Agents `user.define_outcome`)

Each gate is a rubric-evaluated `outcome` with `max_iterations: 5`. The grader thread emits `span.outcome_evaluation_end` with `satisfied | needs_revision`. Webhook `session.outcome_evaluation_ended` notifies the UI.

| Gate | Rubric | Pass threshold | Spend below gate |
|---|---|---|---|
| G1 — Script | 7-dim (hook, clarity, distinctiveness, arc, brand, memorability, resonance) | mean ≥ 3.5, min ≥ 2 | < $0.50 |
| G2 — Cards | character consistency + brand fit | binary; HITL approve | < $0.20 |
| G3 — Storyboard stills | 7-dim composition/brand fluency/distinctiveness/etc. | mean ≥ 3.5 | < $2 |
| G4 — **Animatic + locked audio (EXPENSIVE CUTOFF)** | 8-dim animatic rubric (pacing, Spike, Star-arc, brand fluency, A/V synergy, CTA, STSL-analog, novelty balance) + **HITL approval required** | mean ≥ 3.5 *and* human approve | < $5 total |
| G5 — Clip approval | per-clip vision judge against ShotCard | mean ≥ 3.5 | $0.50–0.80 / 8s clip |
| G6 — Final | end-to-end ad rubric + brand legal | mean ≥ 3.5 + HITL | finishing only |

### Tool/MCP surface

A single MCP server `braid-mcp` exposes:

- `generate_still(prompt, refs[], control_image?, model)` → fal Flux/MJ
- `generate_video(start_frame, end_frame?, prompt, model, duration)` → fal Hailuo/Kling/Veo/Runway
- `generate_voice(text, voice_id, emotion?)` → ElevenLabs
- `generate_music(prompt, duration, structure?)` → Suno/Udio
- `generate_sfx(prompt, duration)` → ElevenLabs SFX
- `upscale_video(file_id, target)` → Topaz/Magnific
- `compose_timeline(clips[], audio[], cuts[])` → ffmpeg

Vault holds fal/Runway/ElevenLabs/Suno/Topaz tokens. Permission policy is `always_allow` below G4 and `always_ask` for `generate_video` and `upscale_video`.

### Cost envelope per 30s spot

Brief→stills→animatic ≤ $2. Approved → 720p drafts ($2–4) → G5 → 1080p finals ($4–8) → upscale ($1) → **total $15–25**. Naive prompt-to-video baseline: $80–150.

### Migration delta from today

1. Add `/api/projects/[storeId]/stills` route + `src/lib/stills.ts` (Flux via fal-image).
2. Add `src/lib/animatic.ts` that compiles stills + locked audio into a scratch MP4.
3. Wire `apply` endpoint to feed Phase B critique into a new `constrain-stills` mode.
4. Move fal `dispatchShot` behind MCP tool so policy can gate it.
5. Replace the implicit Phase A/B/C sequencing with a Managed-Agents coordinator agent that uses `user.define_outcome` per gate. Drop `scripts/supervisor.ts` and `sentinel.ts` once parity is reached.
6. Mount `memstore_brand_*` + `memstore_taste_*` read-only on every session; wire `src/lib/taste.ts` Dreams stub to the `/v1/dreams` endpoint nightly.

**Estimated effort: 8 engineering-weeks.**

---

## Architecture B — Pixel-Anchored Continuity Studio (PCS)

Same agent roster as **A**, but the structural backbone is **control-conditioned still frames + start/end-frame I2V chaining**, not JSON shot cards.

### Key differences from A

- The Cinematographer outputs **a depth/canny/pose triplet per shot** (rendered from a 2D blockout or rough Flux pass) into `/control/{n}/{depth,canny,pose}.png`.
- The Storyboard Artist uses **ComfyUI MCP** with ControlNet + IP-Adapter + per-character LoRA stacked on Flux Dev — each still inherits the prior shot's last frame as IP-Adapter conditioning, so silhouette/lighting carry over deterministically.
- The Animator promotes stills via **Kling 2.5 Turbo / Kling O1 start+end-frame I2V**, treating each shot as an interpolation between two locked frames. Any failed segment re-rolls cheaply without redoing the chain.
- Adds a **LoRA Trainer** subagent (only spawned if reference-only consistency on a CharacterCard falls below 70% across 10 stills): trains a 10–30-image character LoRA via fal Flux LoRA Trainer; caches in `memstore_brand_*` for reuse.

### Best for

- Narrative spots with recurring characters in changing locations
- Sequences where shot-to-shot continuity matters more than per-shot fidelity
- Long-form (60s+) where Kling Pro/Veo per-second cost would explode

### Trade-offs

- **+** Highest shot-to-shot continuity short of full 3D.
- **+** Failed clip retries are independent (only the failed pair re-renders).
- **−** Adds ComfyUI MCP dependency + GPU footprint for LoRA training (~$5 / character).
- **−** Slightly more JSON to author (control-image manifest per shot).

### Migration delta from A

Add an MCP server wrapping a ComfyUI worker pool (fal hosts these), a `LoRA Trainer` agent, and a `control_image` field on `ShotCard`. ~**4 engineering-weeks on top of A.**

---

## Architecture C — Geometry-Anchored Production Studio (GAPS)

The bible lives in **3D space**: a blockout in Blender or Unreal, a Gaussian-splat location plate, optional Wonder/Move.ai mocap. Managed Agents orchestrate decisions on the 3D scene; AI paints the final pass.

### Agent additions to A

| Agent | Responsibility |
|---|---|
| **Previs Architect** (Blender/Unreal via MCP) | builds rough blockout from SettingCard + ShotCard; emits camera path + lighting rig |
| **Splat Capture Director** | ingests phone-capture videos, runs Polycam/Nerfstudio Splatfacto, publishes splat to `/bible/splats/{id}.ply` |
| **MoCap Director** | runs Autodesk Flow / Move.ai on driver footage, emits FBX → applies to CG proxy |
| Animator (modified) | renders depth + canny + OpenPose passes off the 3D scene; feeds Runway Gen-4 / Veo 3 with multi-ControlNet conditioning |

### Why this is worth a third architecture

3D proxy is the **only credible path to deterministic camera moves, shot-to-shot occlusion correctness, and physical plausibility** at indie budgets. Asteria's Continuum Suite, Coca-Cola/WPP/NVIDIA Prod X, and Promise MUSE all converge on this pattern for studio-grade output. ControlNet-from-3D collapses the AI variance that kills product/automotive ads.

### Best for

- Product hero spots where the package must read correctly from every angle
- Automotive, architectural, environment-led spots
- Anything where physics has to look right

### Trade-offs

- **+** Highest fidelity ceiling and continuity.
- **+** Camera intrinsics/extrinsics deterministic across shots.
- **−** Requires DCC fluency (Blender or Unreal) — collapses addressable user base.
- **−** ~40% pre-production cost reduction *vs full VFX*, but still 3–5× the cost of Architecture A on simple spots.

### Migration delta from A

New MCP servers: `blender-mcp` (headless render via Blender CLI), `unreal-mcp` (Pixel Streaming or headless), `splat-mcp` (Splatfacto), `wonder-mcp` (Autodesk Flow API). Add `geometry` block to `SettingCard` and `ShotCard`. ~**12 engineering-weeks**; ship as an opt-in "studio tier" not the default.

---

## Cross-architecture comparison

| Dimension | A — Language | B — Pixel | C — Geometry |
|---|---|---|---|
| Source of structural constraint | JSON schemas | Control-conditioned stills | 3D scene |
| Multi-agent coordinator | ✓ | ✓ | ✓ |
| Per-shot retake cost | $0.50–1 | $0.30–0.70 | $0.40–0.90 |
| Setup cost | low | medium | high (DCC fluency) |
| Best fidelity ceiling | high | very high | highest |
| Continuity guarantee | medium | high | very high |
| Cost per 30s spot (typical) | $15–25 | $20–35 | $50–120 |
| Engineering weeks (incremental) | 8 | +4 over A | +12 over A |
| Recommended for | default | narrative continuity-critical | product / automotive / environment-led |

---

## Recommended adoption path

1. **Weeks 0–8** — Implement **A** as a brownfield refactor of `src/app/api/projects/[storeId]/*` and `src/lib/*`. Ship still + animatic + locked-audio gate first; everything else slots in behind. Specific tasks:
   - Implement `braid-mcp` MCP server exposing the 7 tools above (separate process, deployed alongside Next.js).
   - Replace `scripts/supervisor.ts` orchestration with a Managed-Agents coordinator agent driven via the SDK.
   - Add `src/lib/stills.ts`, `src/lib/animatic.ts`, `src/lib/audio.ts` (ElevenLabs + Suno) and the 4 JSON schemas as Zod definitions.
   - Mount `memstore_brand_*` and `memstore_taste_*` on every session; wire Dreams nightly via `/v1/dreams`.
   - Move all paid generators behind `always_ask` permission policy for shots above G3.

2. **Weeks 9–12** — Add **B** as a per-project mode flag: `pipeline: "language" | "pixel"`. Add ComfyUI MCP and LoRA Trainer agent. Default new projects to `"language"`; flip to `"pixel"` for any project marked "narrative" or with ≥ 2 recurring characters.

3. **Weeks 13–24** — Build **C** as a separate "Studio" deployment. Wrap Blender + Splatfacto + Autodesk Flow as MCP servers. Position as enterprise upsell; do not retire A or B.

## Risks & mitigations

- **Managed Agents beta churn.** Endpoints labeled "research preview" (outcomes, dreams, multiagent) can change. Mitigation: pin SDK version; isolate beta headers in one module.
- **fal cost spikes.** Cap monthly spend per project via permission-policy denials above $X; surface in UI.
- **Judge over-fitting to Cannes corpus.** Pair Star-rating analog with STSL-analog; report both. Refresh exemplar embedding store quarterly.
- **Vision-judge hallucination.** All vision critique is rubric-structured, never open-ended.
- **Dream staleness.** Dream output is read-only "taste prior"; live brief always overrides.

## Out of scope

- Final delivery/QC integrations (Frame.io, broadcast-spec encoding).
- Brand-safety + legal review automation (could be a future critic seat).
- Localization / multi-language variant generation (orthogonal; ElevenLabs covers VO).

---

*Research artifacts: `.research/managed-agents-tv-ads/charter.md`, `agent-plan.md`, `source-ledger.md`, `findings.md`, `contradictions.md`, `final-report.md`.*
