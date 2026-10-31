# Contributing to laines

Thanks for helping improve laines. It manages isolated parallel lanes for coding agents, and much
of what it does is delete, clone and run hooks, so changes that keep it predictable and
safe-by-default are the most welcome.

## Getting started

```bash
git clone https://github.com/AJMarquez99/laines.git
cd laines
npm install
```

laines targets **Node.js >= 22.12**. On the Node 22 line, running the linter needs 22.13 or later (ESLint 10's floor).

## Running the tests and linter

```bash
npm run test:run   # run the vitest suite once
npm test           # vitest in watch mode
npm run lint       # eslint
```

Please add or update tests for any behavior you change, and make sure `npm run test:run` and
`npm run lint` both pass before opening a pull request.

Tests use temporary directories and local bare repositories only. They must **never** touch your
real containers, the machine index (`LAINES_CONFIG_DIR`, under `~/.config` by default), or the
network. `testDeps` in [`test/helpers.js`](test/helpers.js) points the machine index at a temp
directory, and [`test/setup.js`](test/setup.js) keeps your own git config out of every test. Use
them rather than the real environment.

## Making changes

- Keep changes **small and focused**: one logical change per pull request.
- The CLI and the `laines-mcp` server share one command registry and gated layer
  ([`src/commands/registry.js`](src/commands/registry.js)). When you change behavior, keep both
  paths consistent.
- Keep the safe defaults as they are: the `notify` hook policy, `hooks.manage` set to false, the MCP
  teardown confirmation gates, and symlink refusal. See [SECURITY.md](SECURITY.md) and the README's
  [Trust model](README.md#trust-model).
- Update the [README](README.md) and the
  [specification](.ai/plans/2026-09-29-laines-spec.md) when you add or change a command, flag or
  config key.

## The audit gate

CI runs `npm audit --audit-level=moderate`. A new advisory, often a transitive one from `@modelcontextprotocol/sdk`, can
turn the `quality` check red on a PR that didn't touch dependencies. The fix is a separate
`npm audit fix` or Dependabot PR. Never lower `--audit-level` to get a PR through.

## Submitting a pull request

1. Fork the repo and create a branch from `staging`.
2. Make your change with accompanying tests.
3. Run `npm run test:run` and `npm run lint`, and confirm both are green.
4. Open a pull request against `staging`, describing **what** changed and **why**.

`main` is release-only: changes reach it from `staging` when a release is cut.

## Reporting issues

Use the issue templates for bugs and feature requests. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md); please don't open a public issue for a vulnerability.

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE) and that you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md).
