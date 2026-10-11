# Closed lanes with a remaining clone (patch after 0.4.8)

**Source:** myapp container, 2026-10-08. The user wants these as another patch release.

## What happened

In myapp, lane_2 was torn down **without** `remove_dir` (the default), so it was marked closed and its clone stayed.
Later the user asked to delete it ("tear down means delete"). 0.4.8 made that impossible for an agent:

- `laines_teardown` with `remove_dir` refused for unpushed work, and the 0.4.8 typed force form is never offered for a
  **closed** lane (`src/mcp/teardown.js`, `canForce` requires `state !== 'closed'`, from `de1473e`).
- The CLI `laines teardown … --force` is blocked for agents by the deny rules laines itself installs.

So the human had to drop to a terminal, which is the exact round trip 0.4.8 was meant to remove. Every unpushed
commit in lane_2 was also held by lane_1.

## Proposed fixes

1. **Typed force for a closed lane's leftover clone.** When the lane is closed, the clone still exists and is a git
   repository, and the only blocker is unpushed work, offer the same second form (typed lane name, same fingerprint
   re-check, same audit and board record). Removing a closed lane's directory is the only thing left to do, so the
   risk is no different from an open lane. If the closed-lane exclusion in `de1473e` had a reason beyond "nothing
   left to close", write it into the spec. Otherwise lift it.
2. **Ask about the clone up front.** In the first MCP teardown confirmation, when `remove_dir` wasn't passed, offer
   "also delete the clone" as a field. That way a plain teardown doesn't leave a clone that later needs a second
   trip.
3. **Doctor: flag closed lanes whose clone remains**, and warn when it has commits or branches newer than the
   close. In myapp, someone created and committed a `feature-x` branch (40 commits) in lane_2 a day after
   it was closed, and nothing surfaced that. Suggest: "lane_2 is closed but its clone remains (N refs changed since
   close): delete it with teardown --remove-dir, or reopen".
4. **`create` default name skips leftover directories.** With lane_2 closed but its clone present,
   `laines create` (no name) chose `lane_2` and failed with "lane_2 already exists". The default should pick the
   next number whose name is free **and** whose directory doesn't exist. The same goes for a leftover per-lane
   compose project, if laines can tell from `COMPOSE_PROJECT_NAME`.
5. **Show stale MCP servers.** myapp's session kept a `laines-mcp` started before 0.4.8, so it ran the old
   teardown with no force path, and it looked like the new feature didn't work. Options: put the server's version in
   the `laines_doctor` / `laines_status` output, have doctor compare it to the installed version, or name the
   version in refusal messages. Whichever is chosen, the fix for a stale server is "reconnect laines in /mcp".

## Not in scope

- Docker cleanup is still a `pre-teardown` hook concern (0.4.8 ships the example). myapp will adopt it
  separately.
