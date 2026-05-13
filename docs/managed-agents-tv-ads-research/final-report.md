# Final Report — Three Managed-Agent Architectures for TV-Grade Video Ads

The user-facing version lives at `docs/EXECUTIVE_IMPROVEMENT_PLAN.md`. This file is the long-form research deliverable that mirrors and extends it.

See:
- `charter.md` for question + constraints
- `agent-plan.md` for the 16-subagent swarm
- `source-ledger.md` for citations
- `findings.md` for synthesized facts
- `contradictions.md` for open questions

The three architectures, in summary:

1. **Architecture A — Language-Anchored Studio (LAS).** A Creative Director coordinator runs Writer / Casting / Production Designer / Cinematographer / Storyboard Artist / VO Designer / Critic Panel as multi-agent threads on a shared filesystem. All structural intent flows in JSON (ScriptBeat, CharacterCard, ShotCard, SettingCard). Hero stills + scratch animatic + locked VO form the gate; only approved stills hit I2V. Best default; fits the current braid-studio code with the smallest delta.

2. **Architecture B — Pixel-Anchored Continuity Studio (PCS).** Same coordinator, but the structural backbone is **control-conditioned still frames** rather than text. ControlNet (depth/canny/openpose) + IP-Adapter + character LoRA produce a sequence of locked stills; Kling 2.1/2.5 or Runway Gen-3 first/last-frame I2V tweens between them. Maximizes shot-to-shot continuity. Best for narrative-heavy spots.

3. **Architecture C — Geometry-Anchored Production Studio (GAPS).** A 3D blockout in Blender/Unreal + a Gaussian-splat location plate + Wonder/Move.ai mocap form the bible; Managed Agents orchestrate camera/lighting/casting decisions on the 3D scene and emit depth + pose + canny passes to a diffusion-paint stage (Runway Gen-4 + Topaz). Highest fidelity ceiling and physical plausibility; highest setup cost.

Recommended adoption path for braid-studio: ship **A** first (8 weeks, brownfield refactor of current code), add **B** as a mode flag (4 weeks after A), reserve **C** for an opt-in "studio tier" (12+ weeks, requires DCC tooling).
