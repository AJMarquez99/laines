# Security Policy

## Supported versions

Only the latest 1.x release on npm (`@ajmarquez99/laines`) is supported. Please upgrade to it
before reporting an issue.

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

## Known limitations and residual risks

These are known gaps in what laines checks. Each item says what happens and what to do about it;
none of them is a guarantee. The README's [Trust model](README.md#trust-model) describes the
boundary they sit against.

- **SSH prompts.** laines sets `GIT_TERMINAL_PROMPT=0`, which doesn't cover SSH passphrase or
  host-key prompts. From a terminal you can answer them. Over MCP an agent can't, so use an SSH
  agent (or a key without a passphrase), and accept the host key once from a terminal.
- **The unpushed-work check is local.** Teardown doesn't fetch. A remote-tracking ref that has gone
  stale (for example, after the branch was deleted on the server) still counts as "on a remote".
  Run `git -C <lane> fetch --prune` before tearing down an old lane.
- **What the unpushed-work check doesn't see.** Files your `.gitignore` ignores (`.env`, local
  databases), commits inside submodules, and linked worktrees are outside it, and teardown deletes
  the clone. Save anything you need from them in a `pre-teardown` hook.
- **`--keep-dir` still deletes the lane's `.ai/context/`.** It keeps the clone, but teardown always
  archives the lane's `.ai/plans/` and deletes its `.ai/context/`. Move context you want to keep
  into the container's `.ai/` first.
- **Hooks don't run under the container lock.** A `keep` that lands while `pre-teardown` is running
  aborts the teardown, but only after the hook's side effects. Holding the lock across your hooks
  would deadlock any hook that calls laines. Keep steps that a late `keep` should prevent out of
  `pre-teardown`.
- **`hooks approve` approves what is on disk when it runs.** A hook edited between `hooks status`
  and `hooks approve` is approved without you having seen that version. `approve` prints the diffs
  it approved: read them.
- **Teardown has a short race with activity in the clone.** The lanes lock doesn't serialize git
  activity inside the lane, so a write between the last fingerprint check and the deletion can be
  lost. The window is milliseconds, and it needs something writing in the lane being torn down.
  Stop the lane's agent first.
- **A Claude `Elicitation` or `ElicitationResult` hook can answer a teardown confirmation.** Such
  hooks run as you, so this is the same trust boundary as any hook. `laines doctor` warns when one
  is visible to a lane.
- **The deny rules don't cover every invocation.** They are prefix rules for `laines`,
  `npx laines` and `npx @ajmarquez99/laines`. Forms such as `npx -y @ajmarquez99/laines …` and
  `npx @ajmarquez99/laines@1.0.0 …` are not denied, and neither is `sh -c`. The rules steer agents
  onto the MCP tools; they don't contain an agent that has a shell.
- **A running `laines-mcp` keeps its old code after an upgrade.** laines flags a stale server when
  the installed version differs from the one it loaded. Under installs that put each version at its
  own path (for example pnpm or volta), that check may never fire. Restart your MCP client, or
  reconnect the server (`/mcp` in Claude Code), after every upgrade.

## Good hygiene for users

Never paste `.laines/` audit logs, board contents, or paths that name private repositories into an
issue, PR, or log.
