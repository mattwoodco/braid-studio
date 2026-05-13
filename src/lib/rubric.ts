export const RUBRIC_TEMPLATE: string = `# Rubric

Produce an mp4 reflecting the brief. Each shot must be vivid. Final compose must verify with ffprobe and end with the file uploaded to a public URL.

## Versioned Draft Envelopes

This project stores every generation as an immutable, append-only envelope under \`/memory/drafts/\`. The store is treated as an append-only log: past versions are never overwritten or mutated. Each new draft is created via a fresh \`createMemory\` call at a new path.

- Every new draft writes to \`/memory/drafts/{version}.json\` where \`{version}\` is a monotonic identifier like \`v1\`, \`v2\`, \`v3\`, ... Version numbers increase strictly and are assigned by numeric suffix (so \`v10\` follows \`v9\`, not \`v1\`).
- The current pointer lives at \`/memory/drafts/HEAD.json\` and contains \`{ version, updated_at }\`. The HEAD pointer can be updated via the head endpoint (\`POST /api/projects/[storeId]/drafts/head\`); it is the only mutable record. **Never overwrite past versions** — only HEAD advances, and only by repointing.
- Each envelope records its \`parent\` (the prior version it descends from, or \`null\` for the very first draft \`v1\`). This forms a lineage chain so the UI can render history and so constraint/critique flows can reuse parent shots.
- Each envelope records a \`reason\` string that is the human-readable label for why this version exists. Canonical \`reason\` values include:
  - \`create\` — a fresh generation from the brief.
  - \`sweep:axis=...,value=...\` — one variant of a parameter sweep (siblings share a \`sweep_run_id\`; HEAD does not advance on sweeps).
  - \`constrain:locked=[...]\` — a re-generation that reuses specific shots from the parent.
  - \`critique:...\` — a revision produced by a critique → revise agent loop.
  - \`chat:...\` — a refinement produced by a conversational follow-up in studio.
- Each envelope records \`locked_shots\`: the array of shot indices that were reused verbatim from the \`parent\` envelope (empty for \`create\` and \`sweep\` reasons). The video backend skips generation for any locked index and copies the parent's \`video_url\` for that shot into the new envelope.

The one rule: **every producer appends a new envelope; HEAD is just a pointer; history is append-only.**
`;
