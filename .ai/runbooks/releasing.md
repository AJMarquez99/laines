# Runbook: Releasing laines

How to cut a new release of `@ajmarquez99/laines` (two bins: `laines` and `laines-mcp`).

**laines is not on npm yet.** A release is a version bump on `main` plus an annotated `vX.Y.Z`
tag; people install from source at that tag. There is no publish workflow, token or Trusted
Publisher to manage. When the npm publish lands (M5), this runbook gains those steps.

## Branch model

- `staging` is the integration branch. Every change, release changes included, is a PR to
  `staging`, **squash-merged**.
- `main` is release-only. It moves only by a PR `staging` → `main`, **merged with a merge commit**
  (never squash or rebase, which would rewrite the commits `staging` already has).
- Tags live on `main`.

## Standard release

1. Start from an up-to-date `staging` and branch:
   ```bash
   git checkout staging && git pull
   git checkout -b release/X.Y.Z
   ```
2. Make the release change on that branch:
   - bump the version in `package.json` and `package-lock.json`
     (`npm version X.Y.Z --no-git-tag-version`; the tag comes later, on `main`);
   - add or update the release's row in `.ai/plans/2026-09-29-laines-roadmap.md`;
   - add or update the matching row in the README roadmap table.

   Name any production-dependency bump in the roadmap row.
3. Check locally:
   ```bash
   npm ci && npm run lint && npm run test:run
   npm audit --audit-level=moderate
   npm pack --dry-run          # lists the tarball; publishes nothing
   ```
4. Open the PR to `staging`, wait for `quality` and `ci` to go green, then **squash-merge**.
5. Open the PR `staging` → `main`, wait for green, then **merge with a merge commit**.
6. Tag the merge on `main` with an annotated tag and push the tag:
   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "laines X.Y.Z"
   git push origin vX.Y.Z
   ```
7. Verify: `git describe --tags` on `main` prints `vX.Y.Z`, and a fresh source install at the tag
   reports the new version (`laines --version`).

## What ships

Only the `files` allowlist in `package.json`: `bin/`, `src/`, `templates/`, `README.md`,
`LICENSE`. Tests, `.github/` and `.ai/` are not packed. `npm pack --dry-run` shows the exact list;
compare its file count with the previous release and explain any change before tagging.

## Dependabot security PRs (catch-up)

Version-update PRs target `staging` (`.github/dependabot.yml`). **Security-update PRs always target
the default branch, `main`**, whatever `target-branch` says.

After a security PR merges into `main`, bring `staging` level with it:

```bash
git checkout main && git pull
git push origin main:staging    # fast-forward (through the admin bypass once staging-protection exists)
```

- This must be a fast-forward. If the push is rejected as non-fast-forward, `staging` has commits
  `main` lacks: merge `main` into `staging` through a normal PR instead, and stop to look at why.
- **Never** bring the fix back to `staging` with a squash PR. That duplicates the commit, and the
  next `staging` → `main` merge carries it twice.

## Audit gate

The `quality` job runs `npm audit --audit-level=moderate`. A new advisory, often a transitive one
from `@modelcontextprotocol/sdk`, can turn `quality` red on an unrelated PR.

- Fix it with `npm audit fix` (no `--force`) in its own PR, or merge the Dependabot PR.
- If the fix touches a production dependency, raise its range floor in `package.json` too:
  `npm i -g` ignores the lockfile, so only the floor stops a fresh install resolving the
  vulnerable version.
- **Never lower `--audit-level`**, and never add an ignore to get green.

## Pre-release and pre-public checks

Run these on the final `main` before going public, and before any release that rewrote history or
touched docs, fixtures or examples.

**Personal references.** The terms removed in the 0.4.10 scrub are kept in the local pattern file
`.ai/runbooks/_personal-refs.txt` (one extended regex per line). It is gitignored by the `_*` rule
in `.ai/.gitignore` and must never be committed: its contents are the very terms it guards against.
If the file is missing on this machine, rebuild it before running the check; don't skip the check.

```bash
git log --all -p          | grep -inEf .ai/runbooks/_personal-refs.txt   # every diff in history
git log --all --format=%B | grep -inEf .ai/runbooks/_personal-refs.txt   # every commit message
git ls-files              | grep -inEf .ai/runbooks/_personal-refs.txt   # tracked file names
```

Each command must print nothing.

**Secrets.**

```bash
gitleaks git --no-banner --redact .    # all history; `gitleaks detect` is the deprecated spelling
```

It must report no leaks.

## If it looks wrong, stop

- `quality` or any `ci` matrix cell is red → fix it in the code or the test (for example, widen a
  timing budget with a stated reason). Never skip a test, and never lower the audit level.
- The `staging` → `main` PR shows commits you don't expect, or `main` has commits `staging` lacks
  (other than a Dependabot security fix still waiting for the catch-up) → stop and reconcile first.
- `npm pack --dry-run` lists a different number of files than the last release, with no change
  that explains it → stop and check the `files` allowlist.
- A personal-reference grep or gitleaks reports a hit → don't tag or go public. Remove it; if it is
  in history, plan a history rewrite as its own change.
- The tag already exists on the remote → never move or re-push a pushed tag. Bump to a new version.
