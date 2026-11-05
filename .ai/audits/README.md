# audits/

**Answers: what was true at time T.** Point-in-time assessments, such as field reports from adopting real
projects, reviews and checks. Unlike `knowledge/`, these are dated snapshots, not durable truth.

## Index

| File | Answers |
|---|---|
| [2026-10-03_myapp-adoption.md](2026-10-03_myapp-adoption.md) | How adopting myapp (API + Compose + Vite, commits `.ai/`) went with laines 0.1.0: what worked, two major issues (lane_1's Compose project orphans the DB; `ai sync` commits index rows for laines-only files) and smaller feedback; plus a same-day follow-up confirming both fixes and one new major issue (lane exclude ignores new files in a tracked `.ai/plans/`) |
| [2026-10-30_1.0.0-pre-release-agent-checks.md](2026-10-30_1.0.0-pre-release-agent-checks.md) | The M5 pre-release agent checks (plan §3) against the 0.4.13 tarball from `staging` with Claude Code 2.1.314: instructions reach the lane (C1, C2), the lane's deny rules block all 18 human-only invocations (C3; `npx -y` / `@version` forms not denied, as D8 expects), MCP teardown refuses without a human (C7), doctor flags Elicitation hooks (C9), the lane's MCP server loads (C12); C5, C6, C8 pending with the user, C10 post-1.0, C11 not run (no Codex/Gemini) |
