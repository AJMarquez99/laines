# laines: generalized parallel-lanes kit (design, in progress)

**Status:** brainstorming. Decisions below are agreed; sections marked *Proposed* still need
review. Nothing is implemented yet. Next step after the design is approved: write the
implementation plan.

## Goal

A kit for running parallel work lanes on any git project. A "container" directory holds several independent clones
("lanes") of one repo, a shared `.ai/` that every lane inherits, and a status board lanes report
to while a top-level session creates, monitors, and tears lanes down.

Source material for the kit (the original scripts, templates, and runbook, stripped of
project-specific content) lives in `../../reference/`.

## Decisions

1. **Copyable starter kit, not an installed tool.** `laines/` is copied into each new
   container. Each container owns its copy and may diverge; kit updates are re-copied by hand.
2. **Config + hooks for project-specific behavior.** A `lanes.conf` holds generic settings;
   optional hook scripts carry anything project-specific (credential keys, DB isolation, DB
   cleanup). The scripts themselves stay project-agnostic.
3. **Assumes the `.ai/` convention.** Kit files land in the container's `.ai/scripts/`,
   `.ai/templates/`, `.ai/runbooks/`; the board is `.ai/context/LANES_BOARD.md`; lanes carry only
   `.ai/README.md`, `.ai/context/`, `.ai/plans/`.

## Understanding (confirm or correct)

- **Stated:** kit at `laines/`, copyable, config + hooks, `.ai/` layout.
- **Assumed:**
  - bash, macOS + Linux, git-only (every lane is a `git clone` of one remote)
  - existing containers are not migrated as part of this work
  - `laines` becomes its own git repo
  - agent-agnostic: the board is the channel, `SendMessage` is an optional extra
- **Success:** in an empty dir, run the installer, set a remote in `lanes.conf`, and
  `lane-create` / `lane-report` / `lane-teardown` / `watch-file` behave like the versions in
  `reference/` (including teardown's unpushed-work safety checks). Per-lane DB isolation (config
  patch, env file, DB drop on teardown) must be reproducible purely through hooks.

## What's generic vs. project-specific

| Generic (port as-is, parameterized) | Project-specific (becomes config or hook examples) |
|---|---|
| clone-per-lane, next free `lane_N` naming | repo remote URL (`LANES_REMOTE` today) |
| board + `mkdir` lock (`lane-report.sh`) | copying gitignored secrets/keys into a fresh clone |
| lane-local `.ai/` templates | per-lane DB name suffix: config patch + `skip-worktree` + env file |
| teardown: archive plans, delete context, mark closed | dropping a lane's databases on teardown |
| teardown safety: dirty tree, stashes, `rev-list --all --not --remotes` | per-lane port convention |
| `watch-file.sh` | framework-specific gotchas (seeding, test schema, shared services) |
| lane ownership rules (CLAUDE.md snippet) | |

## Approach (proposed, recommended)

`install.sh <container-dir> [--remote URL]` copies `kit/` into `<container>/.ai/`, creates
missing `.ai/` folders, writes `lanes.conf` from the example, appends the lane-ownership section
to the container's `CLAUDE.md`, and refuses to overwrite existing files without `--force`.

Rejected: plain `cp -R` with README steps (easy to miss the CLAUDE.md snippet or board
gitignore); GitHub template repo (the container itself isn't a git repo, only its lanes are).

## Design section 1: kit layout (proposed, awaiting review)

```
laines/
├── README.md               # what it is, quickstart
├── install.sh              # copies kit/ into a container
└── kit/                    # mirrors <container>/.ai/
    ├── lanes.conf.example  # REMOTE_URL, DEFAULT_BRANCH, LANE_PREFIX=lane_, BASE_PORT
    ├── scripts/
    │   ├── lane-create.sh  lane-report.sh  lane-teardown.sh  watch-file.sh
    │   └── lib/common.sh   # config loading, paths, hook runner
    ├── hooks/
    │   └── examples/       # post-create / pre-teardown / post-teardown samples
    ├── templates/          # lane-ai-root-readme, lane-context-readme, lane-plans-readme
    ├── runbooks/lane-management.md   # generalized; project-specific gotchas stripped
    ├── context/README.md             # board-is-long-lived exception
    └── CLAUDE.snippet.md             # lane-ownership section
```

Hooks go live by copying an example from `hooks/examples/` into `.ai/hooks/`.
DB cleanup is not a generic script: it becomes a `post-teardown` hook example.

## Remaining design sections (not yet presented)

- Script and hook behavior: hook contract (env vars passed, e.g. `LANE_NAME`, `LANE_DIR`,
  `LANE_NUMBER`, `CONTAINER_DIR`; exit-code semantics; whether a failing `pre-teardown` aborts)
- `lanes.conf` format and defaults
- Board format and lock behavior (carry over from `lane-report.sh`)
- Error handling and safety checks (teardown refusals, `--force`)
- Testing approach (e.g. a throwaway local bare repo as the remote)
