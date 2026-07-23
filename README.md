# Agent Runner

Private standalone GitHub-issue-driven agent runner for TheTekTeam projects.

The canonical runner implementation has been imported from the proven portable boundary in `TheTekTeam/modelspend` at source commit `c6e18c00f17b92f5ac27ba2dbe37c6ba768c4dc0`. `MIGRATION-MANIFEST.json` records the exact 68-file closure, including captured regression fixtures, source commit, file modes and SHA-256 provenance.

The standalone extraction and Dell cutover remain tracked by `TheTekTeam/modelspend#686`. Source ownership has moved here; live execution is not cut over until dry-run equivalence, state migration, independent systemd installation and rollback validation pass.

## Intended Dell layout

```text
/home/gp/projects/agent-runner/             # this checkout
/home/gp/.config/agent-runner/              # project configs and secret references
/home/gp/.local/state/agent-runner/          # SQLite state, logs, locks and delivery state
/var/www/agent-runner/dashboard/             # generated read-only dashboard
```

ModelSpend is a configured project consumed by this runner. It is not the canonical owner of the runner implementation.

## Dispatch authority

New claims use one immutable ChatGPT manager packet revision and fingerprint. Legacy proceed/continue and local generated-preflight paths are retired. See [`docs/ops/AGENT-RUNNER-DISPATCH-AUTHORITY-MIGRATION.md`](docs/ops/AGENT-RUNNER-DISPATCH-AUTHORITY-MIGRATION.md).

## Validation

```bash
bash scripts/validate.sh
```

With the migration manifest present, validation checks each imported file's declared status — an exact hash match for files still `locked` to the ModelSpend import, or a well-formed provenance/ownership record for files explicitly `transferred` to canonical ownership here (see "Manifest provenance and ownership transfer" in `docs/MIGRATION.md`) — plus JavaScript syntax, the focused runner test suite, safe missing-state behaviour, installer/state-migration contracts and repository secret boundaries.
