# Security Policy

## Supported versions

Only the latest release is supported. Until laines is published to npm, that is the latest `v*`
tag. Please upgrade to it before reporting an issue.

## Reporting a vulnerability

Please **do not** open a public issue for a vulnerability.

Report it privately instead, by either:

- the repository's **Security** tab: click **Report a vulnerability**
  (<https://github.com/AJMarquez99/laines/security/advisories/new>), or
- email to **alejandromarquez@live.com**, with details and steps to reproduce.

I'll acknowledge within a few days and keep you updated on the fix.

## What laines protects and what it doesn't

The README's [Trust model](README.md#trust-model) section is the full description. In short:

- **Hooks run as you.** The hook policy is the boundary: under `approve`, a new or changed hook does
  not run until a human approves it. `hooks.manage`, the `LAINES_HOOK` refusal and the Claude deny
  rules are guardrails, not a sandbox.
- **laines itself never executes anything a repository commits.** A hook you wrote, such as a
  `post-create` that runs `npm ci`, may execute repository content; that is your choice. A lane
  refuses symlinks at `.ai`, `.ai/context`, `.ai/plans`, `.claude`, and at any file laines writes.
- **Teardown over MCP needs a human by default.** `teardown.mcp` and `teardown.mcpForce` default to
  `confirm`, and forcing past unpushed work takes a typed confirmation. A client that can't ask the
  human is refused; if the lane is otherwise clear to remove, the request is left on the board for
  a human to finish with `laines teardown <lane>` (`runTeardownMcp` in
  [`src/mcp/teardown.js`](src/mcp/teardown.js)). With `teardown.mcp: auto`, the CLI's checks apply
  with no human prompt; with `teardown.mcp: off`, teardown over MCP is refused.
- **Locked mode and capabilities** limit what `laines-mcp` may do. Both are enforced in `invoke`,
  the single entry point the CLI and the MCP server share
  ([`src/commands/registry.js`](src/commands/registry.js)).

## In scope

Please report any way to make laines:

- delete or write outside a lane or container;
- tear down a kept lane by any means other than releasing it first;
- delete a clone with unpushed, uncommitted or stashed work without `--force` or the typed MCP
  confirmation (see `unpushedWork`, `forceFingerprint` and the `expect` re-check in
  [`src/commands/teardown.js`](src/commands/teardown.js));
- let an agent get past a confirmation gate without running a hook;
- let `laines-mcp` perform a locked-refused or capability-denied action without
  `.laines/config.json` being edited;
- execute committed repository content itself;
- write through a committed symlink.

## Out of scope

These follow from the documented trust model:

- anything a hook does, including hooks running under the `notify` or `open` policy;
- a hook unsetting `LAINES_HOOK` or editing `.laines/config.json`;
- an agent getting around the Claude deny rules (for example with `sh -c`), since those are prefix
  guardrails;
- code you run yourself;
- other local users reading the board or the audit log. These are plain files created under your
  umask, and laines makes no file-mode guarantee.

## Good hygiene for users

Never paste `.laines/` audit logs, board contents, or paths that name private repositories into an
issue, PR, or log.
