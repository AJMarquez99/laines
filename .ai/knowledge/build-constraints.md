# Build constraints

Durable facts and rules that shape how L.AI.nes is built. Established during design research
(2026-09-28); update when a fact changes.

## Architecture pattern

- Two front-ends, one command layer: `bin/laines.js` (CLI) and `bin/laines-mcp.js` (MCP server)
  both call the same `src/commands/*` functions. Gating lives in the command layer or a shared
  choke point, never re-implemented per front-end.
- Commands are `runXxx(opts, deps)`: return plain data, throw typed errors, never print or set
  exit codes. `src/deps.js` (`defaultDeps`) is the only place real side effects are constructed
  (fs, git, child processes, hook execution, docker, clock, prompts).
- `src/cli.js` has a single `handle()` wrapper: maps positionals to opts, renders JSON by default
  (`--format table` opt-in), maps errors to exit codes.
- `src/mcp/tools.js` is an SDK-agnostic table `{ name, description, inputSchema, command,
  mapArgs }`. `mapArgs` is the whitelist of what reaches a command. Any throw becomes an
  `isError` result; the server never crashes.
- One JSON parse choke point for config; malformed JSON is a typed error (exit 2), never a raw
  `SyntaxError`.
- Stack: ESM, Node >= 22.12, `commander`, `zod`, `@modelcontextprotocol/sdk`; `vitest` for tests.

## Exit codes (contract)

`0` ok (including dry-run) · `1` unexpected/external failure · `2` user-fixable input or config
· `3` blocked by a safety boundary · `4` capability denied.

## Safety rules for destructive operations

- The boundary is human-owned: container root, remote URL, config, and hooks cannot be changed
  by an agent. No `init`, config-write, or hook-install tools over MCP.
- No bypass arguments over MCP. `--force` exists on the CLI only; MCP schemas must not declare it
  and `mapArgs` must drop it even if injected. A test iterates the whole tools table to enforce
  this.
- Every side-effecting command supports `--dry-run`: a true no-op (no write, no hook, no audit
  line) that reports what would happen at exit 0.
- Containment: a lane path must resolve (lexically and via `realpath`) inside the container and
  match the lane naming pattern before anything is deleted.
- Metadata-only audit log (JSONL) for create/teardown; an audit-write failure warns but never
  fails the action.
- Any command path without an explicit capability decision is a bug — a coverage test walks the
  command tree.

## Consuming dot-ai

- Invoke the bundled dot-ai CLI; it has no programmatic API and its `src/` internals are not a
  supported surface. Pin `^1.1.x`.
- It operates on the current working directory only: spawn it with `cwd` set to the container.
- Non-interactive when given an agent flag (`--claude`, `--all`, ...). Logs go to stderr; rely
  on exit codes (`0` ok, `1` error, `2` usage/config), not output parsing.
- It owns the region between `<!-- BEGIN .ai-convention -->` and its `END` marker in agent
  config files, and folder-README regions between `.ai-folder` markers. L.AI.nes content goes
  **after** those END markers, inside its own `<!-- BEGIN laines-lanes -->` markers; `dot-ai
  sync` preserves it.
- dot-ai treats the nearest `.ai/` as a full layer. Running `dot-ai init`/`sync` inside a lane
  scaffolds all folders into the lane's partial `.ai/` — lane instructions must forbid it and
  `laines doctor` should detect it.

## Agent instruction discovery (verified 2026-09-28)

- **Claude Code** (2.1.284): loads `CLAUDE.md` from every ancestor directory, including above the
  git root, plus `CLAUDE.local.md`. A container-level `CLAUDE.md` reaches every lane; a plain
  checkout outside a container never sees it.
- **Codex CLI**: walks up only to the project root (nearest `.git` by default,
  `project_root_markers` in the user config). A container-level `AGENTS.md` is not loaded from a
  lane. `AGENTS.override.md` *replaces* the sibling `AGENTS.md` rather than adding to it.
- **Gemini CLI**: walks up only to the project root (`context.memoryBoundaryMarkers`, default
  `.git`). No `GEMINI.local.md`; `context.fileName` can list several names, and
  `context.includeDirectories` can add the container.
- **Claude Code permission settings** do not cascade like `CLAUDE.md`: a container-level
  `.claude/settings.json` has no effect in a lane (a separate git repo); a lane-level
  `.claude/settings.local.json` does.
- **MCP elicitation** (Claude Code >= 2.1.76) prompts the human even when a subagent triggers it.
  Claude `Elicitation`/`ElicitationResult` hooks can alter answers, so elicitation is a strong
  but not absolute human-confirmation channel.
- `.git/info/exclude` hides lane-local files from `git status` without touching the repo's
  `.gitignore`.

## Packaging and release

- npm renames a shipped `.gitignore` to `.npmignore` at pack and install. Ship ignore templates
  undotted and rename on copy; a real `npm pack` + install round-trip test is the only reliable
  check.
- `publishConfig.access: public` (scoped package); explicit `files` allowlist that includes every
  runtime-read template; `.gitattributes` pins LF on executables.
- Tag-driven publishing from CI with OIDC trusted publishing; `prepublishOnly` runs the one-shot
  test script.

## Public repository

- Content in the repo, including `.ai/`, is written for outside readers: no personal paths,
  emails, account names, or references to private material. Scrub history before the first
  public push.
