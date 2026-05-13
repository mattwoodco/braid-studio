# Findings

## 1. Managed Agents gives us everything we need for a deferred-video pipeline

- **Multi-agent sessions** with a coordinator + up to 20-agent roster + 25 concurrent threads on a **shared filesystem** are now GA-in-beta. Each agent gets isolated history but shared `/mnt/memory/` + `/mnt/session/` files.
- **Memory stores** (read-write or read-only attach at session creation, max 8 per session, 100 KB per memory, immutable version history for ~30 days) are perfect for the "show bible" — brief, characters, setting, shot list, taste lessons.
- **Outcomes** (research preview, `user.define_outcome` with rubric, up to 20 iterations, grader thread emits `span.outcome_evaluation_end` with `satisfied | needs_revision | max_iterations_reached | failed`) gives us a rubric-driven gate primitive without writing the loop ourselves.
- **Dreams** (`dreaming-2026-04-21`) can consolidate memory across sessions — exactly what `src/lib/taste.ts` was sketching.
- **Permission policies** (`always_ask` per tool) + `user.tool_confirmation` events = native HITL gate.
- **Vaults** keep fal.ai / Runway / ElevenLabs / Suno keys per-user without baking them into agent code.
- **MCP** is the right boundary to expose `generate_still`, `generate_video`, `generate_voice`, `upscale`, `compose` as named tools rather than free-form bash to fal.ai.
- **Webhooks** (`session.status_idled`, `session.outcome_evaluation_ended`, `session.thread_idled`) drive the front-end + cost-control alerts without polling.

## 2. The current braid-studio pipeline has the right bones but spends video budget too early

- Phases A (script) and B (storyboard) already use multiagent critic panels with median consensus — strong foundation.
- Phase C **dispatches all open shots to fal.ai immediately on Phase B convergence** (`generateAndCompose` in `src/app/api/projects/[storeId]/draft/route.ts`). The constrain mode keeps the cost asymmetric on regen, but the *initial* spend on a project is sunk before any frame-level visual judge has run.
- The `apply` endpoint for the critique-driven regenerate loop is **wired but unused** by the live UI.
- Dreams / taste store is **stubbed but never read** by the critic panel — house style is lost between projects.
- Ffmpeg compose runs in-process on every draft; no clip-level cache means constrain regenerations re-download + re-normalize already-locked shots.
- There is **no still / animatic stage** between Phase B (text prompts) and Phase C (paid video). This is the single biggest economic gap.

## 3. The cost case for inserting a still + animatic stage is overwhelming

Empirical reference numbers (mid-2026):

| Stage | Tool | Cost / unit | Iteration budget |
|---|---|---|---|
| Script ideation | Haiku 4.5 | <$0.01 | 100s |
| Shot list | Sonnet 4.6 | ~$0.02 | 20s |
| Hero stills (Flux/MJ) | $0.01–0.05 | 20–50 |
| Vision critique | Claude Vision | ~$0.01 | 10–30 |
| **Animatic (stills + VO + scratch music)** | <$2 total | gate |
| 720p I2V draft | Hailuo/Kling Std | $0.07/sec | 2–3 |
| 1080p final motion | Veo 3 / Runway Gen-4 | $0.10–0.15/sec | 1 |
| 4K upscale | Topaz / Magnific | ~$0.05/sec | 1 |

A 30-second ad with the gate **costs ~$15–25 of compute**. The same 30 seconds with naive prompt-to-video on Veo/Sora costs **$80–150**. Audio-first locks pacing — a fully scored 30 s spot costs roughly the same as **1–3 seconds of premium video**.

## 4. Three orthogonal axes for "alternative" architectures

Distinct architectures must vary along **source of structural constraint**, not just stage count:

- **Axis A — language-anchored**: pure text/still/I2V chain, structure carried in JSON schemas (ScriptBeat / CharacterCard / ShotCard / SettingCard).
- **Axis B — pixel-anchored**: hero stills + ControlNet/IP-Adapter + start/end-frame I2V; structure carried by control conditioning on approved frames.
- **Axis C — geometry-anchored**: 3D blockout / Gaussian splat + Wonder/Move.ai mocap; structure carried in 3D space, AI paints the final pass.

## 5. Schemas the swarm produced (canonical for all three architectures)

- `ScriptBeat` — beat role, framework, characters, place, incident, emotion, audio, shot, DBA, attention, pacing.
- `CharacterCard` — identity, appearance, wardrobe, voice (ElevenLabs voiceId), turnaround + expression refs, per-model bindings (MJ cref/cw, Flux Kontext, SD LoRA, Runway Gen-4 refs, Sora cameo).
- `ShotCard` — subject, action, shot_size, camera (angle/movement/speed, subject_action_count ≤ 1 for Sora-like models), lens, composition (incl. axis_side_180), lighting, color_grade, audio, per-model prompt overrides.
- `SettingCard` — location, time, productionDesign palette, branding hero, continuity (referencePack, plate, blockout, splat, anchoringMode), colorScience LUT, lighting.

## 6. Rubric structure (per-phase, 1–5 scale)

- **Script** (7 dims): hook strength, strategic clarity, distinctiveness, emotional arc, brand integration, memorability, cultural resonance.
- **Storyboard stills** (7 dims): composition, brand fluency, distinctiveness vs exemplar embeddings, character readability, narrative continuity, production feasibility, taste alignment.
- **Animatic** (8 dims): pacing, Spike (peak emotion), Star-arc (sustained), end-frame brand fluency, audio-visual synergy, CTA clarity, STSL-analog, novelty-familiarity balance.

Gates: pass-through requires mean ≥ 3.5/5 with no dim < 2.

## 7. Orchestration topology

**Planner-executor with sequential stages, parallel intra-stage fan-out, ensemble judge panel between stages, HITL only at expensive cutoff(s), blackboard memory on Managed Agents.**

Roles:
- **Creative Director** (coordinator) — owns brief + plan + gate decisions.
- **Writer** — produces 3–5 script variants (ScriptBeat[]).
- **Casting Director** — produces 1–N CharacterCards, locks ElevenLabs voice + reference images.
- **Production Designer** — produces SettingCard(s).
- **Cinematographer** — produces ShotCard[] from approved script + cards.
- **Storyboard Artist** — generates Flux/MJ stills per ShotCard using control conditioning.
- **VO/Audio Designer** — locks VO (ElevenLabs), music (Suno/Udio), SFX (ElevenLabs SFX) against the storyboard.
- **Critic Panel** (3-seat ensemble per phase) — text critic, vision critic, brand critic; emits `outcome_evaluation` results.
- **Animator** (gated) — promotes approved stills to I2V (Hailuo/Kling Std → Kling Pro/Veo/Runway).
- **Editor** — conforms, color, finishes (Topaz/Magnific upscale).
- **Dream Curator** — runs Dreams between projects to consolidate taste/lessons memory.

## 8. Where each architecture spends its compute

| Axis | Cheap-stage work | Paid video tier | Best for |
|---|---|---|---|
| **A. Language-anchored** | Heavy JSON + text critique + 1–2 hero stills | I2V from final hero stills (Kling/Veo) | brand spots, comedic dialogue, UGC scale |
| **B. Pixel-anchored** | ControlNet/IP-Adapter still pass, start+end frame chaining | Kling first/last + Veo finish | continuity-critical narrative spots |
| **C. Geometry-anchored** | Blender/Unreal blockout, splat capture, mocap proxy | Diffusion paint pass (Runway/Veo) | physical-plausibility critical (product, automotive, environment-led) |

## 9. Live verified facts about Managed Agents

- Beta header: `anthropic-beta: managed-agents-2026-04-01`; Dreams: `dreaming-2026-04-21`; Files: `files-api-2025-04-14`.
- Memory cap: 100 KB / memory; ~25k tokens. Versions ~30-day retention.
- Sessions: max 8 memory store attachments at create time; resources cannot be added later.
- Multi-agent: max 20 roster, depth 1, 25 concurrent threads.
- Outcomes: default 3 iterations, max 20; outputs land in `/mnt/session/outputs/`.
- Rate limits: 300 creates/min/org, 600 reads/min/org.

## 10. Contradictions surfaced

See `contradictions.md`.
