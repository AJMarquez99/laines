# Hooks

Project-specific lane setup and cleanup. Each hook is an executable file named after its event,
optionally followed by executables in `<event>.d/`, run in name order. Files whose names start
with `.` are ignored.

| Hook | Runs | Working directory | On failure |
|---|---|---|---|
| `post-create` | after a lane is cloned and its files and `.laines.env` are written; again on `laines refresh <lane>` | lane | lane kept and marked `setup-failed`; fix the hook, then `laines refresh <lane>` |
| `pre-teardown` | before anything is archived or deleted | lane | teardown aborted, nothing touched |
| `post-teardown` | after the lane is closed (and its clone removed, with `--remove-dir`) | container | warning and a board request; `laines teardown <lane>` retries it |

Environment: `LANE_NAME`, `LANE_NUMBER`, `LANE_ID`, `LANE_DIR`, `CONTAINER_DIR`, `CONTAINER_ID`,
`LANE_PORT_BASE`, `LANE_PORT_COUNT`, `LANE_SUFFIX`, `LANE_BRANCH`, `LANE_ENV_FILE`, `PORT`,
`COMPOSE_PROJECT_NAME`, `LAINES_HOOK`, `LAINES_DRY_RUN`. Standard input is empty, so a hook cannot
prompt.

`post-create` may append variables to `$LANE_ENV_FILE`. `laines refresh` rewrites that file from
scratch and runs `post-create` again, so append unconditionally, and don't edit the file by hand.
Because it runs again, make `post-create` safe to repeat (for example `createdb … || true`).

Exit `0` for success, `3` when a human must act first (for example "start Postgres, then run
`laines refresh <lane>`"), anything else for failure. A hook that runs longer than
`hooks.timeoutSec` (default 300) is stopped, with everything it started. Output is captured and
shown to agents as untrusted.

Hook policy (`laines config get hooks.policy`): `notify` runs changed hooks and flags them on the
board; `approve` refuses changed hooks until a human runs `laines hooks approve`; `open` runs
hooks without checks. `laines hooks status` shows each hook's state and what changed. Once the
hooks are stable, a human locks them with `laines hooks approve --lock`.
