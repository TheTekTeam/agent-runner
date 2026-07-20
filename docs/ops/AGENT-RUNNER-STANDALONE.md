# Standalone Agent Runner

Issues: #658 and #686.

The canonical runner repository is `TheTekTeam/agent-runner`. ModelSpend is the first configured project consumed by it.

## Canonical commands

During the migration window, use the portable entrypoints:

```bash
node .agent-runner/scripts/runner.mjs --help
node .agent-runner/scripts/runner-cron.mjs --help
```

When `/home/gp/projects/agent-runner` contains the imported standalone implementation, these commands dispatch there exactly once. Before cutover or during rollback they use the proven local `scripts/ops` implementation. `AGENT_RUNNER_STANDALONE_DISPATCHED=1` prevents recursive redispatch.

The historical `scripts/ops/claude-runner*.mjs` paths remain compatibility entrypoints during the proving window. They are not the long-term source of truth.

## Repository and runtime paths

```text
/home/gp/projects/modelspend                  migration/source checkout
/home/gp/projects/modelspend-runner-live      configured project execution checkout
/home/gp/projects/agent-runner                standalone runner source
/home/gp/.config/agent-runner                 machine-local config and env references
/home/gp/.local/state/agent-runner/modelspend SQLite, logs, locks and delivery state
/var/www/agent-runner/dashboard               generated read-only dashboard
```

The source, live project checkout and runner checkout are deliberately separate.

## Coordinated migration

From a clean ModelSpend source checkout and reviewed Agent Runner migration branch:

```bash
bash scripts/ops/migrate-agent-runner-standalone.sh status
bash scripts/ops/migrate-agent-runner-standalone.sh prepare
```

`prepare`:

- imports the recursive runner dependency closure into the standalone checkout;
- records exact source commit and per-file SHA-256 provenance;
- creates protected XDG config/environment files without printing secrets;
- copies and verifies the SQLite/state directory;
- runs the standalone repository validation gate;
- leaves the legacy timer enabled after preparation.

Commit and push the imported standalone tree. Then prove non-mutating equivalence:

```bash
bash scripts/ops/migrate-agent-runner-standalone.sh compare -- --dry-run
```

The comparison uses separate temporary output and SQLite paths, rejects `--execute`, removes volatile timestamps/paths, and requires identical structured selection/quota/runner outcomes. It writes a protected marker containing both repository commits.

Install the new units without changing scheduling:

```bash
bash scripts/ops/migrate-agent-runner-standalone.sh install
```

Cut over only while both repositories still match the equivalence marker:

```bash
bash scripts/ops/migrate-agent-runner-standalone.sh cutover --yes
```

Cutover disables the legacy timer, enables/restarts the standalone runner and dashboard timers, verifies future triggers, and makes the legacy state path a symlink to the canonical XDG state. The old and new entrypoints therefore share state throughout the rollback window.

Rollback:

```bash
bash scripts/ops/migrate-agent-runner-standalone.sh rollback --yes
```

Rollback synchronises all state written during standalone operation into the retained legacy backup before restoring the old directory and timer.

## Stop conditions

Do not cut over when:

- either checkout is dirty;
- the source commit differs from the provenance manifest;
- legacy and standalone dry-run outcomes differ;
- the equivalence proof is more than 24 hours old;
- SQLite integrity fails;
- either new timer lacks a future trigger;
- the configured execution checkout is not `/home/gp/projects/modelspend-runner-live` or another explicitly reviewed worktree;
- secrets or machine-local state appear in Git.

## Legacy dashboard

Keep `http://dev-cluster-dell/runner-dashboard/` available until the unified Grafana dashboard reaches semantic parity and field validation proves correct active, idle, disabled and degraded states.
