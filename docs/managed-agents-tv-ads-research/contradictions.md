# Contradictions & Open Questions

1. **Native-audio video vs audio-first.** Veo 3.1 and Sora 2 ship native dialogue/audio in-clip, which argues for prompt-with-VO; but Seedance is the only model with phoneme-level accuracy today, and Hedra still wins on talking-head fidelity. **Resolution:** for any talking-head shot, lock VO first and drive via Hedra Character-3; for ambient B-roll, native-audio models are acceptable.

2. **Character consistency: LoRA vs reference-image-only.** Runway Gen-4 / Kling 1.6 multi-image reference claim 95%+ facial consistency without fine-tune; LoRA still wins for stylized/unusual characters. **Resolution:** start with reference-only; train LoRA only when reference fails ≥ 30% of stills.

3. **Vision judges on aesthetics.** Claude Opus 4.7 visual-acuity is ~98.5% on observation tasks, but unguided "is this good?" prompts still hallucinate absent elements. **Resolution:** vision critique must be rubric-structured, not open-ended.

4. **Single-shot vs multi-shot models.** Sora 2 enforces "one camera move + one subject action per shot"; Kling 3.0 Omni supports up to 6 shots per generation. Conflicting prompt grammar. **Resolution:** ShotCard JSON carries per-model `model_overrides` so the orchestrator emits the right verbs.

5. **Geometry-anchored cost vs reach.** 3D-proxy pipelines lower per-shot retake cost but require DCC fluency — hostile to most users. **Resolution:** offer geometry-anchored architecture as the "studio tier," not the default.

6. **Dreams freshness.** Dream-curated memory is a snapshot; if used to gate decisions, it can encode stale taste. **Resolution:** Dreams populates a *read-only* "taste prior" memory store; the live brief always overrides.

7. **System1 vs Kantar metrics.** Star Rating (long-term) and STSL (short-term) are not the same target — and ads can be high on one and low on the other. **Resolution:** report both; ad's intended role (brand-build vs activation) selects which gate is binding.
