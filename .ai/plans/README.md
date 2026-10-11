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
| [2026-10-02-laines-m4.5-adopt-plan.md](2026-10-02-laines-m4.5-adopt-plan.md) | Task-by-task implementation plan for M4.5: `.ai/` tree library, `laines ai sync`, `init` seeding from the remote, `laines adopt`, doctor drift checks and docs |
| [2026-10-03-laines-m4.6-adopt-fixes-plan.md](2026-10-03-laines-m4.6-adopt-fixes-plan.md) | M4.6 plan: fixes from the first real adoption (myapp) — Compose identity for adopted lane_1, `_`-prefixed laines files, exclude block, doctor notes, sync reasons |
| [2026-10-04-laines-m4.7-generic-fixes-plan.md](2026-10-04-laines-m4.7-generic-fixes-plan.md) | M4.7 plan: repo-agnostic fixes from the first adoptions — lane plans follow what the repo commits, refresh completes laines' own migrations and shows every write, adopted lanes keep the project's ports, toolchain docs |
| [2026-10-07-laines-0.4.8-mcp-forced-teardown-plan.md](2026-10-07-laines-0.4.8-mcp-forced-teardown-plan.md) | 0.4.8 patch plan: forced teardown over MCP behind a typed human confirmation (`teardown.mcpForce`), sibling-lane holdings in teardown prompts and refusals, example pre-teardown cleanup |
| [2026-10-10-laines-0.4.9-closed-lane-gaps-plan.md](2026-10-10-laines-0.4.9-closed-lane-gaps-plan.md) | 0.4.9 patch plan (DRAFT, awaiting approval): closed lanes with a leftover clone (doctor, create numbering, MCP clean-up incl. a decision on typed force for closed lanes), "also delete the clone" in the first teardown form, stale laines-mcp shown |
| [2026-09-29-laines-spec.md](2026-09-29-laines-spec.md) | L.AI.nes v1 specification: purpose, layout, commands, data, agent integration, hooks, safety, flows, testing, success criteria |
