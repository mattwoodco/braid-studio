# Source Ledger

## Primary — Anthropic Managed Agents (local docs, official)
- Claude Managed Agents overview, Get started, Define your agent, Define outcomes, Start a session, Multiagent sessions, Session event stream, Using agent memory, Subscribe to webhooks, Permission policies, Container reference, Cloud environment setup, Authenticate with vaults, Accessing GitHub, Prototype in Console, Agent Skills, Skills, Skill authoring best practices, Tools, MCP connector, Remote MCP servers, Files API, Adding files, PDF support, Vision, Dreams — all under `docs/Managed Agents Research/`.

## Primary — current braid-studio source (audited)
- `src/lib/anthropic.ts`, `briefs.ts`, `drafts.ts`, `critique.ts`, `critic-panel.ts`, `craft-rubrics.ts`, `claude-judge.ts`, `taste.ts`, `pattern-miner.ts`, `video-backend.ts`, `video-rubric.ts`, `fal.ts`, `fal-image.ts`, `ffmpeg.ts`, `checkpoint.ts`
- `scripts/full-pipeline.ts`, `full-pipeline-v2.ts`, `full-pipeline-v3.ts`, `supervisor.ts`, `sentinel.ts`, `exec-demo.ts`, `phase-c-from-stills.ts`
- `src/app/api/projects/[storeId]/{draft,critique,studio,dreams,drafts}/...`

## Cinematography & shot grammar
- Runway Gen-3/Gen-4 prompting guides; Google Cloud Veo 3.1 guide; OpenAI Cookbook Sora 2; fal.ai Kling/Veo guides; Magic Hour Kling 3.0; StudioBinder camera-shot/lighting taxonomies; Julia Trotti focal-length comparison; PhotoPills golden/blue hour; AAA Presets color grading; MasterClass 180° rule.

## Ad effectiveness science
- System1 (Wood, "Achtung!", three keys, Test Your Ad, Star/Spike/Fluency); Karen Nelson-Field / Amplified Intelligence (1.5-second attention formula); Binet & Field "Long and Short of It"; Byron Sharp / Ehrenberg-Bass (Distinctive Brand Assets, Mental Availability); Kantar LINK+ STSL.

## Character & setting
- CGWire, CharacterHub, 21 Draw, Spines, Where Creativity Works (model sheets); Ipsos / IADS mascot research; Midjourney --cref docs; HuggingFace IP-Adapter-FaceID; Runway Gen-4 research; ElevenLabs Voice Design / PVC docs; Pressbooks Moving Pictures (mise-en-scène); Asteria Continuum Suite (Variety/Deadline/IndieWire/No Film School); Polycam / Nerfstudio / INRIA 3D Gaussian Splatting; Runway Text-to-Color Grade.

## Pipeline efficiency
- Runway Gen-4 pricing; AI video pricing comparisons (vo3ai, TeamDay); Ability.ai 233M-view ad workflow; LTX Studio storyboard/animatics; Higgsfield Popcorn / Soul ID; Kling 2.1/2.5/O1 start+end frame docs; Runway image-as-last-frame; ComfyUI ControlNet/IP-Adapter; Topaz Video AI; Magnific Video Upscaler; Anthropic Advisor Strategy; Claude API pricing.

## Competitive teardown
- Arcads, Creatify AdFlow, Pictory, HeyGen Avatar V, Synthesia, LTX Studio, Google Flow + Veo 3, Sora 2 advertising notes, Promise MUSE (Google DeepMind), Asteria Continuum, Coca-Cola/WPP/NVIDIA Prod X, Adobe Firefly/Premiere.

## Orchestration / judging
- Anthropic "Building Effective Agents"; Anthropic Constitutional AI; LangGraph / LangChain HITL docs; CrewAI vs LangGraph vs AutoGen comparisons (2026); arXiv Multi-Agent Judge / MAJ-Eval; Amazon Science LLM-as-judge multi-agent; Evidently AI LLM-judge guide; OpenReview "Justice or Prejudice"; bMAS blackboard MAS.

## Audio
- ElevenLabs v3 / Voice Design / Sound Effects / pricing; Suno v4/v5 vs Udio vs Stable Audio (Chartlex, aicompetence); Hedra Character-3 / Omnia; Veo 3.1 / Sora 2 / Seedance 2.0 / Kling 3.0 native-audio comparisons (Lushbinary); film-score / picture-to-score editorial conventions.
