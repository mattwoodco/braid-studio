/**
 * Three representative briefs covering distinct quadrants of the genre × angle
 * matrix. Used by the full-pipeline sweep.
 */

export type Brief = {
  id: string;
  /** Display name, exec-facing. */
  name: string;
  genre: string;
  product: string;
  format: string; // e.g., "30s teaser"
  angle: string; // "cinematic" | "social-first / UGC" | "doc-style"
  /** Free-form creative brief; fed to the script generator. */
  brief: string;
  /** Target number of scenes/shots for the final video. */
  shotCount: number;
  /** Genre key for picking genre-specific rubric overlays. */
  genreKey:
    | "luxury"
    | "ugc"
    | "doc"
    | "horror"
    | "comedy"
    | "anthem"
    | "editorial"
    | "thriller";
};

export const BRIEFS: Brief[] = [
  // --- v2 baseline (kept for back-compat) ---
  {
    id: "luxury-timepiece-cinematic",
    name: "Heirloom Mechanical Watch — Cinematic Teaser",
    genre: "Luxury",
    product: "Mechanical wristwatch",
    format: "30s teaser",
    angle: "cinematic",
    genreKey: "luxury",
    brief: [
      "A 30-second teaser for an heirloom mechanical wristwatch.",
      "Three generations of one family: grandfather's wrist, father at his desk, daughter in Paris at golden hour.",
      "Warm tonal palette, intentional camera motion, intimate scale, sense of time being handed forward.",
      "Premium Madison-Avenue craft; minimal copy.",
    ].join(" "),
    shotCount: 5,
  },
  {
    id: "performance-sneaker-ugc",
    name: "Trail-Runner Sneaker — Social-First UGC",
    genre: "Sports / Activewear",
    product: "Trail-running sneakers",
    format: "15s vertical ad",
    angle: "social-first / UGC",
    genreKey: "ugc",
    brief: [
      "A 15-second vertical social ad for new trail-running sneakers, in a creator-led UGC voice.",
      "First-person handheld; sweaty, real, immediate. Mud, trail, breath visible in cool morning air.",
      "Hook in first second. Show the shoe's grip in the mud. End on a confident, unposed look at the camera.",
      "Energetic; no luxury polish; feels filmed on a phone.",
    ].join(" "),
    shotCount: 4,
  },
  {
    id: "indie-thriller-trailer",
    name: "Indie Thriller — Doc-Style Teaser",
    genre: "Indie thriller film",
    product: "Trailer for a fictional thriller film",
    format: "20s teaser",
    angle: "doc-style / found-footage",
    genreKey: "thriller",
    brief: [
      "A 20-second teaser for an indie thriller called \"The Lamp Click\".",
      "A woman alone in a noir-lit apartment. A lamp clicks off by itself. Footsteps in the hallway. A shadow at the doorway.",
      "Doc-style hand-held framing, naturalistic light from one practical source, breathy ambient, no music.",
      "Builds dread fast; ends on a quiet beat that lingers.",
    ].join(" "),
    shotCount: 5,
  },

  // --- v3 expansion: 8 new genre-diverse briefs ---
  {
    id: "afrofuturist-album-trailer",
    name: "Afrofuturist Album — Trailer",
    genre: "Music — Afrofuturism",
    product: "Studio album",
    format: "30s teaser",
    angle: "cinematic sci-fi",
    genreKey: "anthem",
    brief: [
      "A 30-second visual album trailer in an Afrofuturist register.",
      "A Black artist in iridescent fabric stands on red Martian sand; a glass orb echoes their voice; constellations open behind them; a synthesizer pulses to a slow heartbeat; the title appears as glyphs forming from sand.",
      "Bold colour: deep red, gold, electric violet, obsidian. Slow majestic camera. Sense of myth and lineage.",
      "Cannes-Lions-craft level; no spoken voiceover.",
    ].join(" "),
    shotCount: 5,
  },
  {
    id: "tokyo-noodle-doc",
    name: "Tokyo Street Noodle Shop — Documentary",
    genre: "Food documentary",
    product: "Episode 1 of a streaming doc series",
    format: "60s teaser",
    angle: "doc-style / verité",
    genreKey: "doc",
    brief: [
      "60-second teaser for a streaming documentary about a 73-year-old ramen master in a Shinjuku alley.",
      "His hands cutting noodles; steam rising; broth pouring; first slurps from anonymous regulars; lights of the alley at night.",
      "Verité hand-held, ambient sound only, natural light, no music, no narration.",
      "Earn the intimacy. Restrained, no luxury polish, no over-styling.",
    ].join(" "),
    shotCount: 6,
  },
  {
    id: "comedy-bank-app-ugc",
    name: "Neobank Mobile App — UGC Comedy",
    genre: "Comedy / FinTech",
    product: "Mobile banking app",
    format: "15s vertical viral",
    angle: "first-person UGC / comedy",
    genreKey: "comedy",
    brief: [
      "15-second vertical social ad in an awkward first-person UGC comedy register.",
      "A 20-something at a bodega checkout panics, drops everything, then triumphantly taps phone — payment lands instantly — exhales theatrically — clerk gives slow nod of respect.",
      "Phone-shot energy, jump cuts, on-screen text caption per beat, real bodega sound, no music until last beat.",
      "Funny first; product second. Hook in first 1 second.",
    ].join(" "),
    shotCount: 4,
  },
  {
    id: "fragrance-arthouse-anthem",
    name: "Niche Fragrance — Arthouse Anthem",
    genre: "Luxury / Fragrance",
    product: "Niche perfume — 'Aether No. 7'",
    format: "30s anthem",
    angle: "arthouse / surreal",
    genreKey: "luxury",
    brief: [
      "30-second arthouse fragrance anthem in the style of a Tom Ford / Loewe / Maison Margiela campaign film.",
      "A figure walks through a Brutalist concrete corridor toward a single shaft of light; petals fall in slow motion; a bottle revolves on a white pedestal; a hand traces a marble surface; final image is the bottle alone in negative space.",
      "Bone, ivory, alabaster palette; minimal motion; single sustained string note; no narration; brand name only at the end.",
      "Cannes craft, restraint, dignity. Less is more.",
    ].join(" "),
    shotCount: 5,
  },
  {
    id: "vintage-camera-confessional",
    name: "Vintage Camera — Confessional Monologue",
    genre: "Consumer electronics / Personal",
    product: "A refurbished 35mm film camera, marketing campaign",
    format: "20s vertical",
    angle: "personal confessional / handheld",
    genreKey: "ugc",
    brief: [
      "20-second vertical ad: a creator speaks directly to camera about why they switched back from digital to a vintage 35mm camera.",
      "Intercut with their hands loading film, the camera advance lever, contact-sheet prints drying on a line, then back to them mid-sentence.",
      "Handheld, mid-distance, available window light. Honest, unpolished, slightly nervous; no jump cuts in the to-camera takes.",
      "Hook is the first sentence they say. End on the click of the shutter.",
    ].join(" "),
    shotCount: 5,
  },
  {
    id: "ev-cinematic-anthem",
    name: "Electric SUV — Cinematic Anthem",
    genre: "Automotive / Luxury",
    product: "New electric SUV",
    format: "60s anthem",
    angle: "cinematic large-format",
    genreKey: "anthem",
    brief: [
      "60-second cinematic anthem for a new electric SUV.",
      "Sunrise on a misty mountain road; a family laughs inside the cabin; instrument cluster glows; tires hiss on wet asphalt; the SUV emerges from a tunnel into glaring light; child's hand traces condensation on glass; final hero shot, vehicle silhouetted against an alpine ridge.",
      "Anamorphic large-format aesthetic, warm-to-cool palette progression, sweeping camera motion, swelling orchestral score implied by pacing.",
      "Must feel emotionally earned — not a spec sheet.",
    ].join(" "),
    shotCount: 6,
  },
  {
    id: "indie-horror-bathroom-teaser",
    name: "Indie Horror — Bathroom Mirror Teaser",
    genre: "Horror",
    product: "Trailer for fictional horror short 'The Other Face'",
    format: "20s teaser",
    angle: "slow-build dread",
    genreKey: "horror",
    brief: [
      "20-second slow-build horror teaser. A woman brushes her teeth in a fluorescent bathroom. The mirror's reflection blinks one beat later than she does. She freezes. She leans in. The reflection smiles.",
      "Hard practical fluorescent overhead, eggshell tile, no score, only sink water and the tube of toothpaste. Hold shots longer than comfortable; everything is mundane until it isn't.",
      "Restraint over jump-scare. The whole spot earns its final two-second reveal.",
    ].join(" "),
    shotCount: 5,
  },
  {
    id: "fashion-editorial-runway",
    name: "Fashion Editorial — Runway Preview",
    genre: "Fashion editorial",
    product: "Capsule collection launch",
    format: "30s teaser",
    angle: "high-fashion editorial",
    genreKey: "editorial",
    brief: [
      "30-second editorial teaser for a capsule menswear collection.",
      "Models step out of a freight elevator in succession; one walks a long concrete hallway lined with neon; close-up of stitching on a coat lapel; a tailor's hand smoothing a sleeve; final model pauses, looks straight to lens, then turns away.",
      "Saturated colour palette: ultramarine + tangerine; hard rectangular framing, minimal motion, decisive cuts.",
      "Audacious, decisive, no apology.",
    ].join(" "),
    shotCount: 5,
  },
];
