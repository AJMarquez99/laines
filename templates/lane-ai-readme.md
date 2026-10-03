# .ai/ — lane `{{lane}}` (partial by design)

This lane of container `{{containerId}}` keeps only `context/` and `plans/` here. Knowledge,
guidelines, lessons, data and audits live in the container's shared layer:
`{{containerDir}}/.ai/`. Do not create those folders in this lane.

## Rules for this lane

1. **Read the shared layer first:** `{{containerDir}}/.ai/knowledge/`, `guidelines/` and
   `lessons/`, plus this repository's own committed instructions.
2. **Pick up where the last session stopped:** this lane's entry on the board
   (`{{containerDir}}/.ai/context/LANES_BOARD.md`), then `context/` and `plans/` here.
3. **Report as you work:** `laines report {{lane}} --status "..." --task "..."`.
4. **Promote before you finish:** durable findings go to the container's `knowledge/`,
   `guidelines/` or `lessons/`, not left here to be archived.
5. **Committed `.ai/` is output:** if this repository commits `.ai/`, its files in this lane change
   only through `laines ai sync {{lane}}`. Run it before opening a PR.
6. **Stay inside this lane:** source `.laines.env`, use only this lane's ports, and never run
   `dot-ai init` or `dot-ai sync` here.

Full protocol: `{{containerDir}}/.ai/runbooks/_lane-management.md`
