# Use `command mv` / `command rm` / `command cp` in snippets handed to the user

**What went wrong (2026-10-03):** the myapp update instructions used a plain `mv` to replace `.laines/lanes.json`.
The user's shell aliases `mv` to `mv -i`; the prompt defaulted to "no" and the file silently stayed unchanged.

**Rule:** any shell snippet given to the user (or written into docs/runbooks) that moves, copies or deletes files
uses `command mv`, `command cp`, `command rm`. Interactive aliases are common on macOS setups.
