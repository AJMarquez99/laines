# M2–M4.5 carry-overs (input for the M5 plan)

Findings from the M2–M4.5 reviews that belong to later milestones. Fold each into the plan
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

## From M4.5 (adopt / ai sync) reviews

- `create`'s "sync base not recorded" warning promises the first `ai sync` merges both sides; untrue when the clone's `.ai` is a symlink (sync refuses) or a repaired `ai-sync.json` still holds a stale entry for that lane name. Reword to "run `laines doctor`, then `laines ai sync <lane>`".
- `ai sync` writes the base under the container lock after both trees are written; a lock timeout leaves files moved and the base unrecorded (self-heals on the next run).
- `planSync` compares un-normalised path keys: after `adopt` on macOS the container may hold an NFD name while a fresh clone lists NFC, so one file appears as two paths. Normalise keys to NFC.
- A lane with no base entry (pre-M4.5, or a warned `create`) that is behind a container which deleted a file resurrects that file into the container on its first sync (empty base = merge).
- Deleting the last committed synced `.ai/` file flips `repoCommitsAi` to false, so `ai sync` stops applying instead of propagating that final deletion.
- `adopt`: a dangling-symlink leftover (crash between renames, reached through a symlink) gives exit 2 "not a directory" instead of the leftover `mv` hint; use `readlinkSync`.
- `ai sync` TOCTOU: a lane `.ai/<dir>` swapped for a symlink between planning and writing is followed (assert `realpath(dirname(target))` inside the `.ai` root); lane-side symlink tests.
- `init` has no signal handling: Ctrl-C during seeding leaks the `seed-*` temp dir and the machine-index claim.
- Cosmetic: `copyOrDelete` leaves empty dirs and drops the mode bit; refused rows all read "(symbolic link)"; doctor runs `repoCommitsAi` twice per lane; design §3.2 lists lane_1's base after registration (code records it before).

## From M4.6 (myapp adoption fixes)

- `LAINES_OWNED` keeps excluding the pre-M4.6 plain names even at layout 2, so a project's own `.ai/runbooks/lane-management.md` (or `templates/lane-*.md`) never syncs. Gate the old names on the container's layout.
- `laneExcludes` runs one `git ls-files` per exact entry (≤8 per lane per doctor/refresh); one call would do.
- The M4.5 design doc's §4.3 result shape lacks `why` and §5 still calls the drift text a "detail" (it is a doctor `note` since M4.6).
- No concurrency test for refresh's locked migration.

## From M4.7 (repo-agnostic fixes)

- `syncLanesBlocks` throws on a malformed marker in `--dry-run` (exit 2) while the real run warns and skips the remaining agent files; catch per file so both agree.
- `excludeChanges` treats an orphan BEGIN marker differently from `upsertExclude` (dry run vs real run disagree in that malformed edge).
- `rewriteStalePaths`, `upsertBlock`, `upsertExclude` write with `writeFileSync`; switch the set to `writeFileAtomic` in one sweep.
- `adopted` is `z.literal(true)` under a strict schema: a hand-edited `false` makes `lanes.json` malformed.
- No unit test for an inherited `PORT` passing through an adopted lane's hook env (verified by probe).
- Template lines over ~100 cols remain in `templates/lane-management.md` and `templates/lane-local-instructions.md`.

## From 0.4.8 (forced teardown over MCP)

- Teardown dry runs return the internal `fingerprint` in every result (CLI JSON and MCP `dry_run`); omit it unless the MCP handler asks, or document it.
- The MCP handler re-derives "is a repo" from `plan.path`; expose `isRepo` in the dry-run result instead.
- The lanes lock narrows but does not seal the window between the last fingerprint check and `removeLaneDir` (git activity in the clone isn't serialized by it).

## From 0.4.9 (closed lanes, stale MCP server)

- Doctor's `mcp-server` check fails with a raw error when the server's own `package.json` can't be read (mid-upgrade); say "installed version unknown: <reason>" instead.
- "Stale server" detection compares with the `package.json` beside the running code; under versioned-path installs (pnpm, volta) it may never differ — say so in the docs.
- A closed lane whose leftover isn't a git repo gets a doctor note recommending `teardown --remove-dir`, which refuses without `--force`.
- Post-close detection uses the peeled commit's date, so an annotated tag created after the close on an old commit isn't flagged; state it in the spec's heuristic sentence. Add tests for tag peeling and ignored files.
- `create`: "All N lanes are in use" wording with leftovers; custom names can take a number whose leftover clone carries the same ports and compose name.
- MCP teardown reads `lanes.json` three times per call; the first form prints a full ms timestamp for the close.
