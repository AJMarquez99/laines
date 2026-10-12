# L.AI.nes — specification (v1)

**Status:** spec awaiting review. Supersedes the working design log
(`../archive/2026-09-29_2026-09-28-laines-design.md`). Next step after approval: implementation plan.
Durable research behind these choices: `../knowledge/build-constraints.md`.

## 1. Purpose

Running several agent sessions (or people) on one project in parallel breaks down on **local
environment state**. Worktrees and shared checkouts share databases, caches, ports, and
container names, so one task's migration breaks another's schema, caches bleed across tasks,
servers fight over ports, and PRs pick up changes from other tasks.

L.AI.nes gives each unit of parallel work a **lane**: a full, independent clone of the project
with its own isolated local environment. Lanes live under a **container** directory whose
`.ai/` (the dot-ai knowledge convention) is shared by every lane, so knowledge, guidelines,
lessons, data, and audits accumulate in one place and outlive any single lane. A top-level
session in the container creates, monitors, and tears lanes down; lanes report to a shared
status board.

**Audience:** anyone using coding agents on any git project — any stack, any size — including
people running several containers across several projects on one machine.

**Name:** L.AI.nes in prose, docs, and help text. Machine identifiers are dot-free: npm
`@ajmarquez99/laines`, binaries `laines` and `laines-mcp`, repo `laines`, marker directory
`.laines/`.

## 2. Scope

**In v1**
- `laines` CLI and `laines-mcp` MCP server over one command layer.
- Fresh containers created by `laines init` (dot-ai bundled and run by L.AI.nes).
- `laines adopt` for an existing git checkout (design: `2026-10-02-laines-m4.5-adopt-design.md`).
- One repo per container; lane = one clone.
- Built-in isolation primitives (lane number, port block, scoped names, env file) + project
  hooks for stack-specific work.
- Claude Code as the fully supported agent; Codex and Gemini supported through the lane-local
  README and `doctor` guidance.
- macOS and Linux.

**Not in v1** (designed so they can be added without breaking changes)
- Built-in service adapters (Postgres, MySQL, Redis, …) — they will ship as packaged hooks
  (§8).
- Multi-repo lanes — data shapes already allow them (§6.3).
- Windows.
- Migrating containers made with earlier scripts.

## 3. Concepts

| Term | Meaning |
|---|---|
| **Container** | Directory created by `laines init` or `laines adopt`. Holds `.laines/`, the shared `.ai/`, agent config, and lanes. Not a git repo. |
| **Container ID** | Machine-unique slug (default: repo name; `myapp`, `myapp-2`, …). Scopes every machine-global name. |
| **Lane** | `lane_N/` under the container: a standard `git clone` of the container's repo plus lane-local files. |
| **Lane mode** | An agent session whose working tree is a lane (detected by markers, §7.1). |
| **Normal mode** | Any other session, including a plain checkout that happens to sit under a container. |
| **Board** | `.ai/context/LANES_BOARD.md` — human/agent-readable status, requests, and activity. |
| **Hooks** | Project-supplied executables run at lane lifecycle events (§8). |
| **Human-only command** | A command an agent must not run on its own authority (§9.2). |

## 4. On-disk layout

```
~/.config/laines/                 # override: $LAINES_CONFIG_DIR, else $XDG_CONFIG_HOME/laines
├── containers.json               # machine index: { id, path, portRange } per container
└── .lock/                        # mkdir lock for containers.json

<container>/
├── .laines/
│   ├── container.json            # container marker: { id, lainesVersion, created }
│   ├── config.json               # settings (§6.1)
│   ├── lanes.json                # lane index: source of truth for lane state (§6.2)
│   ├── hooks/                    # post-create, pre-teardown, post-teardown, <event>.d/
│   ├── hooks.lock.json           # approved hook checksums
│   ├── hooks.approved/           # copies of the approved hooks (diffs for hooks status)
│   ├── audit.jsonl               # metadata-only action log
│   └── .lock/                    # mkdir lock for lanes.json + board
├── .ai/                          # full dot-ai layer (shared by all lanes)
│   ├── context/LANES_BOARD.md    # the board
│   ├── runbooks/_lane-management.md
│   └── templates/_lane-*.md      # `_`-prefixed (dot-ai private, never synced): lane-local README templates
├── .claude/settings.json         # deny rules for human-only commands (+ dot-ai settings)
├── .mcp.json                     # registers laines-mcp for agent sessions (Claude)
├── CLAUDE.md                     # dot-ai block, then <!-- BEGIN laines-lanes --> block
└── lane_1/ lane_2/ …

<lane>/                           # a git clone; everything below is in .git/info/exclude
├── .ai/.lane.json                # lane marker: { lane, number, containerId, container }
├── .ai/README.md                 # lane rules (any agent)
├── .ai/context/  .ai/plans/      # lane-owned working state
├── .laines.env                   # lane environment (§8.3)
├── CLAUDE.local.md               # lane identity + lane-mode check (Claude)
├── .claude/settings.local.json   # deny rules + plansDirectory (merged if present)
└── .mcp.json                     # same, so a session started in the lane has the tools
```

Only `context/` and `plans/` are lane-owned. `knowledge/`, `guidelines/`, `lessons/`, `data/`,
`audits/`, and the rest stay in the container so a new lane inherits what a torn-down lane
produced.

Lane-local files are hidden through `.git/info/exclude`, never the repo's `.gitignore`, so they
never appear in `git status` or a PR.

The block follows what the repository commits. A file the repository tracks is never excluded. If
the repository tracks anything under `.ai/plans/` (or `.ai/context/`), that directory is project
content: the block lists only the files laines writes there (`/.ai/plans/README.md`,
`/.ai/context/README.md`), so a plan written in a lane shows in `git status` and travels with the
branch. The lane rules and the brief say which case applies; `laines refresh` and `doctor` share one
function (`laneExcludes`), so they agree.

## 5. Commands

Every command returns JSON by default (`--format table` for humans). Every side-effecting
command accepts `--dry-run`: a true no-op (no write, no hook, no audit line) that reports what
would happen, exit 0. MCP tool names are `laines_<command>` with snake_case arguments.

| Command | CLI | MCP | Summary |
|---|---|---|---|
| `init <dir> --remote <url> [--id] [--agents] [--branch]` | ✅ | — | Create a container (§10.1). |
| `adopt <dir> [--id] [--agents]` | ✅ | — | Turn an existing checkout into a container; it becomes `lane_1` (§10.4). |
| `create [name] [--branch]` | ✅ | ✅ | Create a lane (§10.2). |
| `refresh <lane>` | ✅ | ✅ | Rewrite lane-local files and env, re-run `post-create`. |
| `brief <lane>` | ✅ | ✅ | Handoff text for an agent working in the lane (§7.4). |
| `list` / `status [lane]` | ✅ | ✅ | Lanes, ports, branches, kept flags, board state. |
| `report <lane> [--status --task --blocked --note]` | ✅ | ✅ | Update the lane's board entry. |
| `keep <lane> --reason <text>` | ✅ | ✅ | Pin a lane: teardown refused from every path. |
| `release <lane>` | ✅ | — | Unpin a lane. Human-only. |
| `teardown <lane> [--keep-dir]` | ✅ | ✅ (gated, §9.3) | Close a lane (§10.3). |
| `teardown … --force` | ✅ | — | Override unpushed-work checks (never overrides `keep`). |
| `hooks status` | ✅ | ✅ | Approved / changed / new hooks with diffs. |
| `hooks approve [--lock]` | ✅ | — | Approve current hooks; `--lock` also sets policy `approve`. |
| `hooks policy <approve\|notify\|open>` | ✅ | — | Change hook policy. Human-only. |
| `ai sync [lane]` | ✅ | ✅ | Three-way sync of the shared `.ai/` with a lane's committed `.ai/` (§10.5). |
| `config get [key]` | ✅ | ✅ | Read settings. |
| `config set <key> <value>` | ✅ | — | Change settings. Human-only. |
| `watch [file]` | ✅ | — | Follow the board (or any file) and print new lines. |
| `doctor [--prune]` | ✅ | ✅ (no `--prune`) | Diagnose container, lanes, machine index, agent reach. A closed lane whose clone remains gets a `closed:<lane>` check: a note when nothing changed since the close, a failure when a branch or tag tip has a committer date after `closed` or the clone has uncommitted files (work that belongs to no open lane). Committer dates can be rewritten, so this is a heuristic. |

**Exit codes:** `0` ok (incl. dry-run) · `1` unexpected or external failure · `2` user-fixable
input or config · `3` blocked by a safety boundary or needs a human · `4` capability denied.

## 6. Data

All JSON files are read through one parse function; malformed JSON is a typed error (exit 2).
Writes to `lanes.json`, the board, and `containers.json` happen under their mkdir lock
(atomic on macOS and Linux; 5s wait; `doctor` reports a stale lock and the `rmdir` to clear it).

### 6.1 `config.json`

```json
{
  "repos": { "myapp": { "remote": "git@example.com:org/myapp.git", "defaultBranch": "main" } },
  "lanePrefix": "lane_",
  "maxLanes": 20,
  "ports": { "stride": 10 },
  "hooks": { "policy": "notify", "timeoutSec": 300, "stableAfter": 3 },
  "teardown": { "mcp": "confirm", "mcpForce": "confirm" },
  "capabilities": { "create": true, "report": true, "keep": true, "teardown": true, "aiSync": true },
  "agents": ["claude"],
  "agentCmd": "claude",
  "board": { "logLimit": 200 },
  "locked": false
}
```

- `repos` holds exactly one entry in v1.
- `capabilities` gates MCP and CLI alike at one choke point; a denied capability exits 4.
  Read-only commands have no capability switch.
- `locked: true` makes `config set`, `hooks approve`, `hooks policy`, `release`, and
  `teardown --force` exit 3, even from the CLI. Unlocking requires editing the file by hand.
- `config set` changes one key in the file as written and validates the whole config first; defaults stay implicit.

### 6.2 `lanes.json`

```json
{
  "lanes": {
    "lane_2": {
      "number": 2,
      "repos": [{ "name": "myapp", "path": "lane_2", "branch": "feat/billing" }],
      "ports": [20210, 20219],
      "state": "active",
      "status": "in-progress", "task": "Stripe webhooks", "blocked": null,
      "kept": { "reason": "base of stacked PR #123", "since": "2026-09-29T14:00:00Z" },
      "created": "2026-09-29T12:00:00Z", "updated": "2026-09-29T14:02:00Z"
    }
  },
  "requests": [],
  "hookHistory": [],
  "activity": []
}
```

`state` is `active`, `setup-failed`, or `closed`. `requests` feeds the board's Requests
section. `hookHistory` records the hook checksum set at each successful create (drives the
lock suggestion, §8.4). `activity` holds the Activity Log entries (newest first, capped at
`board.logLimit`; overflow is appended to `.ai/archive/<date>_board-log.md`) so the whole board
can be rendered from this file.

### 6.3 Multi-repo readiness

Code must never assume the lane directory *is* the clone: it reads `repos[].path`. v1 always
writes one repo at `path = <lane>`. A later multi-repo release writes `<lane>/<repo>` paths.

### 6.4 Machine index and names

`containers.json` lists every container on the machine. `init` claims a machine-unique ID and a
port block; `doctor --prune` (CLI only) removes entries whose path no longer has a container
marker.

- **Port range:** default 20000–29999 (clear of common dev ports and of OS ephemeral ranges),
  split into per-container blocks of `maxLanes × stride` (default 200). Lane N (1 ≤ N ≤
  `maxLanes`) gets `block.start + (N − 1) × stride` through `+ stride − 1`. `create` verifies the ports are free and
  fails with exit 2 naming the process if not.
- **Scoped names:** `LANE_SUFFIX=_<id>_l<N>` with hyphens in the ID replaced by underscores
  (`my-app` → `_my_app_l2`) so it is a valid unquoted database identifier, Compose project
  `<id>-l<N>`, `LANE_ID=<id>/<lane>`. Unique across every container on the machine.
- Range and block size are machine settings in `containers.json`; stride and `maxLanes` are
  per container.

## 7. Agent integration

### 7.1 Lane detection

A session is in **lane mode** only if `.ai/.lane.json` exists at the repo root **and** the
container path it names has `.laines/container.json` with the same ID. Otherwise it is in
normal mode: plain dot-ai resolution, no container lookup, no board reporting. There is no
upward search for containers.

### 7.2 Resolution in lane mode

| Layer | Read | Write |
|---|---|---|
| Lane `.ai/context/`, `.ai/plans/` | yes | lane working state only |
| Repo's committed `.ai/` in the lane (if any) | read the container's live `.ai/` instead | only through `laines ai sync <lane>` (§10.5), never by hand |
| Container `.ai/` | yes | all new durable knowledge, guidelines, lessons, data, audits |
| `~/.ai/` | index only | no |

The container's `.ai/` is the live knowledge base even when the repository commits `.ai/`; a lane's committed `.ai/` changes only through `laines ai sync` (§10.5).

Agents in a lane must not run `dot-ai init` or `dot-ai sync` (they would scaffold a full
`.ai/` into the lane); `doctor` detects it.

### 7.3 Instruction placement

- **Claude Code** (verified 2.1.284): the container `CLAUDE.md` holds a
  `<!-- BEGIN laines-lanes -->` block after dot-ai's END marker (survives `dot-ai sync`),
  guarded by "applies only when `.ai/.lane.json` exists". Each lane gets `CLAUDE.local.md` with
  its identity and the detection check. Both load automatically in a lane; neither reaches a
  plain checkout.
- **Codex / Gemini**: both stop instruction discovery at the git root, so the container file
  does not reach a lane. Lanes get an excluded `AGENTS.md` / `GEMINI.md` only when the repo
  does not commit one (never an `AGENTS.override.md`, which would hide the repo's own). `doctor`
  reports whether container instructions reach each configured agent and prints the per-user
  setting that fixes it (`project_root_markers`, `context.includeDirectories`). L.AI.nes never
  edits user-level agent config.
- The lane `.ai/README.md` carries the same rules for any agent.
- **MCP:** `init` writes the container's `.mcp.json`, and `create`/`refresh` write an excluded one in each lane, registering `laines-mcp --container <container>` as server `laines`, when Claude is a configured agent. A repo-tracked `.mcp.json` is never overwritten.

### 7.4 Workflows and `brief`

Lanes are created from the container session. Then either:
1. the user opens a new agent session inside the lane (instructions load automatically), or
2. the container session dispatches a subagent to work in the lane.

A subagent inherits the parent's working directory and instructions, not the lane's. `brief
<lane>` (printed at the end of `create`) returns the handoff: lane ID, absolute path, branch,
ports, env file to source, instruction files to read in order (repo `CLAUDE.md`/`AGENTS.md`,
lane `.ai/README.md`, lane `context/` and `plans/`), rules (stay inside the lane path, use
`git -C <lane>`, report as `<lane>`, no dot-ai init/sync), and the lane's board entry.

## 8. Isolation and hooks

### 8.1 Built in

For every lane L.AI.nes provides the lane number, port block, scoped names (§6.4), and the env
file. Everything stack-specific (creating or dropping databases, copying secrets into a fresh
clone, patching tracked config with `skip-worktree`) is a hook.

### 8.2 Events

| Hook | When | cwd | On failure |
|---|---|---|---|
| `post-create` | after clone, lane files, excludes, env file; again on `refresh` | lane | lane kept, `state: setup-failed`, board request; fix and `refresh` |
| `pre-teardown` | after safety checks, before any archive or delete | lane | teardown aborted, nothing touched |
| `post-teardown` | after archive, delete, closed mark | container | warning + board request; `teardown <lane>` retries it |

Hooks are executables named after the event in `.laines/hooks/`, plus `<event>.d/*` run in
lexical order after the main hook. Future adapters install into `<event>.d/`; the contract does
not change.

### 8.3 Contract

Environment: `LANE_NAME`, `LANE_NUMBER`, `LANE_ID`, `LANE_DIR`, `CONTAINER_DIR`,
`CONTAINER_ID`, `LANE_PORT_BASE`, `LANE_PORT_COUNT`, `LANE_SUFFIX`, `LANE_BRANCH`,
`LANE_ENV_FILE`, `PORT`, `COMPOSE_PROJECT_NAME`, `LAINES_HOOK`, `LAINES_DRY_RUN`. `PORT` (first port of the
block) is set only for lanes laines cloned; a lane recorded as `adopted: true` (made by `laines adopt`) has
none, so the project's own `PORT` stays in effect. `refresh` backfills `adopted` for a pre-M4.7 lane that has a
`compose` name.

`.laines.env` is written before `post-create` and contains `LANE_*`, `PORT` (first port of the
block; not for an adopted lane), and `COMPOSE_PROJECT_NAME` (`<id>-l<n>`, or the lane's recorded `compose` name: `adopt` keeps the project's own for `lane_1`). Hooks may append to it. `refresh` rewrites it from scratch before re-running `post-create`, so appended lines come back exactly once; hand edits are lost.

Exit `0` ok · `3` blocked, needs a human (becomes a board request, not a failure) · anything
else fails. Default timeout 300s. Output is captured and returned to agents marked untrusted.
Under `--dry-run` no hook runs; the result lists which would run and their approval state.

### 8.4 Hook policy

Checksums of approved hooks live in `hooks.lock.json`.

| Policy | Changed or new hook |
|---|---|
| `approve` | refused, exit 3, with its diff, until a human runs `laines hooks approve` |
| `notify` | runs; warning, audit entry, board note with the new checksum |
| `open` | runs, no check |

- **New containers default to `notify`**: L.AI.nes knows nothing about the project's
  environment at install time, so agents build the hooks.
- Agents may always edit hooks; policy only decides whether an edited hook runs unapproved.
- When the hook set has been unchanged across the last `stableAfter` (default 3) successful
  creates, `create`, `doctor`, and the board suggest `laines hooks approve --lock`. L.AI.nes
  never changes the policy by itself.

## 9. Safety

### 9.1 Principles

- The boundary (container location, remote, config, hook approval and policy, lane release) is
  owned by a human and cannot be moved by an agent.
- No bypass argument is reachable over MCP. Tool input schemas never declare one, and argument
  mapping drops any injected one.
- Before deleting anything, the lane path must resolve — lexically and through `realpath` —
  inside the container and match the lane prefix. A container path that resolves to `/` or the
  home directory is refused.
- `audit.jsonl` records metadata for create, refresh, teardown, keep, release, hook approval,
  and policy changes. An audit write failure warns and never fails the action.

### 9.2 Human-only commands beyond MCP

MCP gating does not stop an agent that has a shell. `init` writes Claude permission deny rules
for `laines teardown`, `laines release`, `laines adopt`, `laines hooks approve`, `laines hooks policy`, and
`laines config set` into the container's `.claude/settings.json` (covers the container session
and its subagents); `create` and `refresh` merge the same rules into each lane's
`.claude/settings.local.json` (verified: container settings do not apply in a lane). Agents go
through MCP, where §9.3 applies; humans run these commands in their own terminal.

### 9.3 Teardown over MCP

`teardown.mcp`:
- `confirm` (default): the server asks the human through MCP elicitation, showing lane,
  branch, open PRs if known, unpushed work, and what will be archived and deleted. Decline or
  no answer does nothing. A client without elicitation gets exit 3 plus a board request; the
  human completes it with CLI `laines teardown`. Message on decline: "Declined or no response —
  if you weren't prompted, run `laines teardown <lane>` in your terminal."
- `auto`: no prompt; every other check still applies.
- `off`: the tool is not registered.

Reason: a lane that looks finished may be the base of stacked PRs or related work.

**Forced teardown (0.4.8).** `teardown.mcpForce` (`confirm` default | `off`). Under `teardown.mcp`
`confirm`, when the clone's deletion (the default) finds unpushed work (commits on no remote, uncommitted changes,
stashes), the server asks a second elicitation form listing exactly what would be lost (each ref with
its count and up to 3 commit subjects, dirty files, stashes, and which sibling lanes also hold the
commits). The human must type the lane name (trimmed, exact). Only `accept` with a matching name
proceeds; decline, cancel, a wrong name, an empty answer or a timeout refuse with "Not confirmed:
nothing was torn down." The run is `teardown` with `force` and an `expect` fingerprint (stable JSON of
unpushed ref tips, sorted dirty entries and stash hashes). `runTeardown` recomputes it after the
safety checks and again under the board lock after `pre-teardown`, and refuses with nothing touched
if it differs. No MCP tool declares `force` or `expect`; the CLI never passes `expect`. Not offered
(0.2.0 refusal naming the terminal command) when `mcpForce` is `off`, the container is locked, the
client cannot elicit, the lane is kept, or the clone is not a git repository. The audit
entry records `forcedVia: "mcp-typed-confirmation"` and `discarded`. Limits: the fingerprint sees
file names, not file contents, of uncommitted changes, and files git ignores (local env files,
databases) are neither shown nor fingerprinted, same as the terminal `--force`.

**Keep the clone instead (0.4.9).** Deleting the clone is the default (§10.3). When `keep_dir` was not
passed and the lane is open, the first form carries an optional boolean `keep_dir` ("Keep the clone
instead"), a human's tick and never an agent argument. Ticked, the server re-plans with `keepDir` (dry
run) before doing anything: the lane closes and the clone stays, with no unpushed-work checks (the
0.4.8 default). Unticked: clean deletes the clone in that one confirmation; blocked by unpushed work
continues into the typed form when forcing is allowed, otherwise refuses before prompting (the
refusal points at `keep_dir`), so a lane is never closed with its clone silently kept. `keep_dir`
only makes things safer, so an agent may pass it; `remove_dir` is accepted and ignored (deprecated).

**Closed lanes (0.4.9, lifting the 0.4.8 exclusion).** A closed lane's leftover clone is unowned: no
board entry tracks it, so work done there after the close is the easiest to lose. The typed form is
therefore offered for it too (clone exists, is a git repo), with every ref whose tip is newer than
`closed` labelled "changed after the lane closed" in both forms. The closed path runs no
`pre-teardown`, so `runTeardown` re-checks the `expect` fingerprint immediately before archiving or
deleting anything and refuses with nothing touched on a mismatch. The audit entry adds
`closedLane: true`.

**Stale server.** The server records the version it loaded (`VERSION` at import) and re-reads its own
`package.json` on every tool call. When the installed version differs, `laines_status` and `laines_doctor`
results carry `server: { running, installed, stale: true }`, doctor adds a failing `mcp-server` check, and
every refusal or error gets one appended line: "this laines-mcp is running <running>, but <installed> is
installed: reconnect laines in your MCP client (for example /mcp in Claude Code)". The CLI `laines doctor`
has no `mcp-server` check.

### 9.4 `keep`

A kept lane refuses teardown from every path, including `auto` and CLI `--force`, until a human
runs `laines release`. Agents may `keep` (the safe direction) but never `release`.

### 9.5 Documented residual risks (`SECURITY.md`)

User-level agent config, Claude `Elicitation`/`ElicitationResult` hooks (which can alter a
confirmation; `doctor` warns when one is visible to a lane), direct edits to `.laines/` files by
anything with filesystem access, and hooks themselves (they are the user's code).

## 10. Flows

### 10.1 `init`

1. Refuse if the target has `.laines/` or `.ai/` (exit 2). Create it if missing.
2. Claim a container ID and port block in `containers.json`.
3. Run the bundled dot-ai CLI with `cwd` = container: `init` with the agent flags from
   `--agents` (default Claude). Non-zero exit aborts with dot-ai's stderr.
3b. If the remote's default branch commits `.ai/`, seed the container's `.ai/` from it (no sync base yet: bases are per lane, §10.5).
4. Write `.laines/` (marker, config, empty lane index, empty hooks dir, empty lock file), the
   board, the lane-management runbook, lane templates, the `laines-lanes` block in each wired
   agent file, and Claude deny rules.
5. Print next steps: write hooks (or let an agent do it under `notify`), then `laines create`.

### 10.2 `create`

1. Check capability, `maxLanes`, name (if omitted, the lowest `lane_N` that is neither an open lane nor an existing path, so a closed
   lane's leftover clone is skipped; `maxLanes` counts open lanes only and an exhausted range names the
   leftovers; an explicit name at an existing path is refused, naming `teardown` when it
   is a closed lane's clone), path containment.
2. Allocate ports; verify they are free.
3. `git clone` the remote into the lane path; check out `--branch` (tracking the remote branch
   if it exists, otherwise a new local branch), default `defaultBranch`. If the repository commits
   `.ai/`, record the lane's `ai sync` base from the fresh clone (§10.5).
4. Write lane files (§4), `.git/info/exclude` entries, `.laines.env`, deny rules.
5. Record the lane (`state: active`) and board entry; run `post-create` under the hook policy.
6. On hook failure: `state: setup-failed`, board request, exit 1 with hook output (exit 3 if
   the hook exited 3 or was refused under `approve`). Otherwise record the hook checksum set
   and print `brief`.

A failed clone removes the partial directory and releases the ports.

### 10.3 `teardown`

1. Refuse if the lane is kept (exit 3, from every path).
2. Unless `--keep-dir`: check for uncommitted changes (excluding lane-local files), stash
   entries, and any commit reachable from a local ref that exists on no remote
   (`git rev-list --all --not --remotes`, reporting which refs). Refuse unless CLI `--force`
   (exit 3). The check is commit-level and ref-agnostic on purpose: an upstream comparison
   misses branches with no upstream, and a branch-only walk misses backup refs and tags.
   The refusal and the dry run's `checks.holdings` also say, per unpushed ref, which other open
   lanes hold its tip as a local branch or tag (`also in lane_1 (refs/heads/x)`, or `held by no
   other lane`). This is informational only and never exempts a commit.
3. Over MCP: apply `teardown.mcp` (§9.3).
4. Run `pre-teardown`; failure aborts with nothing touched.
5. Move the lane's `.ai/plans/` to the container's `.ai/archive/<date>_<lane>/`; delete
   `.ai/context/`. Mark the lane `closed` and drop its `ai sync` base.
6. Unless `--keep-dir`: re-verify containment and delete the lane directory.
7. Run `post-teardown`; audit; release the lane's ports.

Deleting the clone is the default (0.4.9): tearing a lane down closes it and removes its directory after
the checks in step 2. `--keep-dir` (MCP `keep_dir`) is the opt-out: steps 2 and 6 are skipped, the clone
is left in place and nothing irreversible happens to it. `--remove-dir` (MCP `remove_dir`) is a deprecated
no-op alias; `--keep-dir` together with `--remove-dir` is an input error (exit 2). Tearing down a lane
that is already closed deletes its leftover clone (same checks); `--keep-dir` there is an input error,
as is tearing down a closed lane whose clone is already gone. The dry run reports `removedDir: true`
when the clone will be deleted.

### 10.4 `adopt`

Human-only, CLI only. Detail in `2026-10-02-laines-m4.5-adopt-design.md`.

1. Check the directory (git checkout with a reachable `origin`, not already a container, not inside a lane) and plan; `--dry-run` stops here.
2. Claim the container id and port block in the machine index, then move the checkout into `<dir>/lane_1` with a two-rename move so the folder becomes the container.
3. Copy the project's `.ai/` into the container as the shared layer, write container files, and record `lane_1`'s `ai sync` base from its tracked `.ai/` files.
4. Register the lane in `lanes.json` with a `compose` name (the project's current Compose project: `COMPOSE_PROJECT_NAME` in `.env`, else a top-level `name:` in its compose file, else the folder name lowercased minus characters outside `[a-z0-9_-]`; unset if empty), which `.laines.env` uses instead of `<id>-l<n>`: this is the commit point. Before it, everything rolls back exactly (including releasing the machine-index claim).
5. After it, write lane files, rename untracked collisions to `<name>.pre-laines`, and remove untracked `.ai/` files already copied. A later failure keeps the container and says to run `laines refresh <lane>`.

### 10.5 `ai sync`

Detail in the M4.5 design. Capability `aiSync` (exit 4 when off).

1. Resolve the lane (`assertLaneDir`); walk the synced set of both `.ai/` trees without following symlinks.
2. Plan per file against **this lane's** recorded base (`.laines/ai-sync.json`, `{ version: 2, lanes: { <lane>: { <rel>: sha } } }`): a change on one side only moves across; equal sides are a no-op. The base is per lane because a shared one cannot tell a lane that is behind from one that deleted or reverted a file. `create` records it from the fresh clone, `adopt` from `lane_1`'s tracked files, `teardown` drops it; a lane without one merges (one-sided files move, two-sided differences conflict).
3. A file changed on both sides is a conflict: left untouched on both sides, base not updated, exit 3.
4. Symlinks are listed under `refused` and never followed or deleted.
5. Write only inside the container's and the lane's `.ai/`, then this lane's new base; a second run moves nothing.

## 11. Board

Rendered from `lanes.json` on every write; state is never parsed back from the markdown.

- **Header:** container ID, port block, hook policy, teardown mode.
- **Status:** one block per active lane between `<!-- lane:<name>:start -->` and `…:end -->`:
  status, branch, task, blocked on, ports and env file, 📌 kept and reason, last update.
- **Requests:** everything waiting on a human (teardown confirmations, hook approval or lock
  suggestions, `setup-failed` lanes, hooks that exited 3), each with the command to resolve it.
- **Closed:** collapsed list of closed lanes.
- **Activity Log:** newest first, appended by `laines`, capped at `board.logLimit` lines;
  overflow moves to `.ai/archive/<date>_board-log.md`.

The board's `context/README.md` note ("this file is long-lived") sits below dot-ai's folder
block so `dot-ai sync` keeps it.

## 12. Implementation constraints

- ESM, Node ≥ 20. Dependencies: `@ajmarquez99/dot-ai` (^1.1, invoked through its CLI only),
  `commander`, `zod`, `@modelcontextprotocol/sdk`.
- `bin/laines.js` and `bin/laines-mcp.js` → `src/cli.js` (single `handle()` wrapper) and
  `src/mcp/server.js`; commands in `src/commands/*` are `runXxx(opts, deps)` returning data;
  every side effect (fs, git, child processes, hooks, clock, prompts, elicitation) comes from
  `src/deps.js`.
- `src/mcp/tools.js` is a table of `{ name, description, inputSchema, command, mapArgs }`.
  Errors become `isError` results; the server never crashes.
- Templates ship undotted and are renamed on copy (npm rewrites a shipped `.gitignore`).
  `files` allowlist includes every template; `.gitattributes` pins LF on executables.
- Public repository and package: no personal paths, accounts, or private references in
  committed files; history scrubbed before the first public push; `SECURITY.md` with the threat
  model; `CONTRIBUTING.md`; MIT licence. Releases are tag-driven from CI with trusted
  publishing; `prepublishOnly` runs the test suite.

## 13. Testing

| Layer | Proves | How |
|---|---|---|
| Unit | command logic, error → exit mapping, port allocation, ID uniqueness, hook policy, keep/force rules | vitest, fake `deps` |
| Git integration | clone, branch, excludes, every teardown refusal (dirty, stash, no-upstream branch, commits only in `refs/backup/*` or a tag) | temporary local bare repo as remote |
| Multi-container | two containers of one repo + one of another: no port/name overlap; parallel `init`/`create` under the lock; `doctor --prune` | temporary `HOME`/`XDG_CONFIG_HOME` |
| Hooks | env, cwd, `.d/` order, timeout, exit 3 vs failure, `pre-teardown` abort leaves everything intact, all three policies | fixture shell hooks |
| MCP | exact tool list; tool → command identity; `isError` on failure; no bypass arg in any schema and injected ones dropped; human-only tools absent; `teardown.mcp` confirm (accept/decline/unsupported), auto, off | SDK in-memory client |
| Coverage guards | every command has a capability decision; every human-only command has a deny rule | walk the command tree |
| dot-ai | `init` yields a layer `dot-ai doctor` accepts; `laines-lanes` block survives `dot-ai sync` | real bundled dot-ai in a temp dir |
| Packaging | `npm pack` → install → `init` + `create` from the tarball | `test:pack` in CI |
| Agent behaviour (pre-release, manual) | right instructions in a lane and not in a plain checkout; deny rules apply; elicitation prompts a human, including from a subagent, in headless mode, and in VS Code | scripted `claude -p` checks + manual |

CI: lint and `npm audit`; tests on Node 20, 22, 24 on macOS and Linux.

## 14. Success criteria

1. In an empty directory, `laines init ./myapp-lanes --remote <url>` produces a container that
   `dot-ai doctor` and `laines doctor` both accept.
2. `laines create` twice gives two lanes with distinct ports, scoped names, env files, and
   board entries; a second container on the same machine never overlaps either.
3. A Claude session in a lane loads container, repo, and lane instructions; a plain clone of
   the same repo elsewhere loads only the repo's.
4. A project reproduces per-lane database isolation (create on `post-create`, drop on
   `post-teardown`) purely with hooks.
5. `laines teardown` (which deletes the clone by default) refuses every unpushed-work case in §10.3 and succeeds once
   the work is pushed; a kept lane is refused even with `--force`.
6. Over MCP an agent can create, brief, report, keep, and request teardown, but cannot release,
   approve hooks, change policy or config, or force anything.
7. `laines` installed from the packed tarball passes criteria 1–2.

## 15. Open items for implementation

- Confirm elicitation behaviour in headless `claude -p` and VS Code with a real server; adjust
  only the fallback message if it differs.
- Confirm Codex `project_root_markers` with a marker above a nested `.git` behaves as
  documented before `doctor` recommends it.
- Branch flow for this repository (main with protected PRs is the default) and branch
  protection before going public.
