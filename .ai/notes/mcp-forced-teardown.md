# Forced teardown over MCP (a second human confirmation)

**Source:** user request from the myapp container, 2026-10-07.

## The gap

`laines_teardown` with `remove_dir` refuses outright when the lane has unpushed work, and the MCP path has no force
(`src/mcp/teardown.js`: "There is no force on this path"). The only way through is a human typing
`laines teardown <lane> --remove-dir --force` in a terminal, even though the human is already in the loop through the
teardown confirmation form.

What happened: myapp's lane_2 was a browser-check lane holding a copy of lane_1's unpushed branch (33 commits).
After the checks, the user asked to tear it down. The MCP teardown asked for confirmation, then refused to remove the
clone over the unpushed commits, so the user had to drop to the terminal for `--force`. Every one of those commits was
also in lane_1, so nothing was at risk.

## Proposal

When `teardown.mcp` is `confirm`, the client supports form elicitation, and the only blocker is unpushed work (not a
kept lane, not a closed lane, not a capability), offer a **second, separate elicitation** that forces the removal:

- The message lists exactly what would be lost: each ref with its commit count (and a few subjects), dirty files and
  the stash count, as the dry run already reports in `checks`.
- It asks for a **typed confirmation**, not a yes/no: the lane name, so it can't be clicked through by accident.
- On a match, the teardown runs with `force`; the audit log and the board record that the teardown was forced, and
  what was discarded.
- On decline, timeout, or a client without form elicitation, behaviour stays as it is now: refuse, with the terminal
  command.

The agent can't set force itself: there's no `force` parameter in the tool schema. Only the human's answer to the
second form unlocks it. That keeps the rule that teardown is a human decision. Consider a config switch
(e.g. `teardown.mcpForce: confirm | off`, default `off` or `confirm`, to be decided) so stricter containers can keep
today's behaviour.

## Related, worth doing alongside

- **Sibling-lane check:** before calling commits "unpushed", check whether another lane in the same container has
  them (e.g. `git -C <other lane> merge-base --is-ancestor <ref tip> <branch>`). The confirmation message, or the
  refusal itself, can then say "all 33 commits are also in lane_1", which turns a scary prompt into an informed one.
  Possibly treat commits held by a live sibling lane as safe without needing force at all.
- **Infra cleanup on teardown:** a lane's Docker stack (`docker compose -p $COMPOSE_PROJECT_NAME down -v`) outlives
  `--remove-dir` unless a `pre-teardown` hook removes it, and it has to run while the clone still exists. Worth a line
  in the hooks README or a documented example `pre-teardown`.
