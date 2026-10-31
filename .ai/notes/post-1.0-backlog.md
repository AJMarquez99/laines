# Post-1.0 backlog

Findings from the M1–0.4.9 reviews that were triaged as safe to defer past 1.0.0 (M5 plan §5,
"Defer post-1.0"). None affects correctness on a normal path or data safety. Each is a 1.0.x patch
candidate, unless marked as a minor (a new flag or behaviour). When one is picked up, fold it into
that release's plan and delete its row here; delete the note when it is empty.

The items 1.0.0 fixed (F1–F6) or documented (`SECURITY.md`, the README, the spec) are not repeated
here.

## Checks still to run

| Item (source) | Notes |
|---|---|
| Codex `project_root_markers` with a marker above a nested `.git` (spec §15; M5 check C10) | Run in a temp Codex home, with a marker that exists only at the container root (for example `.laines`), then `codex exec` in a lane. If Codex honours it, a minor release brings back a doctor hint with the one-line setting (M5 decision D9). |

## Features

| Item (source) | Notes |
|---|---|
| `hooks approve --expect <checksum>` (m2) | Binds an approval to the version the human reviewed. A new flag, so a minor. The gap is documented in `SECURITY.md`. |

## Breaking changes for 2.0

| Item (source) | Notes |
|---|---|
| Remove `--remove-dir` / `remove_dir` in 2.0 (lead decision, 2026-10-30) | Deprecated and ignored since 0.4.9 (deleting the clone is the default). Kept through 1.x; removing a flag or tool parameter is a major under the compatibility policy. |

## Dependencies

| Item (source) | Notes |
|---|---|
| Drop the `minimatch` 11.0.3 override in `package.json` once ESLint depends on minimatch 11 (GHSA-g3hv-75wg-m249; added 2026-10-30) | Dev-only; the override keeps `npm audit` green until then |

## Test gaps

| Item (source) | Notes |
|---|---|
| readJson non-ENOENT rethrow; dot-ai spawn failure; doctor id mismatch; dry run with a taken `--id`; audit-write failure; the `npx laines` deny-rule form (M1) | Behaviour verified by probes or reviews |
| Concurrency of refresh's locked migration (M4.6) | |
| An inherited `PORT` passing through an adopted lane's hook env (M4.7) | Verified by a probe |
| Tag peeling and ignored files after a close; no `keep_dir` hint on a closed lane's refusal; the `state === 'closed'` guard on the post-removal update (0.4.9) | The peeled-date heuristic itself is recorded in spec §9.3 |
| The failed-removal test relies on a read-only directory, so it fails when run as root (0.4.9) | CI doesn't run as root |

## Robustness edge cases

| Item (source) | Notes |
|---|---|
| `writeJson` leaves a `.tmp` file on failure and doesn't fsync; switch `rewriteStalePaths`, `upsertBlock` and `upsertExclude` to `writeFileAtomic` in one sweep (M1, M4.7) | Needs a crash mid-write; the files are regenerable by `refresh` |
| `withLock` with `intervalMs: 0` spins; lock release swallows errors (M1) | No caller passes 0 |
| Generated container ids can exceed 32 characters (a 32-character slug plus `-N`) (M1) | Only `--id` input is validated (`ids.js`); nothing re-validates on read |
| `init` rollback after a failed claim removes only the leaf directory; its dry run shows the lexical path and skips the "already registered" check; `deps.now()` is read three times (M1) | Edge cases with no data loss |
| `init` has no signal handling: Ctrl-C during seeding leaks the `seed-*` temp dir and the machine-index claim (M4.5) | `doctor --prune` clears the claim; the temp dir is under the config dir |
| `ai sync`: a lock timeout leaves the base unrecorded (self-heals); an empty-base first sync resurrects a file the container deleted; deleting the last committed synced file flips `repoCommitsAi` to false (M4.5) | Noted in the README ("`ai sync` edge cases"); recoverable from git or the container |
| `LAINES_OWNED` still excludes the pre-M4.6 plain names at layout 2, so a project's own `runbooks/lane-management.md` or `templates/lane-*.md` never syncs; gate the old names on the layout (M4.6) | Affects only projects that commit files with those exact names; nothing is deleted |
| `syncLanesBlocks` throws on a malformed marker under `--dry-run` while the real run warns and skips; `excludeChanges` treats an orphan BEGIN marker differently from `upsertExclude` (M4.7) | Malformed-input edge; the real run is the safe one |
| `adopt`: a dangling-symlink leftover gives "not a directory" instead of the leftover `mv` hint; use `readlinkSync` (M4.5) | Wrong hint after a crash; nothing is lost |

## Wording and cosmetics

| Item (source) | Notes |
|---|---|
| `create`: "All N lanes are in use" wording when leftovers exist; a custom name can take a number whose leftover clone holds the same ports and Compose name (0.4.9) | Needs a leftover clone, which doctor already flags |
| Doctor's `mcp-server` check fails with a raw error when the server's own `package.json` can't be read (mid-upgrade); say "installed version unknown: <reason>" (0.4.9) | Transient |
| A closed lane whose clone was removed before 0.4.9 reads "clone remains" on the board (0.4.9) | Doctor's `closed:<lane>` is the on-disk truth; documented in the README |
| MCP teardown reads `lanes.json` three times per call; the first form prints a full-millisecond timestamp for the close (0.4.9) | |
| Board: backticks in a branch or command break the code span; timestamps aren't ISO-validated (M1) | |
| `copyOrDelete` leaves empty dirs and drops the mode bit; refused rows all read "(symbolic link)"; template lines over 100 columns in `templates/lane-management.md` and `templates/lane-local-instructions.md` (M4.5, M4.7) | |
| The M4.5 design doc is stale: §3.2 lists `lane_1`'s base after registration (the code records it before), §4.3's result shape lacks `why`, and §5 calls the drift text a "detail" (a doctor `note` since M4.6) (M4.5, M4.6) | Archive the design doc rather than fix it; spec §10.4 and §10.5 link it, so repoint those links in the same change |

## Performance

| Item (source) | Notes |
|---|---|
| `laneExcludes` runs one `git ls-files` per exact entry (up to 8 per lane per doctor or refresh); doctor runs `repoCommitsAi` twice per lane (M4.6, M4.5) | One call would do |
