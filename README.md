# L.AI.nes

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Isolated parallel work lanes for coding agents.** One shared knowledge base, many independent
clones of your project, each with its own local environment.

> **Status: pre-release.** Containers and lanes work today. Hooks and the MCP server are being
> built. See [Roadmap](#roadmap). The package is not on npm yet; install from source.

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
- **The status board** at `.ai/context/LANES_BOARD.md`, a lane-management runbook, and lane
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

All commands print JSON by default. Add `--format table` (after the command name) for
human-readable output.

| Command | What it does |
|---|---|
| `laines init <dir> --remote <url>` | Create a container. Options: `--id <id>`, `--agents claude,codex,gemini`, `--branch <name>` (default `main`), `--dry-run`. |
| `laines config get [key]` | Print the container's settings, or one dotted key such as `hooks.policy`. |
| `laines doctor [--prune]` | Check the container marker, config, machine index, `.ai/` layer, agent files, deny rules, board, locks, every open lane, and how each agent reaches the lanes. `--prune` removes machine-index entries for containers that no longer exist. |
| `laines create [name] [--branch <b>] [--dry-run]` | Create a lane: clone the repository, allocate ports, write the lane's env file, identity and deny rules, and print its brief. |
| `laines list [--all]` | List open lanes (`--all` includes closed ones). |
| `laines status [lane]` | Show one lane's state, task, branch and ports. |
| `laines report [lane] --status <s> --task <t> --blocked <why> --note <n>` | Update a lane's status on the board. |
| `laines brief [lane]` | Print a lane's brief (identity, ports, rules). |
| `laines keep [lane] --reason <why>` | Mark a lane to be kept, so it is not torn down as finished. |
| `laines release <lane>` | Release a kept lane. Human-only: the lane name is required and agents are denied it. |
| `laines teardown <lane> [--remove-dir] [--force] [--dry-run]` | Close a lane. Human-only. Refuses while the lane has unpushed commits, uncommitted changes or a branch that exists nowhere else, unless `--force` (which never overrides `keep`); `--remove-dir` deletes the clone. |
| `laines watch [file] [--interval <s>]` | Follow the board (or any file) and print new lines as they land. |

Run commands from the container directory, or pass `--container <dir>`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including `--dry-run`) |
| `1` | Unexpected or external failure |
| `2` | Fixable input or config problem (bad option, not a container, malformed file) |
| `3` | Blocked by a safety boundary, or a human needs to act |
| `4` | Capability denied (planned, with the MCP server) |

## Isolation model

Every lane gets its own slice of resources, scoped by the container ID so containers never
collide:

| Resource | Example for lane 2 of container `my-app` |
|---|---|
| Ports | a block of 10 from the container's range, e.g. `20010–20019` |
| Database / cache suffix | `_my_app_l2` (always a valid unquoted identifier) |
| Docker Compose project | `my-app-l2` |
| Lane ID | `my-app/lane_2` |

Anything specific to your stack, such as creating a per-lane database or copying secrets into a
fresh clone, goes in hooks (`post-create`, `pre-teardown`, `post-teardown`) in `.laines/hooks/`.
New containers start with hook policy `notify`, so agents can build and change the hooks while
you set the project up. Once the hooks are stable, you lock them with a checksum approval.

## Agents

L.AI.nes works with any agent: the board and plain files are how lanes coordinate. Claude Code is
the preferred agent and gets the deepest integration:

- The container's `CLAUDE.md` reaches every lane, because Claude Code loads instruction files
  from parent directories. A plain clone of the same repo outside the container never sees it.
- Each lane gets a git-ignored `CLAUDE.local.md` with its identity, and its own deny rules.

Codex and Gemini stop reading instruction files at the git root, so they get the rules from the
lane's `.ai/README.md`. `laines doctor` will tell you the one-line user setting that makes them
read the container's instructions too.

## Roadmap

| Milestone | Delivers | Status |
|---|---|---|
| **M1: Foundation** | `init`, `config get`, `doctor`, machine index, board, agent wiring | ✅ Done |
| **M2: Lanes** | `create`, `list`, `status`, `report`, `brief`, `keep` / `release`, `teardown` with unpushed-work safety checks, `watch` | Next |
| **M3: Hooks** | hook runner, checksum approval (`hooks status / approve / policy`), `refresh` | Planned |
| **M4: MCP server** | `laines-mcp`, capabilities, locked mode, human confirmation for teardown over MCP | Planned |
| **M5: Release** | CI on macOS and Linux, security documentation, npm package | Planned |

Out of scope for v1: Windows, several repositories in one lane, and adopting an existing `.ai/`
directory.

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
