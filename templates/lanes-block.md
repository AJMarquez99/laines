## L.AI.nes lanes (container `{{containerId}}`)

This directory is a L.AI.nes container. Each `lane_*/` directory is an independent clone of the
project with its own local environment. This container's `.ai/` is the shared knowledge layer for
every lane.

**Which mode am I in?** Look for `.ai/.lane.json` at the root of the git repository you are
working in.
- **Present, and the `container` path it names has `.laines/container.json`:** you are in a lane.
  Follow the lane rules below.
- **Absent:** you are not in a lane. Ignore this section and use normal `.ai/` resolution. Do not
  look for a container or report to a board.
- **In the container directory itself (not inside a git repository):** you are the container
  session. Create, monitor and tear down lanes with `laines`; see
  `.ai/runbooks/lane-management.md`.

**Lane rules**
1. A lane owns only its `.ai/context/` and `.ai/plans/`. Write new knowledge, guidelines, lessons,
   data and audits to this container's `.ai/`, never into the lane.
2. If the repository commits its own `.ai/`, read it as project truth (it wins on conflict). Change
   it only when the task is itself a change to the project's docs.
3. Never run `dot-ai init` or `dot-ai sync` inside a lane.
4. Report meaningful status changes with `laines report <lane> --status "..." --task "..."` or the
   `laines_report` MCP tool.
5. Do not edit `.laines/` (except hook scripts in `.laines/hooks/`, which run only as the hook
   policy allows) or another lane's files. Teardown, release, hook approval, hook policy and config
   changes are for a human.
6. Source the lane's `.laines.env` before starting services, and use only the lane's ports.
