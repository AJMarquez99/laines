# M2 carry-overs (input for the M3, M4 and M5 plans)

Findings from the M2 (lanes) reviews that belong to later milestones. Fold each into the plan
that owns it, then delete this note.

## M3 (hooks, refresh)

- **Env file on refresh.** `writeLaneFiles` rewrites `.laines.env` every time, but spec §8.3 lets
  hooks append to it. Decide: preserve hook-appended lines (e.g. a marked generated block) or
  regenerate and have hooks write a separate file. Same question for untracked user edits to
  lane-local files, and whether `lane-local-instructions.md` should be overridable by the
  container like the lane README templates.
- **Stale `spinning up` lanes.** An interrupted `create` leaves a lane `spinning up`; teardown
  handles it, but `doctor` should flag it.
- **Small follow-ups in touched code:** test the archive's multi-entry overflow order; tighten
  explicit lane numbers to `^[1-9]\d*$` (`lane_003` currently claims number 3); add a board
  activity line for the second phase of a two-phase teardown; the create-cleanup warning can
  suggest `teardown` when unregistering actually succeeded.

## M4 (MCP server)

- **Async git.** `runGit` uses `spawnSync`; a long `clone` would freeze a long-lived server.
- **Atomic board writes.** `writeBoard` uses `writeFileSync`; make it temp-file + rename like
  `writeJson` (`watch` already tolerates an empty read).
- **Harden lane detection** for tool calls: validate `.lane.json`'s `number` and require the lane
  root to be `<container>/<lane>` (a copied lane directory is currently detected as the lane).
- **User-supplied keys into plain objects** must go through an own-property check (see
  `getLane`); the CLI's prototype-pollution bug would have poisoned a server until restart.
- `doctor` and `config get` resolve containers without the `/`-and-home guard; fine while they
  are read-only, but route any future write through `loadContainer`.

## M5 (release, SECURITY.md residual risks)

- SSH remotes: `GIT_TERMINAL_PROMPT=0` does not cover SSH passphrase or host-key prompts. From a
  terminal a human can answer; from MCP an agent needs an SSH agent or an unencrypted key.
- The unpushed-work check is local (no fetch): a remote-tracking ref left stale by a server-side
  branch deletion reads as "on a remote".
- Files ignored by the project's `.gitignore` (`.env`, local databases), submodule commits and
  linked worktrees are outside the unpushed-work check.
- `teardown` without `--remove-dir` deletes `.ai/context/` (spec §10.3 step 5), so "nothing
  irreversible" is not quite true; reword the spec.
- On case-insensitive filesystems a repo tracking `Agents.md` could have a lane-local `AGENTS.md`
  written over it.
- The port-busy error names ports, not the owning process (spec §6.4 says process).
- Custom lane names need not match the lane prefix (spec §9.1 vs §10.2): record the deviation.
