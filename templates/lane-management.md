# Lane management

How lanes are created, used, monitored and closed in container `{{containerId}}`.

## The shape of this setup

- **The container** (this directory) holds the shared `.ai/` layer, `.laines/` (settings, lane
  index, hooks, audit log), and the lanes. It is not a git repository.
- **Lanes** (`lane_1/`, `lane_2/`, …) are standard `git clone`s of the project. Each lane has its
  own port block, its own `.laines.env`, and lane-local `.ai/context/` and `.ai/plans/` (plans are part of the branch when the repository
  commits `.ai/plans/`; otherwise local, archived at teardown). Everything
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
See `.laines/hooks/README.md`.

- A lane whose `post-create` fails stays on disk, marked `setup-failed` on the board. Fix the hook
  (or what it needed), then run `laines refresh <lane>`: it rewrites the lane-local files and
  `.laines.env` and runs `post-create` again.
- `laines hooks status` lists each hook as approved, changed or new, with a diff.
- New containers run changed hooks and flag them on the board (policy `notify`). Once the hooks
  are stable, a human locks them with `laines hooks approve --lock`; from then on a changed hook
  is refused until a human approves it.

## MCP tools

Sessions in this container and in its lanes have the `laines_*` MCP tools (registered in
`.mcp.json`, which is written when Claude is a configured agent). They do what the CLI does and refuse what an agent may not do. `laines_teardown`
asks a human to confirm first (setting `teardown.mcp`); if the client cannot ask, the request
waits on the board for `laines teardown <lane>` in a terminal.

## Knowledge and pull requests

Everyone works in this container's `.ai/`. If the repository commits its own `.ai/`, `laines ai
sync <lane>` brings the lane's copy up to date before a PR (new knowledge shows in `git diff`) and
brings back knowledge that arrived through `main` (after you pull). A file changed in both places is
a conflict: sync leaves both copies alone and tells you which file to reconcile.
Once one lane commits the dot-ai scaffold to the repository, another lane's `git pull` may refuse to
overwrite its untracked copies of those files: remove the untracked copies (they are in the container) and pull again.

## Adopting an existing checkout

If this container was made with `laines adopt <dir>`, the original project folder became its first
lane and the project's `.ai/` became this shared layer. Recreate Python virtualenvs in the lane after a move.
`lane_1` keeps the project's Docker Compose project name, so existing volumes and containers stay attached; other lanes get their own (`<id>-l<n>`).

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
