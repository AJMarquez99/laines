# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/). What semver covers for laines is set out in
[CONTRIBUTING](CONTRIBUTING.md#compatibility-semver).

## [Unreleased]

To be released as 1.0.0, the first npm release. 1.0.0 is 0.4.13 plus a raised Node floor, a few
fixes to surfaces that 1.0 freezes, and the documentation of what laines promises and what it
doesn't. There are no new commands. Releases before 1.0.0 were tags only; the
[roadmap](.ai/plans/2026-09-29-laines-roadmap.md) records what each of them delivered.

### Added
- Published to npm as `@ajmarquez99/laines`, from CI, with a provenance attestation. Install with
  `npm i -g @ajmarquez99/laines`.
- CI installs the packed tarball into a clean prefix and drives both bins (`init`, `create`,
  `doctor`, `teardown`, and an MCP handshake) before anything is published.
- `SECURITY.md` lists the known limitations and residual risks.
- A written [compatibility policy](CONTRIBUTING.md#compatibility-semver), and this changelog.

### Changed (breaking)
- **Node.js 22.12 or later is required.** Node 20 reached end of life on 2026-04-30. Both bins exit
  with a clear message on an older Node.
- **Excess arguments are an error** (commander 15). `laines doctor extra` or `laines list foo` used
  to be accepted silently; they now exit `2`.
- **Deep imports fail.** `package.json` declares `exports`, so `import '@ajmarquez99/laines'` and
  imports of its `src/` files throw `ERR_PACKAGE_PATH_NOT_EXPORTED`. laines ships two commands and
  no JS API; the bins are unaffected.

### Changed
- The README no longer says that `laines doctor` prints a user setting for Codex and Gemini. They
  read the lane-local `AGENTS.md` / `GEMINI.md`, and the container's instructions don't reach them.

### Fixed
- `ai sync` no longer follows a lane `.ai/` directory that was swapped for a symbolic link between
  planning and writing.
- `ai sync` treats file names that differ only in Unicode normalisation (NFD and NFC, as on macOS)
  as one file.
- A hand-edited `"adopted": false` in `.laines/lanes.json` no longer makes the file malformed.
- On a case-insensitive disk, a lane-local `AGENTS.md` is no longer written over a tracked
  `Agents.md` (or any other case variant).
- Teardown dry runs report `isRepo`, and the `--format json` shape is settled for 1.0 (see the
  README's JSON note).
- Guidance strings that promised too much: `create`'s "sync base not recorded" warning now says to
  run `laines doctor`, then `laines ai sync <lane>`, and the hint for a leftover clone that isn't a
  git repository names `--force` and why it's needed.
