# plans/

**Answers: what we intend to do.** Implementation plans, roadmaps, design docs. Archive when done.

## Index

| File | Answers |
|---|---|
| [2026-09-29-laines-roadmap.md](2026-09-29-laines-roadmap.md) | The five v1 milestones (M1–M5), what each delivers, and which spec sections it covers |
| [2026-09-29-laines-m1-foundation-plan.md](2026-09-29-laines-m1-foundation-plan.md) | Task-by-task implementation plan for M1: package scaffold, machine index, config, board, templates, `init`, `config get`, `doctor` |
| [2026-09-29-laines-m2-lanes-plan.md](2026-09-29-laines-m2-lanes-plan.md) | Task-by-task implementation plan for M2: lane detection, lane state store, containment, lane files, `create`, `brief`, `report`/`keep`/`release`/`list`/`status`, `teardown`, `watch`, doctor lane checks |
| [2026-09-29-laines-m3-hooks-plan.md](2026-09-29-laines-m3-hooks-plan.md) | Task-by-task implementation plan for M3: hook discovery and approval store, hook runner, policy-aware event runs, `post-create`/`refresh`/`setup-failed`, `pre-`/`post-teardown`, `hooks status/approve/policy`, doctor hook checks |
| [2026-10-01-laines-m4-mcp-plan.md](2026-10-01-laines-m4-mcp-plan.md) | Task-by-task implementation plan for M4: command registry with capabilities and locked mode, `config set`, server hardening, `laines-mcp` tools, teardown over MCP with elicitation, `.mcp.json` wiring, audit coverage |
| [2026-10-02-laines-m4.5-adopt-design.md](2026-10-02-laines-m4.5-adopt-design.md) | M4.5 design: `laines adopt` (turn an existing checkout into a container with it as lane_1), the shared `.ai/` seeding, and `laines ai sync` (three-way container ↔ lane sync so knowledge travels in PRs) |
| [2026-09-29-laines-spec.md](2026-09-29-laines-spec.md) | L.AI.nes v1 specification: purpose, layout, commands, data, agent integration, hooks, safety, flows, testing, success criteria |
