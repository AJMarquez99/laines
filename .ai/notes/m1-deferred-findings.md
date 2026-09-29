# M1 deferred findings (input for the M2 plan)

Review findings from M1 (foundation + container) that were judged safe to defer. Fold the
"carry into M2" items into the M2 plan; the rest can stay deferred. Delete this note once M2's
plan has absorbed it.

## Carry into M2

- **One container loader.** Replace the repeated `resolveContainer` + `containerPaths` +
  `loadConfig` triplet with `loadContainer(opts, deps) → { root (realpath), paths, marker,
  config }`. Resolve a relative `--container` against `deps.cwd()`, but don't call `deps.cwd()`
  when the path is absolute (a deleted cwd would otherwise fail).
- **Realpath-based walks in `init`.** The `.git` and container-nesting ancestor walks use the
  lexical path, so a target reached through a symlink into a checkout is accepted. M2's
  containment checks (lexical and realpath) should share one helper with `init`.
- **Warnings in results.** Return `warnings: []` in command results, not only via `deps.warn`,
  so the MCP server (M4) can surface them.
- **`--container` on `init`.** It is registered by `withGlobals` but ignored; omit it for `init`.
- **Git arguments.** `remote`/`defaultBranch` now reject a leading `-`; M2 must still pass `--`
  before positional git arguments.

## Stay deferred

- Tests: several coverage gaps (readJson non-ENOENT rethrow, dot-ai spawn failure, id mismatch in
  doctor, dry-run with a taken `--id`, audit-write failure, `npx laines` deny-rule form).
- `writeJson` leaves a `.tmp` file if the write itself fails; no fsync.
- `withLock` with `intervalMs: 0` spins forever (no caller passes 0); lock release swallows errors.
- Generated container IDs can exceed the 32-character `--id` limit (32-char slug plus `-N`).
- `init` rollback after a failed claim removes only the leaf directory; dry run reports the
  lexical path and skips the "path already registered" check; `deps.now()` is read three times.
- Board: backticks in a branch or command break the code span; timestamps aren't ISO-validated.
- `hooks-readme.md` says `laines refresh` without `<lane>` — fix when M3 adds `refresh`.
- Users whose home directory is a git repository cannot `init` under it (by design); document it
  in the README (M5).
- `npm test` runs vitest in watch mode; `prepublishOnly` skips lint (M5 CI covers lint).
- M5: tracked `reference/` and a personal path in the archived design log need removing before
  the repository goes public.
