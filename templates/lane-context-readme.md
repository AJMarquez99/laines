# context/ — lane `{{lane}}`

This lane's live working state: current task, open questions, handoff notes for whoever picks the
lane up next. When the lane is torn down, its untracked files here are deleted, so promote
anything durable to `{{containerDir}}/.ai/knowledge/`, `guidelines/` or `lessons/` first. If the
repository commits `.ai/context/`, tracked files stay, and untracked ones count as the lane's
uncommitted work.
