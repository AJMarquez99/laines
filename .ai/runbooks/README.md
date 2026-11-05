<!-- BEGIN .ai-folder -->
# runbooks/

**Answers: HOW an operational task is performed (with judgment).** Procedures that include judgment
calls ("if X looks wrong, stop").

Distinct from `scripts/` (deterministic automation that runs) and the optional `skills/` (LLM-invoked).
A runbook commonly references a script for its automatable steps.

**Loading:** consulted on-task via this index — not auto-loaded.
<!-- END .ai-folder -->

## Index

| File | Answers |
|---|---|
| [releasing.md](releasing.md) | How to cut a laines release: staging → main promotion, the annotated `vX.Y.Z` tag that publishes to npm through `release.yml` (Trusted Publisher, `npm` environment approval, provenance), post-publish verification, the manual fallback, the Dependabot security-PR catch-up, the audit gate and the pre-release checks |
