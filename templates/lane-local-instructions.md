# Lane `{{lane}}` of L.AI.nes container `{{containerId}}`

You are working in a lane: an isolated clone with its own ports and local environment.

- Lane ID: `{{laneId}}`; created on branch `{{branch}}`.
- Ports: {{portStart}}–{{portEnd}}. Source `.laines.env` in this directory before starting services.
- Shared knowledge lives in `{{containerDir}}/.ai/`. Read its `knowledge/`, `guidelines/` and
  `lessons/`, and write durable findings there, not into this lane.
- If this repository commits `.ai/`, don't edit the lane's `.ai/` files by hand: run
  `laines ai sync {{lane}}` before opening a PR.
- This lane owns only `.ai/context/` and `.ai/plans/`. Never run `dot-ai init` or `dot-ai sync` here.
- Report status with `laines report {{lane}} --status "..." --task "..."`. The board is
  `{{containerDir}}/.ai/context/LANES_BOARD.md`.
- Teardown, release, hook approval, hook policy and config changes are for a human.

Full protocol: `{{containerDir}}/.ai/runbooks/_lane-management.md`
