# L.AI.nes

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Isolated parallel work lanes for coding agents.** One shared knowledge base, many independent
clones of your project, each with its own local environment.

> **Status: pre-release.** Containers, lanes, hooks and the MCP server work today. See [Roadmap](#roadmap). The package is not on npm yet; install from source.

## Why

Running several agent sessions on one project at once breaks down on **local environment
state**. Worktrees and shared checkouts share databases, caches, ports and container names:

- one task's migration breaks another task's schema,
- caches bleed between tasks,
- dev servers fight over ports,
- and PRs pick up changes that belong to other tasks.

L.AI.nes gives each unit of parallel work a **lane**: a full, independent `git clone` with its own
ports, its own names for databases and caches, and its own env file. Lanes live inside a
**container** whose `.ai/` directory is shared by every lane, so knowledge, guidelines, lessons,
data and audits build up in one place and outlive any single lane.

```
myapp-lanes/                  ← the container (not a git repo)
├── .ai/                      ← shared knowledge layer every lane reads and writes to
│   └── context/LANES_BOARD.md   ← status board lanes report to
├── .laines/                  ← settings, lane index, hooks, audit log
├── CLAUDE.md                 ← lane rules for agents
├── lane_1/                   ← git clone · ports 20000–20009 · its own DB/cache names
└── lane_2/                   ← git clone · ports 20010–20019 · …
```

A session in the container creates, watches and closes lanes. The work itself happens either in
a new agent session you start inside a lane, or in a subagent the container session hands a lane
to.

## Install

Requires Node.js 20 or later, and git.

```bash
git clone https://github.com/AJMarquez99/laines.git
cd laines && npm install && npm install -g .
laines --version
```

## Quick start

Create a container for a project:

```bash
laines init ~/work/myapp-lanes --remote git@github.com:your-org/myapp.git --format table
```

```
container myapp created
id:      myapp
path:    /Users/you/work/myapp-lanes
ports:   20000–20199
repo:    git@github.com:your-org/myapp.git (main)
agents:  claude
```

Already have a checkout? Adopt it instead — the folder becomes the container and its contents
become `lane_1`:

```bash
laines adopt ~/work/myapp --dry-run   # see what will happen
laines adopt ~/work/myapp
```

Check it:

```bash
cd ~/work/myapp-lanes
laines doctor --format table
```

Create a lane, report its progress, and tear it down when it is merged:

```bash
laines create
laines report lane_1 --status in-progress --task "add the export endpoint"
laines teardown lane_1 --remove-dir
```

Preview without writing anything:

```bash
laines init ~/work/other-lanes --remote git@github.com:your-org/other.git --dry-run
```

## What `init` sets up

- **A full `.ai/` layer**, scaffolded by the bundled [dot-ai](https://github.com/AJMarquez99/dot-ai)
  and wired into your agent's instruction file. You don't need dot-ai installed separately.
- **Lane rules for agents**, added to `CLAUDE.md` (and `AGENTS.md` / `GEMINI.md` with `--agents`)
  in their own `laines-lanes` block, which survives `dot-ai sync`.
- **The status board** at `.ai/context/LANES_BOARD.md`, a lane-management runbook (`_lane-management.md`, `_`-named so it is never synced), and lane
  templates.
- **`.laines/`**: `container.json` (marker), `config.json` (settings), `lanes.json` (lane index),
  `hooks/` (your setup scripts) and `audit.jsonl`.
- **Claude permission deny rules** in `.claude/settings.json`, so agents can't run human-only
  commands (teardown, release, hook approval, hook policy, config changes) from a shell.
- **A machine-unique container ID and a port block**, recorded in the machine index
  (`~/.config/laines/containers.json`) so several containers on one machine never collide.

`init` only creates fresh containers. It refuses a directory that already has `.ai/` or
`.laines/`, one inside another container or inside a git repository, the filesystem root, and
your home directory itself.

## Commands

All commands print JSON by default, except `watch`, which streams new board lines. Add `--format table` (after the command name) for
human-readable output.

| Command | What it does |
|---|---|
| `laines init <dir> --remote <url>` | Create a container. Options: `--id <id>`, `--agents claude,codex,gemini`, `--branch <name>` (default `main`), `--dry-run`. |
| `laines adopt <dir> [--id] [--agents] [--dry-run]` | Turn an existing git checkout into a container (human-only). The folder becomes the container and its contents become `lane_1` unchanged (uncommitted work, stashes and ignored files included); the project's `.ai/` becomes the shared layer. Needs a reachable `origin`. Recreate Python virtualenvs afterwards. `lane_1` keeps the project's Docker Compose project name, so existing volumes and containers stay attached; other lanes get their own (`<id>-l<n>`). Containers made before M4.5 get its deny rule from `laines refresh <lane>`. |
| `laines config get [key]` | Print the container's settings, or one dotted key such as `hooks.policy`. |
| `laines config set <key> <value> [--dry-run]` | Change one setting (human-only). The value is JSON when it parses (`true`, `20`, `["claude"]`), else a string. Only that key changes in the file; the whole config is validated first. |
| `laines doctor [--prune]` | Check the container marker, config, machine index, `.ai/` layer, agent files, deny rules, board, locks, the `.ai/` sync base (`ai-sync`), every open lane (noting when a committed `.ai/` differs from the container's: reported as an informational `note` on the check, shown as a `•` line in the table, never a failure), and how each agent reaches the lanes. It flags a pre-M4.6 container whose laines files still need moving to `_` names (`laines refresh` does it). `--prune` removes machine-index entries for containers that no longer exist. |
| `laines create [name] [--branch <b>] [--dry-run]` | Create a lane: clone the repository, allocate ports, write the lane's env file, identity and deny rules, run the `post-create` hook, and print its brief. If the hook fails the lane is kept, marked `setup-failed`, and `refresh` retries it. |
| `laines refresh [lane] [--dry-run]` | Rewrite a lane's local files and `.laines.env` from scratch, then run `post-create` again. Recovers a `setup-failed` lane. Also finishes laines' own container migrations: moves a pre-M4.6 container's laines files to their `_` names, rewrites laines' old `runbooks/lane-management.md` / `templates/lane-*.md` paths inside those files, and re-renders the lanes block in the container's `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` (text outside the block is untouched). `--dry-run` lists every write: migrations, `.laines.env` key changes, exclude-block entries, agent-file blocks, and the lane files it would write or skip. |
| `laines list [--all]` | List open lanes (`--all` includes closed ones). |
| `laines status [lane]` | Show one lane's state, task, branch and ports. With no lane named and outside a lane, shows the container overview. |
| `laines report [lane] [--status <s>] [--task <t>] [--blocked <why>] [--note <n>]` | Update a lane's status on the board; at least one option is required. `-` clears `--task` or `--blocked`. |
| `laines brief [lane]` | Print a lane's brief (identity, ports, rules). |
| `laines keep [lane] --reason <why>` | Mark a lane to be kept, so it is not torn down as finished. |
| `laines release <lane>` | Release a kept lane. Human-only: the lane name is required and agents are denied it. |
| `laines teardown <lane> [--remove-dir] [--force] [--dry-run]` | Close a lane (human-only): archive its plans, delete its context and mark it closed. Without `--remove-dir` the clone stays in place. With `--remove-dir`, teardown refuses when the lane has uncommitted changes, stash entries, commits that exist on no remote (any ref: branches, tags, backup refs, detached HEAD), or is not a git repository. `--force` overrides those but never `keep`. A branch with no upstream whose commits are on a remote is only a warning. Runs `pre-teardown` first (a failure aborts with nothing touched) and `post-teardown` last (a failure leaves a board request; running `teardown` again retries it). |
| `laines hooks status` | List each hook in `.laines/hooks/` as approved, changed or new, with a diff against the approved copy. |
| `laines hooks approve [--lock] [--dry-run]` | Approve the current hooks (human-only). `--lock` also sets policy `approve`, so later changes are refused until a human approves them. It shows the diff of each hook it approves (with `--dry-run`, before approving). |
| `laines hooks policy <approve\|notify\|open> [--dry-run]` | Set the hook policy (human-only). |
| `laines ai sync [lane] [--dry-run]` | For a repository that commits `.ai/`: sync the container's shared `.ai/` with the lane's committed copy, both ways, against the last agreed state. A file changed on both sides is a conflict (exit 3) and is left alone. Run it before opening a PR. The result lists a `why` (`added`, `changed` or `deleted`) for every path it copies. |
| `laines watch [file] [--interval <s>]` | Follow the board (or any file) and print new lines as they land. |

Run commands from the container directory, or pass `--container <dir>`. A bare `--` argument is rejected (exit 2), so options can't be used to slip past the agent deny rules for human-only commands.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including `--dry-run`) |
| `1` | Unexpected or external failure |
| `2` | Fixable input or config problem (bad option, not a container, malformed file) |
| `3` | Blocked by a safety boundary, or a human needs to act |
| `4` | Capability denied: a `capabilities.*` switch in `.laines/config.json` is off |

## Isolation model

Every lane gets its own slice of resources, scoped by the container ID so containers never
collide:

| Resource | Example for lane 2 of container `my-app` |
|---|---|
| Ports | a block of 10 from the container's range, e.g. `20010–20019` |
| Database / cache suffix | `_my_app_l2` (always a valid unquoted identifier) |
| Docker Compose project | `my-app-l2` |
| Lane ID | `my-app/lane_2` |

Lane-local files are hidden through each clone's `.git/info/exclude`, never the repository's own
files. If the repository commits files under `.ai/plans/` (or `.ai/context/`), laines hides only
the README it writes there, so plans you write in a lane show in `git status` and travel with the
branch. Otherwise the lane's plans stay local and are archived at teardown.

Anything specific to your stack, such as creating a per-lane database or copying secrets into a
fresh clone, goes in hooks (`post-create`, `pre-teardown`, `post-teardown`) in `.laines/hooks/`.
New containers start with hook policy `notify`, so agents can build and change the hooks while
you set the project up. Once the hooks are stable, you lock them with a checksum approval.

### Example: a database per lane

`.laines/hooks/post-create`:

```sh
#!/bin/sh
set -e
# post-create runs again on `laines refresh`, so it must be safe to repeat.
createdb "app$LANE_SUFFIX" 2>/dev/null || true
echo "DATABASE_URL=postgres://localhost/app$LANE_SUFFIX" >> "$LANE_ENV_FILE"
```

`.laines/hooks/post-teardown`:

```sh
#!/bin/sh
dropdb --if-exists "app$LANE_SUFFIX"
```

Anything a hook leaves running must redirect its output, for example
`npm run dev >"$LANE_DIR/dev.log" 2>&1 &`: the hook's output pipes close when it exits.

Make both executable (`chmod +x`). A container's `.laines/hooks/README.md` documents the full
contract.

## Agents

L.AI.nes works with any agent: the board and plain files are how lanes coordinate. Claude Code is
the preferred agent and gets the deepest integration:

- The container's `CLAUDE.md` reaches every lane, because Claude Code loads instruction files
  from parent directories. A plain clone of the same repo outside the container never sees it.
- Each lane gets a git-ignored `CLAUDE.local.md` with its identity, and its own deny rules.

Codex and Gemini stop reading instruction files at the git root, so they get the rules from the
lane's `.ai/README.md`. `laines doctor` will tell you the one-line user setting that makes them
read the container's instructions too.

## MCP server

`laines-mcp` serves the agent-safe commands as MCP tools: `laines_create`, `laines_refresh`,
`laines_brief`, `laines_list`, `laines_status`, `laines_report`, `laines_keep`, `laines_teardown`,
`laines_hooks_status`, `laines_config_get`, `laines_ai_sync` and `laines_doctor`. Human-only commands (`init`,
`adopt`, `release`, `hooks approve`, `hooks policy`, `config set`) are not exposed, no tool takes a `force`
or `prune` argument, and the server only ever acts on the container it was started for.

`laines init` registers it for Claude in the container's `.mcp.json`, and every lane gets its own
(git-ignored) copy, so sessions started in the container or in a lane both see the tools. Claude
asks you to approve a project MCP server the first time it starts. To register it by hand:

```bash
claude mcp add --scope project laines -- laines-mcp --container ~/work/myapp-lanes
```

`laines-mcp` takes `--container <dir>` as two arguments. It must be on your `PATH` for Claude to
start it: installing the package globally provides both `laines` and `laines-mcp`.

**Teardown over MCP** follows `teardown.mcp` in `.laines/config.json`:

| Value | Behaviour |
|---|---|
| `confirm` (default) | You are asked to confirm in your client, with the lane's branch, unpushed work and what will be archived and deleted. Declining, cancelling or not answering does nothing. A client that cannot ask leaves a request on the board; you finish it with `laines teardown <lane>` in a terminal. |
| `auto` | No prompt; every other check still applies. |
| `off` | The tool is not offered. |

Every call checks the current setting; whether the tool is listed at all follows the setting the
server started with, so restart the server (or the agent session) after switching to or from
`off`. A kept lane is refused on every path, and unpushed work is never forced over MCP.

`laines doctor` checks the registration. Containers made before the MCP server existed don't have
one: run the `claude mcp add` command above in the container, and `laines refresh <lane>` for each
lane.

### Capabilities and locked mode

`capabilities` in `.laines/config.json` switches off `create` (also `refresh`), `report`, `keep`,
`teardown` or `aiSync` for the CLI and MCP alike (exit `4`). `"locked": true` refuses `config set`,
`hooks approve`, `hooks policy`, `release` and `teardown --force`, even from your own terminal
(exit `3`); unlocking requires editing the file by hand.

## Roadmap

| Milestone | Delivers | Status |
|---|---|---|
| **M1: Foundation** | `init`, `config get`, `doctor`, machine index, board, agent wiring | ✅ Done |
| **M2: Lanes** | `create`, `list`, `status`, `report`, `brief`, `keep` / `release`, `teardown` with unpushed-work safety checks, `watch` | ✅ Done |
| **M3: Hooks** | hook runner, checksum approval (`hooks status / approve / policy`), `refresh` | ✅ Done |
| **M4: MCP server** | `laines-mcp`, capabilities, locked mode, human confirmation for teardown over MCP | ✅ Done |
| **M4.5: Adopt** | `laines adopt`, `.ai/` seeding, `laines ai sync` | ✅ Done |
| **M4.6: Adopt fixes** | Fixes from the first real adoption: Compose identity for adopted `lane_1`, `_` laines files, exclude block that lists only untracked files, doctor notes, `ai sync` reasons | ✅ Done |
| **M5: Release** | CI on macOS and Linux, security documentation, npm package | Planned |

Out of scope for v1: Windows and several repositories in one lane.

## Development

```bash
npm install
npm run test:run   # run the test suite once
npm run lint
```

Design documents live in [`.ai/plans/`](.ai/plans/): the
[v1 specification](.ai/plans/2026-09-29-laines-spec.md) and the
[roadmap](.ai/plans/2026-09-29-laines-roadmap.md).

## License

[MIT](LICENSE)
