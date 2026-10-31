# Runbook: Releasing laines

How to cut a new release of `@ajmarquez99/laines` (two bins: `laines` and `laines-mcp`).

A release is a version bump on `main` plus an annotated `vX.Y.Z` tag. Pushing the tag runs
`.github/workflows/release.yml`. That workflow checks the tagged tree and then, once a human
approves the `npm` environment, publishes to npm with provenance. Nobody runs `npm publish` by
hand, except in the manual fallback below.

## How the trust is wired

This is the steady state from 1.0.1 on. 1.0.0 was bootstrapped differently (last bullet).

- **Trusted Publisher** on npmjs.com for `@ajmarquez99/laines`: GitHub Actions, repository
  `AJMarquez99/laines`, workflow `release.yml`, environment `npm`, `--allow-publish`. It is keyed
  to the workflow **filename** and the **environment name**. Renaming either breaks publishing
  until the npm side is updated to match. Check it with `npm trust list @ajmarquez99/laines`.
- **GitHub environment `npm`:** the user is the required reviewer, and deployments are limited to
  `v*` tags. A pushed tag alone can't publish: someone must approve the deployment.
- **`release.yml`** has two jobs:
  - `checks`: the tag equals `v` + the `package.json` version; the tagged commit is on `main`; an
    exact pinned npm (≥ 11.5.1, which OIDC needs); then `npm ci`, lint,
    `npm audit --omit=dev --audit-level=moderate`, the test suite and `npm run test:pack`.
  - `publish` (needs `checks`; environment `npm`; `id-token: write`):
    `npm publish --provenance --access public`. No npm cache anywhere in the workflow.
- **No long-lived token.** Right after 1.0.0 publishes (plan step A8), the package's publishing
  access is set to "Require two-factor authentication and disallow tokens". From then on only the
  OIDC path (and an interactive 2FA login, for the manual fallback) can publish.
- **1.0.0 bootstrap (Path A).** The package didn't exist before 1.0.0, so no Trusted Publisher
  could be configured for it. For 1.0.0 only, the publish step also reads `NODE_AUTH_TOKEN` from
  the `npm` environment secret `NPM_TOKEN`:
  - The token is a **granular** token with **read and write** on **All packages** (a package that
    doesn't exist yet can't be selected) and a **1-day** expiry.
  - Turn **"Bypass 2FA"** on if the account requires 2FA for writes. Without it, the publish
    fails with `EOTP` after the approval. That is recoverable: fix the secret, then re-run the
    failed job on the same tag.
  - npm tries OIDC first and silently falls back to the token (nothing shows at the default log
    level).
  - Straight after 1.0.0 publishes: revoke the token, delete the secret, and disallow tokens on
    the package.
  - 1.0.1 removes the `NODE_AUTH_TOKEN` line. Configure the Trusted Publisher only when 1.0.1 is
    ready to tag, then tag it within 48 hours. Per npm's docs, treat an unused configuration as
    expiring after 2 days.
  - The full sequence is in the M5 plan (`.ai/plans/2026-10-29-laines-1.0.0-m5-release-plan.md`,
    §1.4).

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
   npm run test:pack           # packs, installs into a temp prefix, drives both bins
   npm pack --dry-run          # lists the tarball; publishes nothing
   ```
4. Open the PR to `staging`, wait for `quality` and `ci` to go green, then **squash-merge**.
5. Open the PR `staging` → `main`, wait for green, then **merge with a merge commit**.
6. Run the pre-tag checks on `main` (see "Pre-release checks" below). Run the release job's audit
   last, right before tagging:
   ```bash
   npm audit --omit=dev --audit-level=moderate
   ```
   An advisory that lands after the tag can't be fixed on that tag, so keep the window short.
7. Tag the merge on `main` with an annotated tag and push the tag. **Pushing the tag publishes**
   (after the approval in step 8), and the tag is final:
   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "laines X.Y.Z"
   git push origin vX.Y.Z
   ```
8. Wait for the `checks` job to go green, then **approve the `npm` environment deployment** (on the
   run page: Review deployments). Watch the run to the end:
   ```bash
   gh run list --workflow release.yml --limit 1
   gh run watch <run-id>
   ```
   The publish step's log shows `npm notice publish Signed provenance statement ...` and ends
   with `+ @ajmarquez99/laines@X.Y.Z`.
9. Verify the registry copy:
   ```bash
   npm view @ajmarquez99/laines version dist-tags dist.attestations
   npm run test:pack -- --from @ajmarquez99/laines@X.Y.Z    # clean prefix, registry copy
   npx @ajmarquez99/laines@X.Y.Z --version
   ```
   - `version` and `dist-tags.latest` are `X.Y.Z`, and `dist.attestations` is present.
   - The npm page shows the provenance badge ("Built and signed on GitHub Actions").
   - In a temp project, `npm i @ajmarquez99/laines@X.Y.Z && npm audit signatures` reports a
     verified attestation.
10. Add a GitHub release for `vX.Y.Z`, with notes from the CHANGELOG.

## What ships

Only the `files` allowlist in `package.json`: `bin/`, `src/`, `templates/`, `README.md`,
`LICENSE`. Tests, `.github/` and `.ai/` are not packed. `npm pack --dry-run` shows the exact list;
compare its file count with the previous release and explain any change before tagging.

`npm run test:pack` (`test/pack-roundtrip.mjs`) proves that the tarball works, not just what it
lists:
- it packs the tree and checks the file list: both bins and every `templates/` file, and nothing
  from `test/`, `.ai/` or `.github/`;
- it installs the tarball into a throwaway global prefix;
- it drives the installed bins only: `--version`, `init` against a local bare remote, `doctor`
  (every check ok), `create` twice (distinct ports and env files), an MCP handshake
  (`initialize`, `tools/list` without the human-only commands, exit on stdin close), and
  `teardown`.

`HOME`, the laines config dir, git config and the npm userconfig all point into the sandbox, so the
real machine index is never touched. `--from <spec>` installs from the registry instead of packing;
`--keep` keeps the sandbox for inspection. It runs in CI (the `pack` job, part of the required `ci`
check) and in `release.yml`.

## Manual fallback

Use it only when GitHub Actions is down. It gives **no provenance**, so say so in the release notes.

```bash
git clone https://github.com/AJMarquez99/laines.git && cd laines
git checkout vX.Y.Z
npm ci
npm login                         # interactive, with 2FA
npm publish --access public       # prepublishOnly runs the test suite
```

If the tag's `release.yml` run is still waiting, reject its `npm` environment deployment, or it
fails on "version already exists".

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

The `quality` job runs `npm audit --audit-level=moderate`, and `release.yml` runs
`npm audit --omit=dev --audit-level=moderate`. A new advisory, often a transitive one from
`@modelcontextprotocol/sdk`, can turn `quality` red on an unrelated PR.

- Fix it with `npm audit fix` (no `--force`) in its own PR, or merge the Dependabot PR.
- If the fix touches a production dependency, raise its range floor in `package.json` too:
  `npm i -g` ignores the lockfile, so only the floor stops a fresh install resolving the
  vulnerable version.
- **Never lower `--audit-level`**, and never add an ignore to get green.

## Pre-release checks

Run these on the final `main` before every tag. They matter most before a release that rewrote
history or touched docs, fixtures or examples.

**Production audit.** `npm audit --omit=dev --audit-level=moderate`, the release job's own audit.
Run it last, right before tagging (standard release, step 6).

**Tarball.** `npm pack --dry-run` lists the expected file count, and `npm run test:pack` passes.

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

- `quality` or any `ci` cell (the `test` matrix or `pack`) is red → fix it in the code or the
  test (for example, widen a timing budget with a stated reason). Never skip a test, and never
  lower the audit level.
- The `staging` → `main` PR shows commits you don't expect, or `main` has commits `staging` lacks
  (other than a Dependabot security fix still waiting for the catch-up) → stop and reconcile first.
- `npm pack --dry-run` lists a different number of files than the last release, with no change
  that explains it → stop and check the `files` allowlist.
- A personal-reference grep or gitleaks reports a hit → don't tag. Remove it; if it is in history,
  plan a history rewrite as its own change.
- The tag already exists on the remote → never move or re-push a pushed tag. Bump to a new version.
- `release.yml` `checks` fails the tag-matches-version or on-`main` guard → the tag is wrong.
  Approve nothing. Release the right commit as a new version; the bad tag stays, unpublished.
- `release.yml` `checks` fails on `npm audit` → an advisory landed after tagging. The tag can't
  move: fix it in a patch release (`npm audit fix` through `staging` → `main`), and note in the
  CHANGELOG that the earlier version was tagged but never published.
- The publish step returns **403 or 404** → a Trusted Publisher or environment mismatch (wrong
  repository, filename or environment name, or an expired configuration). Fix the npm side, then
  **re-run the failed job** on the same tag. Don't retry blindly.
- The publish step says **"version already exists"** → that version is on npm already (a manual
  fallback, or an earlier run). Bump to a new version.
- `npm trust list @ajmarquez99/laines` shows an **expired** configuration (per npm's docs, one with
  no publish within 2 days of creating it) → revoke it (`npm trust revoke --id <id>`) and
  recreate it, then publish within 48 hours.
- `v1.0.0` is pushed but never publishes, and the fix needs a code change → the CHANGELOG marks
  1.0.0 "tagged, never published", `v1.0.0` gets no GitHub release, and 1.0.1 becomes the first
  npm version (the compatibility promise starts there).
