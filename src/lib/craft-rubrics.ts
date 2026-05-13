/**
 * Craft-grounded rubric aspects. Each aspect has an *operational definition*
 * the critic can actually grade — replacing generic "composition" / "pacing"
 * with the well-known craft attributes that drive perceptible quality.
 */

export type AspectDefinition = {
  /** stable id used as filename + JSON aspect field */
  id: string;
  /** one-line human label */
  label: string;
  /** operational definition the critic uses — the discriminating question */
  operational: string;
  /** scoring anchors so seats agree on what 0.5 vs 0.8 vs 0.95 means */
  anchors: { score: number; description: string }[];
};

// ============================================================
// SCRIPT (Phase A) — 6 aspects
// ============================================================

export const SCRIPT_CRAFT: AspectDefinition[] = [
  {
    id: "hook_speed",
    label: "Hook speed",
    operational:
      "Does the opening compel attention within the first 1-3 seconds (in-medias-res, visual surprise, or pattern interrupt)? Slow expository openings score low.",
    anchors: [
      { score: 0.3, description: "Slow build, generic exterior establishing shot" },
      { score: 0.6, description: "Clear setup but no surprise; takes 4-5s to land" },
      { score: 0.85, description: "Hook in first second; visual or tonal pattern interrupt" },
    ],
  },
  {
    id: "three_act_arc",
    label: "Three-act arc",
    operational:
      "Does even a short spot have setup → escalation → payoff? Or is it a sequence of disconnected shots?",
    anchors: [
      { score: 0.3, description: "Shot list with no narrative connective tissue" },
      { score: 0.6, description: "Setup + payoff but no escalation midpoint" },
      { score: 0.85, description: "Clear setup, rising stakes/tension, satisfying payoff" },
    ],
  },
  {
    id: "beat_density",
    label: "Beat density",
    operational:
      "Does every shot land one emotional or narrative beat (not zero, not two)? Dead frames lose viewers.",
    anchors: [
      { score: 0.3, description: "Multiple shots without a beat; filler" },
      { score: 0.6, description: "Most shots have a beat; one or two dead frames" },
      { score: 0.85, description: "Every shot earns its place; one beat each" },
    ],
  },
  {
    id: "show_dont_tell",
    label: "Show, don't tell",
    operational:
      "Are shots ACTION/IMAGE-described (camera moves to X, light hits Y) vs STATE-described (the woman is sad)? Penalize abstract states.",
    anchors: [
      { score: 0.3, description: 'Mostly abstract states: "the watch feels timeless"' },
      { score: 0.6, description: "Mix of action and abstraction" },
      { score: 0.85, description: "Concrete physical actions, lighting, motion in every line" },
    ],
  },
  {
    id: "brand_placement_timing",
    label: "Brand placement timing",
    operational:
      "Premium/luxury: brand mentioned late or never (let the craft speak). UGC/social: brand front-loaded. Penalize wrong-genre timing.",
    anchors: [
      { score: 0.3, description: "Mismatched: luxury front-loads logo, or UGC hides product" },
      { score: 0.6, description: "Genre-appropriate but heavy-handed" },
      { score: 0.85, description: "Genre-correct timing; brand feels earned, not inserted" },
    ],
  },
  {
    id: "surprise_factor",
    label: "Surprise factor",
    operational:
      "Is there at least one unexpected element (visual juxtaposition, tonal shift, scale change) that would break a viewer's scroll-mind?",
    anchors: [
      { score: 0.3, description: "Predictable through and through" },
      { score: 0.6, description: "One mildly surprising moment" },
      { score: 0.85, description: "A genuine surprise beat that recontextualizes the spot" },
    ],
  },
];

// ============================================================
// STORYBOARD (Phase B) — 6 aspects
// ============================================================

export const STORY_CRAFT: AspectDefinition[] = [
  {
    id: "rule_of_thirds",
    label: "Rule of thirds / negative space",
    operational:
      "Are subjects placed on third-lines or with intentional negative space? Or centered/cluttered?",
    anchors: [
      { score: 0.3, description: "Dead-center subject every shot, no breathing room" },
      { score: 0.6, description: "Mostly intentional but inconsistent" },
      { score: 0.85, description: "Consistent third-line placement, intentional negative space" },
    ],
  },
  {
    id: "shot_variety_rhythm",
    label: "Shot variety rhythm",
    operational:
      "Does the shot list alternate WS/MS/CU in a rhythm, or is it all one focal length?",
    anchors: [
      { score: 0.3, description: "All medium shots; flat rhythm" },
      { score: 0.6, description: "Some variety; one type dominates" },
      { score: 0.85, description: "Deliberate rhythm: WS → CU → MS, with payoff CU" },
    ],
  },
  {
    id: "color_progression",
    label: "Color progression",
    operational:
      "Is there a tonal arc (warm→cool, day→night, sat→desat) or a held palette? Penalize inconsistent palettes with no logic.",
    anchors: [
      { score: 0.3, description: "Random color palette per shot; no logic" },
      { score: 0.6, description: "Consistent palette but no progression" },
      { score: 0.85, description: "Intentional arc or held palette serving the narrative" },
    ],
  },
  {
    id: "subject_continuity",
    label: "Subject continuity",
    operational:
      "Across shots, is the same subject identifiable (same model, same product variant, same wardrobe)? This is the hardest property in text-to-video; penalize prompts that don't anchor identity.",
    anchors: [
      { score: 0.3, description: "Prompts make no effort to lock identity across shots" },
      { score: 0.6, description: "Identity-anchoring words present but vague" },
      { score: 0.85, description: "Specific repeated identity markers across shots" },
    ],
  },
  {
    id: "eye_line_continuity",
    label: "Eye-line / motion continuity",
    operational:
      "Across cuts, do gaze direction and motion lines respect 180°? Penalize prompts that imply axis violations.",
    anchors: [
      { score: 0.3, description: "Implied gaze/motion contradicts across cuts" },
      { score: 0.6, description: "Unclear; not specified either way" },
      { score: 0.85, description: "Explicit motion/gaze direction sustained or intentionally inverted" },
    ],
  },
  {
    id: "lighting_consistency",
    label: "Lighting consistency",
    operational:
      "Is the light SOURCE (window left, practical lamp, golden-hour) consistent across shots in the same scene? Penalize lighting that jumps inexplicably.",
    anchors: [
      { score: 0.3, description: "Lighting type/source changes every shot" },
      { score: 0.6, description: "Mostly consistent; one drift" },
      { score: 0.85, description: "Same lighting logic across all shots, intentional shifts marked" },
    ],
  },
];

// ============================================================
// VIDEO / CINEMATOGRAPHY (Phase C) — 4 aspects
// (composition and shot variety already locked from Phase B)
// ============================================================

export const VIDEO_CRAFT: AspectDefinition[] = [
  {
    id: "motion_direction_continuity",
    label: "Motion direction continuity",
    operational:
      "Across cuts, does motion sustain a direction (left-to-right or right-to-left) or is reversal intentional? Penalize random direction changes.",
    anchors: [
      { score: 0.3, description: "Motion direction reverses arbitrarily" },
      { score: 0.6, description: "Held in some cuts, broken in others" },
      { score: 0.85, description: "Sustained direction; reversals serve dramatic purpose" },
    ],
  },
  {
    id: "focal_length_logic",
    label: "Focal-length logic",
    operational:
      "Does the cut pattern have FL logic (wide-then-close, or sustained intimacy)? Penalize yo-yo: wide → close → wide → close with no narrative reason.",
    anchors: [
      { score: 0.3, description: "Focal lengths bounce randomly" },
      { score: 0.6, description: "Mostly logical; one jarring cut" },
      { score: 0.85, description: "FL progression serves the story (zoom in to the moment)" },
    ],
  },
  {
    id: "camera_movement_intent",
    label: "Camera-movement intent",
    operational:
      "Is each camera move purposeful (push-in to reveal, pan to follow) or aimless float? Penalize default drifting motion.",
    anchors: [
      { score: 0.3, description: "Default 'cinematic drift' with no purpose" },
      { score: 0.6, description: "Some intentional moves, some filler drift" },
      { score: 0.85, description: "Every move motivated by subject action or revelation" },
    ],
  },
  {
    id: "transition_smoothness",
    label: "Transition smoothness",
    operational:
      "Across cuts, do shots flow visually (color, motion, geometry) or jar? Penalize hard cuts between mismatched lighting or scale without dramatic reason.",
    anchors: [
      { score: 0.3, description: "Jarring color/scale jumps every cut" },
      { score: 0.6, description: "Mostly smooth; one or two jars" },
      { score: 0.85, description: "Considered continuity, intentional jars only" },
    ],
  },
];

// ============================================================
// JSON contract template — keeps every rubric self-consistent
// ============================================================

export function buildJsonContract<TAspect extends string>(opts: {
  aspect: TAspect;
  version: string;
  seat: number;
  candidateCount: number;
  unit: "scene" | "variant" | "shot";
}): string {
  const rows = Array.from(
    { length: opts.candidateCount },
    (_, i) =>
      `    { "n": ${i}, "score": 0.0, "issues": ["..."], "suggestion": "minimal targeted fix" }${i < opts.candidateCount - 1 ? "," : ""}`,
  );
  return [
    "JSON OUTPUT SHAPE (no markdown, no commentary, file content must start with `{` and end with `}`):",
    "{",
    `  "version": "c-${opts.aspect}-${opts.version}-seat${opts.seat}",`,
    `  "parent_draft": "${opts.version}",`,
    `  "aspect": "${opts.aspect}",`,
    '  "candidate_scores": [',
    ...rows,
    "  ],",
    '  "overall": 0.0,',
    `  "summary": "one short sentence per the operational definition above",`,
    '  "created_at": "<ISO timestamp>"',
    "}",
    "",
    "Rules:",
    `  - candidate_scores MUST have exactly ${opts.candidateCount} entries, ordered by n=0..N-1`,
    "  - `issues` is an array of strings (may be empty [])",
    "  - `suggestion` is a string with a MINIMAL TARGETED fix (preserve scene/subject; change ≤2 attributes)",
    "  - `score` and `overall` are numbers in [0,1]",
    `  - score against the operational definition + anchors above`,
    `  - emit \`DONE ${opts.aspect} seat ${opts.seat}\` when written and end the turn`,
  ].join("\n");
}

// ============================================================
// Genre-specific overlays — additional aspects activated by genre key
// ============================================================

export const GENRE_OVERLAYS: Record<string, AspectDefinition[]> = {
  comedy: [
    {
      id: "comedic_timing",
      label: "Comedic timing",
      operational:
        "Does each beat land with the right hold — neither rushed nor over-extended? Is there a deliberate pause before the punch beat?",
      anchors: [
        { score: 0.3, description: "Beats blur into each other; no pause" },
        { score: 0.6, description: "Beats land but timing is generic" },
        { score: 0.85, description: "Deliberate pause + payoff; physical timing is funny on its own" },
      ],
    },
    {
      id: "premise_clarity",
      label: "Premise clarity",
      operational:
        "Is the comedic premise legible in the first 2 seconds — what's wrong, who's involved, why we care?",
      anchors: [
        { score: 0.3, description: "Premise unclear past second 5" },
        { score: 0.6, description: "Clear by mid-spot but slow start" },
        { score: 0.85, description: "Premise locked in first 2 seconds" },
      ],
    },
  ],
  horror: [
    {
      id: "dread_build",
      label: "Dread build",
      operational:
        "Does tension accumulate via withheld information and uncomfortable hold-times rather than musical cues or jump cuts?",
      anchors: [
        { score: 0.3, description: "Relies on jump-scare or score for dread" },
        { score: 0.6, description: "Some restraint, breaks into reveal too early" },
        { score: 0.85, description: "Pure visual/sonic withholding; reveal is earned" },
      ],
    },
    {
      id: "restraint_vs_reveal",
      label: "Restraint vs reveal",
      operational:
        "Does the reveal arrive at the LATEST possible moment — and is it shown ambiguously rather than literally?",
      anchors: [
        { score: 0.3, description: "Reveal is too literal, too early, fully visible" },
        { score: 0.6, description: "Reveal is staged but on the nose" },
        { score: 0.85, description: "Reveal is suggested, partial, latest possible" },
      ],
    },
  ],
  doc: [
    {
      id: "verisimilitude",
      label: "Verisimilitude",
      operational:
        "Does the footage feel observed not staged? Naturalistic light, real ambient sound, no actor self-awareness?",
      anchors: [
        { score: 0.3, description: "Reads as styled commercial dressed up as doc" },
        { score: 0.6, description: "Mostly observed but one staged moment" },
        { score: 0.85, description: "Indistinguishable from a real verité doc" },
      ],
    },
    {
      id: "subject_dignity",
      label: "Subject dignity",
      operational:
        "Is the subject framed as an authority on their own life — not as exotic, pitiable, or a prop?",
      anchors: [
        { score: 0.3, description: "Subject feels objectified or quaint" },
        { score: 0.6, description: "Respectful but framed from outside" },
        { score: 0.85, description: "Subject's perspective is the centre of gravity" },
      ],
    },
  ],
  luxury: [
    {
      id: "craft_restraint",
      label: "Craft restraint",
      operational:
        "Is the spot minimal — does it RESIST the urge to add words, cuts, or product shots? Premium signals through removal, not addition.",
      anchors: [
        { score: 0.3, description: "Cluttered with copy, logos, multi-cuts" },
        { score: 0.6, description: "Restrained but one element too many" },
        { score: 0.85, description: "Each cut earns its place; copy is single phrase or none" },
      ],
    },
    {
      id: "brand_dignity",
      label: "Brand dignity",
      operational:
        "Is the brand allowed to be silent? No on-screen pricing, no taglines until the final frame, no narration explaining the product.",
      anchors: [
        { score: 0.3, description: "Brand name appears more than twice or with copy" },
        { score: 0.6, description: "Once but heavy-handed" },
        { score: 0.85, description: "Brand name only as a final still; nothing else" },
      ],
    },
  ],
  ugc: [
    {
      id: "scroll_stopper",
      label: "Scroll stopper",
      operational:
        "Does the first 1 second contain a pattern-break (POV unusual angle, visceral image, voice-first hook)?",
      anchors: [
        { score: 0.3, description: "Generic opener; viewer keeps scrolling" },
        { score: 0.6, description: "Decent first beat but not pattern-breaking" },
        { score: 0.85, description: "Unmissable first frame — scroll halts" },
      ],
    },
    {
      id: "authenticity",
      label: "Authenticity",
      operational:
        "Reads as filmed-by-a-real-person, not produced. Imperfect framing, vocal hesitations, ambient sound, no over-styling.",
      anchors: [
        { score: 0.3, description: "Clearly a polished agency production" },
        { score: 0.6, description: "Some unstaged texture but mostly produced" },
        { score: 0.85, description: "Indistinguishable from a creator's actual post" },
      ],
    },
  ],
  anthem: [
    {
      id: "emotional_payoff",
      label: "Emotional payoff",
      operational:
        "Is there an earned emotional climax — not stated, but built up through visual and pacing escalation?",
      anchors: [
        { score: 0.3, description: "Emotional state declared, not built" },
        { score: 0.6, description: "Build present but climax under-earned" },
        { score: 0.85, description: "Visceral payoff that lands because of what preceded it" },
      ],
    },
    {
      id: "cultural_resonance",
      label: "Cultural resonance",
      operational:
        "Does it tap a specific cultural register (place, era, community) authentically rather than generic luxury?",
      anchors: [
        { score: 0.3, description: "Stock 'global premium' — could be any brand" },
        { score: 0.6, description: "Cultural anchor present but surface-level" },
        { score: 0.85, description: "Specific, lived-in, undeniable cultural authority" },
      ],
    },
  ],
  editorial: [
    {
      id: "visual_audacity",
      label: "Visual audacity",
      operational:
        "Does the spot make decisive aesthetic choices (saturated palette, hard framing, extreme proportion) instead of safe middle-ground?",
      anchors: [
        { score: 0.3, description: "Safe; neither bold nor minimal" },
        { score: 0.6, description: "One audacious moment, rest is muted" },
        { score: 0.85, description: "Every frame is a deliberate aesthetic declaration" },
      ],
    },
    {
      id: "color_decisiveness",
      label: "Color decisiveness",
      operational:
        "Is the palette a thesis (two-three colours, deliberate) or a default (any colour goes)?",
      anchors: [
        { score: 0.3, description: "No coherent palette discipline" },
        { score: 0.6, description: "Mostly consistent palette but one drift" },
        { score: 0.85, description: "Bold limited palette acts as a signature" },
      ],
    },
  ],
  thriller: [
    {
      id: "tension_density",
      label: "Tension density",
      operational:
        "Is every shot carrying narrative tension (withheld info, off-screen sound, gaze, silence) rather than being filler exposition?",
      anchors: [
        { score: 0.3, description: "Filler exposition shots between tense beats" },
        { score: 0.6, description: "Most shots carry tension; one or two dead" },
        { score: 0.85, description: "Every shot escalates or sustains tension" },
      ],
    },
  ],
};

export function getGenreOverlay(key: string): AspectDefinition[] {
  return GENRE_OVERLAYS[key] ?? [];
}

export function renderAspectRubric(opts: {
  def: AspectDefinition;
  seat: number;
  version: string;
  candidateCount: number;
  unit: "scene" | "variant" | "shot";
  pathPrefix: string;
}): string {
  return [
    `You are CRITIC SEAT ${opts.seat} on the "${opts.def.id}" panel.`,
    `Aspect: ${opts.def.label}`,
    `Operational definition: ${opts.def.operational}`,
    "",
    "Scoring anchors:",
    ...opts.def.anchors.map((a) => `  - ${a.score.toFixed(2)}: ${a.description}`),
    "",
    `${opts.candidateCount} ${opts.unit} PROMPTS will be shown to you as TEXT in the user message below.`,
    "",
    "CRITICAL: This is a TEXT-ONLY critique. Do NOT search the filesystem for images, videos, screenshots, or any media files. There are NONE. You judge the WRITTEN PROMPTS, nothing else.",
    "Do NOT run `find`, `ls /tmp`, or any file-hunt commands looking for media. The prompts are inline in the user message.",
    "",
    "OUTPUT PROTOCOL.",
    "STEP 0: `bash` `ls /mnt/memory/` to find STORE_DIR (this is the ONLY filesystem lookup you need).",
    `STEP 1: write to /mnt/memory/$STORE_DIR/memory/critiques/${opts.pathPrefix}/${opts.def.id}-seat${opts.seat}.json`,
    "",
    buildJsonContract({
      aspect: opts.def.id,
      version: opts.version,
      seat: opts.seat,
      candidateCount: opts.candidateCount,
      unit: opts.unit,
    }),
  ].join("\n");
}
