# Hooks

Project-specific lane setup and cleanup. Each hook is an executable file named after its event,
optionally followed by executables in `<event>.d/`, run in name order. Files whose names start
with `.` are ignored.

| Hook | Runs | Working directory | On failure |
|---|---|---|---|
| `post-create` | after a lane is cloned and its files and `.laines.env` are written; again on `laines refresh <lane>` | lane | lane kept and marked `setup-failed`; fix the hook, then `laines refresh <lane>` |
| `pre-teardown` | before anything is archived or deleted; runs again when a closed lane's leftover clone is removed | lane | teardown aborted, nothing touched |
| `post-teardown` | after the lane is closed (and its clone removed, unless `--keep-dir`) | container | warning and a board request; `laines teardown <lane>` retries it |

Environment: `LANE_NAME`, `LANE_NUMBER`, `LANE_ID`, `LANE_DIR`, `CONTAINER_DIR`, `CONTAINER_ID`,
`LANE_PORT_BASE`, `LANE_PORT_COUNT`, `LANE_SUFFIX`, `LANE_BRANCH`, `LANE_ENV_FILE`, `PORT`,
`COMPOSE_PROJECT_NAME`, `LAINES_HOOK`, `LAINES_DRY_RUN`. `pre-teardown` also gets
`LAINES_TEARDOWN_PHASE`: `close` on a lane's first teardown, `remove-clone` when a closed lane's
leftover clone is removed by a later `laines teardown` (the clone may have been reused since the close).
Cleanup hooks must therefore be safe to run twice. Standard input is empty, so a hook cannot prompt.

`PORT` is set for lanes laines cloned. For an adopted checkout laines does not set it (the project
keeps its own ports; the block is in `LANE_PORT_BASE`/`LANE_PORT_COUNT`), though a `PORT` already in
laines' own environment passes through.

`post-create` may append variables to `$LANE_ENV_FILE`. `laines refresh` rewrites that file from
scratch and runs `post-create` again, so append unconditionally, and don't edit the file by hand.
Because it runs again, make `post-create` safe to repeat (for example `createdb … || true`).

Toolchains (examples only; use whatever the project uses): lanes are clones, so version pins the
repository commits (`.tool-versions`, `.node-version`, `.python-version`, `mise.toml`,
`rust-toolchain.toml`, ...) reach every lane. Tools that trust per directory (`mise trust`,
`direnv allow`) need that step once per lane path: put it in `post-create` if your policy allows.
Install toolchains and dependencies there too (`mise install && npm ci`, `uv sync`), idempotently,
since `laines refresh` re-runs it. Hooks inherit the environment laines runs with: launching laines
through a wrapper that rewrites `PATH` (some version managers' `exec`/`x` commands do) puts that
tool first for every hook. Prefer a wrapper that invokes the runtime binary directly, or call your
version manager explicitly inside the hook.

Example `pre-teardown` (example — use your project's own stop command): stop the lane's services
while its clone still exists, so containers and volumes don't outlive it. It runs after the
unpushed-work checks and before anything is deleted, with `COMPOSE_PROJECT_NAME` set per lane:

```sh
#!/bin/sh
docker compose -p "$COMPOSE_PROJECT_NAME" down -v || true
```

This one is safe to run twice (`down` on nothing is a no-op); the hook runs again, with
`LAINES_TEARDOWN_PHASE=remove-clone`, if the closed lane's clone is later removed. Branch on that
variable if the second run should do something different.

Anything a hook leaves running must redirect its output, for example
`npm run dev >"$LANE_DIR/dev.log" 2>&1 &`: the hook's output pipes close when it exits.

Exit `0` for success, `3` when a human must act first (for example "start Postgres, then run
`laines refresh <lane>`"), anything else for failure. A hook that runs longer than
`hooks.timeoutSec` (default 300) is stopped, with everything it started. Output is captured and
shown to agents as untrusted.

Hook policy (`laines config get hooks.policy`): `notify` runs changed hooks and flags them on the
board; `approve` refuses new or changed hooks until a human runs `laines hooks approve`; `open` runs
hooks without checks. `laines hooks status` shows each hook's state and what changed. Once the
hooks are stable, a human locks them with `laines hooks approve --lock`.
