# Agent Runner

Private standalone GitHub-issue-driven agent runner for TheTekTeam projects.

This repository is being populated from the proven portable runner boundary tracked by `TheTekTeam/modelspend#658` and the standalone extraction/cutover tracked by `TheTekTeam/modelspend#686`.

## Intended Dell layout

```text
/home/gp/projects/agent-runner/             # this checkout
/home/gp/.config/agent-runner/              # project configs and secret references
/home/gp/.local/state/agent-runner/          # SQLite state, logs, locks and delivery state
/var/www/agent-runner/dashboard/             # generated read-only dashboard
```

ModelSpend is a configured project consumed by this runner. It is not the canonical owner of the runner implementation.

No live cutover should occur until dry-run equivalence, state migration, systemd installation and rollback validation pass.
