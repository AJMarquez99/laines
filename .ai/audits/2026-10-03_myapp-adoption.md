# Adopting myapp with laines 0.1.0

**Date:** 2026-10-03 · **laines:** 0.1.0 (`laines` (global install)) · **Project:** `~/work/myapp`
(an API + Postgres in Docker Compose + a Vite frontend; commits its `.ai/`; private remote).
**Done by:** a Claude Code session following the user's adopt instructions (steps 2–6), with the dev stack stopped
beforehand and the repo clean and pushed.

## Verdict

**Adopt itself was smooth and safe.** The project ended up in `lane_1/` with git untouched, the stack ran unchanged
from the new path after the documented fix-ups, and `laines doctor` passed every check.

**Two real problems need fixing before this is safe to hand to lane agents:**
1. An adopted `lane_1`'s `.laines.env` points Docker Compose at a new, empty database project.
2. `laines ai sync` would commit index rows for laines-only files the lane never receives.

## What happened, step by step

| Step | Result |
|---|---|
| `laines adopt --dry-run` | Clear JSON preview: id `myapp`, block 20000–20199, `lane_1` ports 20000–20009, `ai.mode: seed` (20 files), the container files it would write, and one warning about `api/.venv` holding absolute paths. Nothing was written. |
| `laines adopt` | Same plan executed; `next` listed exactly the follow-ups (`cd`, recreate the venv, stop old dev servers and reopen editors, project memory now belongs to the container, `laines create`). Container = `.ai/ .claude/ .laines/ .mcp.json CLAUDE.md lane_1/`. |
| Lane hygiene | `git status` in `lane_1` clean. Lane-only files (`.laines.env`, `.mcp.json`, `CLAUDE.local.md`, `.ai/.lane.json`) kept out of git through `.git/info/exclude`, so nothing leaked into the repo. |
| Step 3.1 `.env` pin | `COMPOSE_PROJECT_NAME=myapp` in `.env` → `docker compose ps` showed the existing `myapp-dev-postgres` (project `myapp`, up 3 days). See issue 1 for the catch. |
| Step 3.2 venv | `command rm -rf .venv && uv sync` worked; `VIRTUAL_ENV` changed from `…/myapp/api/.venv` to `…/myapp/lane_1/api/.venv`. |
| Step 3.3 stack | `db:up`, API on 8000 and Vite on 5180 all came up with the existing seeded data; the test suite passed and `tsc -b` was clean from `lane_1`. |
| Step 4 doctor/status | All 16 checks ✓ (marker, config, machine index, dot-ai, agent files, 18 deny rules, MCP, board, locks, lanes state, hooks, ai-sync base, lane, agent reach, elicitation hooks). The expected note on `lane_1`: `.ai/ differs in 2 file(s)`. `status`: one lane, `lane_1`, idle on `main`, 20000–20009. |
| Step 6 `ai sync --dry-run` | `toLane: [runbooks/README.md, templates/README.md]`, nothing to the container, no conflicts. **I did not run the real sync** because of issue 2. |

## Issues

### 1. Major: an adopted `lane_1`'s Compose project orphans the existing database
`lane_1/.laines.env` sets `COMPOSE_PROJECT_NAME="myapp-l1"`, and the lane rules (container `CLAUDE.md`, rule 6) tell
agents to *source `.laines.env` before starting services*. A variable in the shell overrides `.env`, so the
documented `.env` pin only works while nobody follows rule 6.

Verified in `lane_1`:

| | Compose project | Volume | Result |
|---|---|---|---|
| plain `docker compose ps` | `myapp` | `myapp_myapp_dev_pgdata` (the real data) | finds the running container |
| after `set -a; . ./.laines.env` | `myapp-l1` | `myapp-l1_myapp_dev_pgdata` (doesn't exist) | finds nothing |

For myapp, `db:up` would then most likely fail on the hardcoded `container_name: myapp-dev-postgres` that's
already in use. A project without a fixed `container_name` would silently start on an **empty** database, which is
worse.

The scoped name follows `lessons/design-for-many-projects-and-containers.md` and is right for *new* lanes.
**Adoption is the exception:** `lane_1` *is* the original checkout and owns existing state. Suggestions:
- On adopt, write `lane_1`'s `COMPOSE_PROJECT_NAME` as the project's original effective name (the basename of the
  original folder, or an existing `COMPOSE_PROJECT_NAME` from `.env`), or leave it out for `lane_1`. Record it in
  lane state so `refresh` keeps it.
- Or detect it: in `adopt`/`doctor`, compare `docker compose ls` and volume names for the old project against the
  lane's, and warn "lane_1 would use a new Compose project; existing volumes belong to `<old>`".
- At minimum, the adopt instructions and the lane rules should say the same thing. Today the user's `.env` fix and
  rule 6 contradict each other.

### 2. Major: `ai sync` would commit index rows for files the lane never gets
Adopt adds laines-owned files to the container's `.ai/` (`runbooks/lane-management.md`, `templates/lane-ai-readme.md`,
`lane-context-readme.md`, `lane-plans-readme.md`, `lane-local-instructions.md`) and adds their rows to
`runbooks/README.md` and `templates/README.md`.
- The sync excludes those files: the dry-run didn't offer them, even though the adopt design's "synced set" rule would
  include them.
- But it **does** sync the two READMEs. The first PR would therefore commit five index links to files that aren't
  in the repository.
- Lane rule 2 forbids hand-editing the lane's committed `.ai/`, so an agent can't repair it either.

Suggestions, any of which works:
- **Strip laines-owned rows** from indexes on the way to a lane.
- **Keep laines' files out of indexed folders:** use a `_`-prefixed name (already excluded, and indexed only in a
  gitignored `_README.md` by the dot-ai convention), or keep them under `.laines/`.
- **Sync them too**, if they're meant to be shared.

Add a test: adopt a repo that commits `.ai/`, run `ai sync`, and assert that every index row in the lane links to a
file that exists in the lane.

### 3. Minor: `.git/info/exclude` lists files the repo tracks
The lane's exclude block lists `/AGENTS.md` and `/GEMINI.md`, but myapp tracks both. Git ignores exclude rules for
tracked files, so nothing broke and the lane is clean. But it's misleading, and if laines ever writes lane-specific
copies they'll show up as modified tracked files. Consider excluding only files laines creates *and* the repo doesn't
track (check `git ls-files`), as already happens for `CLAUDE.md` through `CLAUDE.local.md`.

### 4. Minor: instruction details that didn't match myapp
- "vite's default 5173": myapp pins Vite to **5180** (`vite.config.ts`). Readings of a project's ports should come
  from its config, not stack defaults. This matters once lanes get their own stacks.
- The limit note (lanes can't run their own stack while ports and `container_name` are hardcoded) was accurate and
  useful.

### 5. Readability nits
- In `doctor`, the informational note (`.ai/ differs in 2 file(s)`) is rendered with the same ✓ as passing checks.
  A distinct marker (e.g. `•` or `note`) would make "everything ok, one thing to act on" quicker to read.
- `ai sync --dry-run` lists files but not *why* each moves (new / changed on one side). One word per file would
  make the issue 2 situation obvious at a glance.

## What worked especially well
- **Dry run equals real run:** the file list, ports and warnings were identical, so the preview could be trusted.
- **Non-destructive:** git status, history, tracked files, `node_modules` and `dist` all survived the move, and
  lane-only files stayed out of git.
- **Actionable warnings:** the venv warning named the exact path and fix, and `next` covered the less obvious
  follow-ups (stale dev servers and editors, Claude project memory moving to the container).
- **Doctor coverage:** 16 checks spanning machine index, locks, MCP registration, deny rules, board, hooks and
  ai-sync base gave real confidence that the container was wired correctly.
- **Port allocation** from the machine index (20000–20199) with no collisions.

## State left behind
- **Container:** `~/work/myapp` is a laines container.
- **lane_1:** on `main`, clean, in sync with origin. `.env` has `COMPOSE_PROJECT_NAME=myapp`.
- **Stack:** the venv is recreated and the stack is running from `lane_1` (API 8000, Vite 5180, DB `myapp-dev-postgres`).
- **Not done:** `laines ai sync lane_1` (issue 2). The two README diffs remain the only `doctor` note.
