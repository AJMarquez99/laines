# L.AI.nes v1 — roadmap

Implements `2026-09-29-laines-spec.md` in five milestones. Each milestone gets its own detailed
implementation plan, written once the previous milestone has landed, so it is planned against
real code. Each milestone ends with working, tested software.

| # | Milestone | Delivers | Spec sections | Plan |
|---|---|---|---|---|
| M1 | Foundation + container | Package scaffold, errors/JSON/lock libs, machine index (IDs, port blocks), container config, lanes state + board renderer, templates and agent wiring, bundled dot-ai, `laines init`, `laines config get`, `laines doctor [--prune]` (container checks) | §1–4, §5 (init/config get/doctor), §6, §7.3 (container block), §9.2 (container deny rules), §10.1, §11, §12 | `2026-09-29-laines-m1-foundation-plan.md` ✅ done |
| M2 | Lanes | `create` (clone, branch, lane files, excludes, env file, lane deny rules, lane-local `AGENTS.md`/`GEMINI.md`), lane-mode detection, `list`, `status`, `report`, `brief`, `keep`, `release`, `teardown` with all safety checks and containment, `watch`, activity overflow archive, doctor lane checks and agent reach | §5, §6.2–6.4, §7.1–7.4, §9.1, §9.4, §10.2–10.3, §11 | 2026-09-29-laines-m2-lanes-plan.md ✅ done |
| M3 | Hooks | Hook runner and contract, `.d/` ordering, timeouts, exit 3, policies and checksums, `hooks status/approve/policy`, `refresh`, `setup-failed`, stability suggestion, board requests | §8, §10.2 step 5–6, §10.3 step 4 and 7 | 2026-09-29-laines-m3-hooks-plan.md ✅ done |
| M4 | MCP + safety | `laines-mcp`, tools table, capabilities (exit 4), locked mode, `teardown.mcp` with elicitation and fallback, `config set`, guard tests (no bypass args, human-only tools absent, deny-rule coverage), audit coverage | §5 (MCP column), §6.1, §9.2–9.5 | 2026-10-01-laines-m4-mcp-plan.md ✅ done |
| M5 | Release | README, SECURITY (threat model and residual risks), CONTRIBUTING, CI (lint + audit, tests on Node 20/22/24 × macOS/Linux, OIDC release), `npm pack` round-trip test, pre-release agent checks (instructions, deny rules, elicitation incl. headless and VS Code, Codex root markers), repo protection, history scrub, remove `reference/` | §12, §13, §14, §15 | written after M4 |
