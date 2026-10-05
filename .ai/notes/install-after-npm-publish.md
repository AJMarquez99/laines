# Install laines from npm once it's published

**Noticed:** 2026-10-03, when the maintainer's machine moved its global Node CLIs onto mise.

laines isn't on npm yet, so it's installed by running the repo's `bin/laines.js` and `bin/laines-mcp.js` from a
small wrapper on PATH, pinned to one Node version. Published CLIs are installed with mise's `npm:` backend instead.

**When the first npm release ships (M5):**
- install it as a mise tool (`npm:@ajmarquez99/laines`; the package is below mise's download-count threshold, so
  it needs `allow_low_downloads = true` after a check);
- remove the source wrappers and confirm `which -a laines` and `which -a laines-mcp` each show one entry;
- MCP registrations keep calling bare `laines-mcp`, so they need no change.
