## L.AI.nes lanes (container `{{containerId}}`)

This directory is a L.AI.nes container. Each `lane_*/` directory is an independent clone of the
project with its own local environment. This container's `.ai/` is the shared knowledge layer for
every lane.

**Which mode am I in?** Look for `.ai/.lane.json` at the root of the git repository you are
working in.
- **Present, the `container` path it names has `.laines/container.json`, and its `containerId`
  equals that marker's `id`:** you are in a lane. Follow the lane rules below.
- **Absent:** you are not in a lane. Ignore this section and use normal `.ai/` resolution. Do not
  look for a container or report to a board.
- **In the container directory itself (not inside a git repository):** you are the container
  session. Create, monitor and tear down lanes with `laines`; see
  `.ai/runbooks/_lane-management.md`.

**Lane rules**
1. A lane owns its `.ai/context/` and `.ai/plans/`. If the repository commits files under
   `.ai/plans/`, plans you write there are part of your branch: commit them with the work they
   describe (an uncommitted plan blocks teardown). Otherwise they stay local and are archived when
   the lane is torn down. Write new knowledge, guidelines, lessons, data and audits to this
   container's `.ai/`, never into the lane.
2. This container's `.ai/` is where you read and write knowledge, even when the repository commits
   its own `.ai/`. A lane's committed `.ai/` files are output: never edit them by hand.
   `laines ai sync <lane>` (or the `laines_ai_sync` MCP tool) moves knowledge both ways; run it
   before opening a PR so new knowledge travels with the code.
3. Never run `dot-ai init` or `dot-ai sync` inside a lane.
4. Report meaningful status changes with `laines report <lane> --status "..." --task "..."` or the
   `laines_report` MCP tool. Prefer the `laines_*` MCP tools when your session has them.
5. Do not edit `.laines/` (except hook scripts in `.laines/hooks/`, which run only as the hook
   policy allows) or another lane's files. Teardown, release, hook approval, hook policy and config
   changes are for a human. Hooks must not call these commands: laines refuses them from a hook,
   except `teardown` and `release` once a human enables `hooks.manage`.
6. Source the lane's `.laines.env` before starting services, and use only the lane's ports.
   `PORT` is set for lanes laines cloned; an adopted checkout does not get it and keeps the
   project's own ports (laines' block is still in `LANE_PORT_BASE`/`LANE_PORT_COUNT`).
