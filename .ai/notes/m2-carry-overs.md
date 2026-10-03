# M2–M4 carry-overs (input for the M5 plan)

Findings from the M2–M4 reviews that belong to later milestones. Fold each into the plan
that owns it, then delete this note.

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
- `hooks approve` approves what is on disk when it runs; a hook edited between `hooks status` and `approve` is approved unseen (approve prints the diffs it approved). `--expect <checksum>` would bind approval to what the human reviewed.
- Only `git clone` runs asynchronously; other git calls are short local operations and stay synchronous, briefly blocking the MCP server.
- Spec §15: confirm elicitation in headless `claude -p` and VS Code against a real `laines-mcp`; adjust only the fallback message if it differs.
