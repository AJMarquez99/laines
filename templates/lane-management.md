# Lane management

How lanes are created, used, monitored and closed in container `{{containerId}}`.

## The shape of this setup

- **The container** (this directory) holds the shared `.ai/` layer, `.laines/` (settings, lane
  index, hooks, audit log), and the lanes. It is not a git repository.
- **Lanes** (`lane_1/`, `lane_2/`, …) are standard `git clone`s of the project. Each lane has its
  own port block, its own `.laines.env`, and lane-local `.ai/context/` and `.ai/plans/`. Everything
  else (knowledge, guidelines, lessons, data, audits) lives in the container's `.ai/` so it
  outlives any lane.
- **The board** (`.ai/context/LANES_BOARD.md`) shows every lane's status, the requests waiting on a
  human, and recent activity. `laines` generates it; nobody edits it by hand.

A session in the container creates, monitors and closes lanes. Lane work happens either in a new
agent session started inside the lane, or in a subagent the container session dispatches with the
handoff from `laines brief <lane>`.

## Creating a lane

    laines create [name] [--branch <branch>]

Clones the project, writes the lane-local files (hidden from git through `.git/info/exclude`),
allocates the lane's ports and names, writes `.laines.env`, runs the `post-create` hook, and prints
the lane's brief.

## Working in a lane

1. Read the shared layer (`knowledge/`, `guidelines/`, `lessons/` in this container's `.ai/`) and
   the repository's own instructions.
2. Check the lane's board entry, then its `context/` and `plans/`.
3. Source `.laines.env` before starting services; use only the lane's ports.
4. Report when status meaningfully changes (starting a task, blocked, in review, done):

       laines report <lane> --status in-progress --task "short description"
       laines report <lane> --blocked "waiting on staging credentials"
       laines report <lane> --note "opened PR #123"

5. Promote anything durable into the container's `.ai/` before the lane closes.

## Keeping a lane

A lane that other work depends on (for example the base of stacked PRs) should be kept:

    laines keep <lane> --reason "base of stacked PR #123"

A kept lane cannot be torn down by any path until a human runs `laines release <lane>`.

## Closing a lane

    laines teardown <lane>               # archive plans, delete context, mark closed; clone stays
    laines teardown <lane> --remove-dir  # also delete the clone

`--remove-dir` refuses if the lane has uncommitted changes, stash entries, or commits that exist on
no remote, and reports which refs hold them. Save unpushed work instead of forcing:

    git -C <lane> bundle create ~/lane-backup.bundle --all --not --remotes

Over MCP, teardown asks the human to confirm by default. Teardown, release, hook approval, hook
policy and config changes are human actions.

## Hooks

Stack-specific setup lives in `.laines/hooks/` (`post-create`, `pre-teardown`, `post-teardown`).
See `.laines/hooks/README.md`. New containers run changed hooks and flag them on the board
(policy `notify`); once the hooks are stable, lock them with `laines hooks approve --lock`.

## Monitoring

    laines watch                 # follow the board
    laines status [lane]         # current state as JSON (or --format table)
    laines doctor                # check the container, lanes and agent setup

## Common pitfalls

- **Local services are shared unless namespaced.** Separate clones do not mean separate databases,
  caches or queues. Use `LANE_SUFFIX` and the lane's ports (from `.laines.env`) in your hooks and
  config.
- **Keep lane-local config patches out of commits.** If isolation needs an edit to a tracked file,
  `git update-index --skip-worktree <file>` hides it; unset it before pulling changes to that file.
- **Stop what you start.** Stop a lane's servers before tearing it down and check its ports are
  free again.
