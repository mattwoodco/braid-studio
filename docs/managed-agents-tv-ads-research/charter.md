# Charter — Managed Agents for TV-Grade Video Ads

## Research question
Design **three alternative infrastructures** that use Claude Managed Agents to produce best-in-class TV video ads, structured so that **expensive video generation is the terminal stage**, not the first.

## Inputs
1. `docs/Managed Agents Research/` — 26 official-doc captures (overview, sessions, memory, multiagent, dreams, skills, MCP, vaults, webhooks, Vision, Files API).
2. Current braid-studio pipeline (`src/lib/`, `scripts/`, `src/app/api/projects/[storeId]/`).
3. Live Managed Agents endpoint shapes for memory/session/multiagent (verified against captured docs).
4. Web research: ad script craft, character/setting/shot grammar, efficient incremental pipelines, competitive teardowns, audio-first sequencing, 3D-proxy pipelines, LLM-as-judge.

## Constraints
- All three architectures must use Claude Managed Agents (Sessions, Memory Stores, Multi-Agent, Outcomes, Dreams, MCP) as the substrate.
- Every architecture must enforce a **cheap → expensive gate** before any paid video API call.
- Architectures must differ along a meaningful axis (orchestration topology, source of constraint, fidelity ceiling).
- Output must be actionable: name the agents, the memory schema, the gates, and the cost envelope.

## Definition of done
- `final-report.md` and `docs/EXECUTIVE_IMPROVEMENT_PLAN.md` deliver three named, comparable architectures with diagrams, cost models, and a recommended migration path from the current braid-studio code.
