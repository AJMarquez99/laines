# M1 deferred findings

Review findings from M1 (foundation + container) that were judged safe to defer. The items
carried into M2 have been implemented.

## Stay deferred

- Tests: several coverage gaps (readJson non-ENOENT rethrow, dot-ai spawn failure, id mismatch in
  doctor, dry-run with a taken `--id`, audit-write failure, `npx laines` deny-rule form).
- `writeJson` leaves a `.tmp` file if the write itself fails; no fsync.
- `withLock` with `intervalMs: 0` spins forever (no caller passes 0); lock release swallows errors.
- Generated container IDs can exceed the 32-character `--id` limit (32-char slug plus `-N`).
- `init` rollback after a failed claim removes only the leaf directory; dry run reports the
  lexical path and skips the "path already registered" check; `deps.now()` is read three times.
- Board: backticks in a branch or command break the code span; timestamps aren't ISO-validated.
- Users whose home directory is a git repository cannot `init` under it (by design); document it
  in the README (M5).
- `npm test` runs vitest in watch mode; `prepublishOnly` skips lint (M5 CI covers lint).
