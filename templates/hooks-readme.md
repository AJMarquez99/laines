# Hooks

Project-specific lane setup and cleanup. Each hook is an executable file named after its event,
optionally followed by executables in `<event>.d/`, run in name order.

| Hook | Runs | Working directory | On failure |
|---|---|---|---|
| `post-create` | after a lane is cloned and its files and `.laines.env` are written; again on `laines refresh` | lane | lane kept and marked `setup-failed` |
| `pre-teardown` | before anything is archived or deleted | lane | teardown aborted, nothing touched |
| `post-teardown` | after the lane is closed | container | warning and a board note |

Environment: `LANE_NAME`, `LANE_NUMBER`, `LANE_ID`, `LANE_DIR`, `CONTAINER_DIR`, `CONTAINER_ID`,
`LANE_PORT_BASE`, `LANE_PORT_COUNT`, `LANE_SUFFIX`, `LANE_BRANCH`, `LANE_ENV_FILE`, `LAINES_HOOK`,
`LAINES_DRY_RUN`.

Exit `0` for success, `3` when a human must act first (for example "start Postgres, then run
`laines refresh`"), anything else for failure. Hooks time out after 300 seconds by default.

Hook policy (`laines config get hooks.policy`): `notify` runs changed hooks and flags them on the
board; `approve` refuses changed hooks until a human runs `laines hooks approve`; `open` runs
hooks without checks. Lock a stable set with `laines hooks approve --lock`.
