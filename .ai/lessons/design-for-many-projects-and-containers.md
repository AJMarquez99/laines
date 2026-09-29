# Design for any project and many containers per machine

**What went wrong:** container config defaults were sized to one author's projects (fixed base
port 4000, lane suffix `_lane_N`). Real users run L.AI.nes across many unrelated projects, often
several containers on one machine at once — fixed ports and unscoped names collide across
containers (two `lane_2`s share a port block, a database name, a Compose project).

**Rule:** every default and every per-lane resource name must be safe with N containers on one
machine, for any stack.
- Anything machine-global (ports, DB/cache names, Compose projects) is scoped by a machine-unique
  container ID and allocated through the machine registry, never a hard-coded constant.
- Ask "what happens with two containers of the same repo?" and "…of unrelated repos?" before
  accepting a default.
- Never assume a stack, language, port range, or repo layout from one example project.

**Promote to:** `guidelines/` once the conventions doc exists.
