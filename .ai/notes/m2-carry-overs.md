# M2 carry-overs (input for the M3, M4 and M5 plans)

Findings from the M2 (lanes) reviews that belong to later milestones. Fold each into the plan
that owns it, then delete this note.

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
- `hooks approve` approves whatever is on disk when it runs; a hook edited between `hooks status` and `approve` is approved unseen (approve now prints the diffs it approved). Consider `--expect <checksum>` binding approval to what the human reviewed.
- `refresh` accepts a lane still `spinning up` (the rescue path) with no age guard, so a refresh
  while a slow `create` is still in `post-create` runs the hook twice concurrently. Agents over
  MCP make this likelier: refuse a recent `spinning up` lane (doctor's `timeoutSec + 30 min`
  threshold) unless forced.
- `saveConfig` writes the parsed config back, expanding every default into `config.json`;
  `config set` should patch the one key on the raw file instead.

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
- CI on Linux: the hook test for a file with no `#!` line expects `ENOEXEC`, which macOS returns;
  Linux's exec path may run such a file through `/bin/sh` instead. Check it on the first Linux run.
- Hooks never run under the container lock: a `keep` that lands while `pre-teardown` runs aborts the teardown only after the hook's side effects (teardown re-reads `kept` just before the hook to narrow the window).
