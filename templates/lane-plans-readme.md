# plans/ — lane `{{lane}}`

Plans for this lane's current task. If the repository commits files under `.ai/plans/`, plans
you write here are part of your branch: commit them with the work they describe. An uncommitted
plan blocks teardown until it is committed (or teardown `--force` archives it). Otherwise plans
stay local and are archived to the container's `.ai/archive/` when the lane is torn down. Plans
that span several lanes belong in `{{containerDir}}/.ai/plans/`.
