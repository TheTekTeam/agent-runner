# Agent Runner operator CLI

Issue #67 (child of #5, "simplify queue admission and make queue corruption
impossible"). This is one thin, redacted operator CLI over existing Agent
Runner configuration, admission, queue, state, repair and dashboard logic.
It creates **no** new scheduling, admission, repair or status policy: every
command imports and calls already-implemented canonical modules.

## Commands

```
agent-runner doctor --project modelspend
agent-runner queue explain --project modelspend
agent-runner queue repair --incident <id> [--dry-run|--execute]
agent-runner status --json
```

All commands accept `--config <path>` to select a project config file
(consistent with every other `scripts/ops/*.mjs` entrypoint). `doctor` and
`queue explain` additionally require `--project <id>`, which must equal the
loaded config's `projectId`; a mismatch fails closed with the closed reason
`project-identity-mismatch` rather than silently operating on the wrong
project.

### `doctor`

Reports effective project/config identity, local checkout state
(present/clean/HEAD, never raw filenames or diffs), configured
service/timer active+enabled state, SQLite/schema health (via
`buildRunnerDashboard()`), accepted-adapter routability, machine admission
(`admitMachineProfile()`), and one bounded `safeNextAction`. Read-only: it
never mutates GitHub, SQLite, or systemd unit state.

Machine admission is evaluated as if execution were requested
(`admitMachineProfile({ argv: ['--execute'], env })`) so the report reflects
the real configured opt-in/approver state rather than trivially reporting
"dry-run allowed" — `admitMachineProfile()` is a pure computation over
env/argv with no side effects, so this does not execute, claim, or launch
anything.

### `queue explain`

Calls the canonical scheduler's own `selectIssue()` (from
`claude-runner-cron.mjs`) repeatedly, in dry-run mode with `state: null`
(every internal state write becomes a no-op), through a candidate-excluding
`ghRunner` wrapper that filters already-explained issue numbers out of each
`gh issue list` response. This lets every inspected candidate be reported
exactly once with exactly one normalized `reason`, instead of stopping at
the first runnable issue the way live selection does. `settingsSnapshot` and
`readinessByAgentId` are constructed identically to `claude-runner-cron.mjs`
`main()` (gated on the same `AGENT_RUNNER_ENABLE_MULTIAGENT_ROUTING` flag),
so the reported reasons match what the live scheduler would actually
compute. `claudeResourceState` is always `null` — this command never runs a
quota preflight or otherwise touches a provider.

Every reason is passed through a closed allowlist
(`RECOGNIZED_REASON_CODES`); anything selection ever returns that is not on
that list is reported as `unclassified-skip` rather than leaked verbatim.
Never claims, comments, or mutates labels; only `gh issue list`, `gh issue
view --comments`, and `gh pr list` (all read-only `gh` subcommands) are
invoked.

### `queue repair`

Delegates directly to the existing `scripts/ops/agent-runner-queue-repair.mjs`
`main()` — the canonical deterministic incident-repair implementation
(itself built on `agent-runner-false-block-restoration.mjs`). This command
adds no repair logic of its own. Dry-run remains that module's own default;
mutation requires its existing explicit `--execute` flag. Exit codes are
forwarded verbatim (0 applied/clean, 1 partial failure, 2 ambiguous
evidence/blocked).

### `status --json`

Bounded service, timer, circuit, health, current-task, queue, attention and
notification state, built from `buildRunnerDashboard()`
(`claude-runner-dashboard-api.mjs`) plus a bounded, **read-only** projection
of the admission circuit-breaker's persisted state
(`agent-runner-circuit-breaker.mjs`'s SQLite schema, read directly with
`DatabaseSync(path, { readOnly: true })` rather than via
`AdmissionCircuitBreaker` — that class's constructor unconditionally creates
the circuit database and its tables, and its `check()` method can delete a
stale-fingerprint row; neither belongs in a read-only command). If the
circuit database does not already exist, `status` never creates it.

Only an explicit allowlist of dashboard fields is forwarded:
`operatorStatus`, `currentTask` (dashboard `activity`), `metrics.queue`,
`currentHealthConditions`, `counts`, `schemaVersion`, `ok`, `status`,
`latest.attentionEvents`, and `latest.notifications` (the latter two are
already positive-allowlisted inside `claude-runner-dashboard-api.mjs`'s
`TABLE_SERIALIZERS`). `latest.queueEvents`, `latest.quota`,
`latest.preflights`, `latest.selections`, `latest.claims`, `dashboard.error`,
`dashboard.diagnostics`, and the raw `dbPath` are never read here — those
use the dashboard's generic (non-allowlisted) row serializer, or embed raw
error text / local filesystem paths.

## Read-only / dry-run-by-default guarantees

- `doctor`, `queue explain`, and `status` never call a GitHub-mutating `gh`
  subcommand, never write to the runner state SQLite database (opening it
  through the canonical store applies only idempotent `CREATE TABLE IF NOT
  EXISTS`/`PRAGMA` statements when the database already exists — identical
  to the existing `claude-runner-state-doctor.mjs` command — and never even
  opens a database that does not yet exist), and never touch systemd unit
  state (`systemctl --user is-active`/`is-enabled` are read-only queries).
  This is proven in each module's test suite by asserting seeded row counts
  and max ids are byte-identical before and after the command runs, and by
  recording every `gh` invocation a fake runner receives and asserting none
  is a mutating subcommand.
- `queue repair` remains dry-run unless the caller passes the existing
  `--execute` flag straight through to the underlying canonical module —
  this CLI does not add, remove, or default that flag differently.
- No command starts a worker, invokes a provider CLI, or runs a quota
  preflight.

## Exit-code contract

Each command's own module documents and tests its exact mapping; the shared
shape across `doctor`/`queue explain`/`status` is:

| Exit | Meaning |
| --- | --- |
| `0` | Healthy / handled (includes an absent state DB, which is a normal fresh-install state, not an error) |
| `1` | Systemic: the state database is unreadable/corrupt, `queue explain`'s candidate scan degraded, or `status`'s dashboard reports `global_systemic_pause` |
| `2` | Usage error: unknown/missing argument, or a `--project` value that does not match the loaded config |
| `3` | Fail-closed policy pause: machine admission or the admission circuit breaker currently blocks execution (matches the existing `CANDIDATE_PAUSED_EXIT_CODE` used by `agent-runner-admission.mjs`/`agent-runner-candidate-admission.mjs`/`agent-runner-circuit-breaker.mjs`) |

`agent-runner-cli.mjs` itself only ever returns `0` (help), `2` (unknown
command/subcommand, or a caught `queue repair` argument-parse throw), or
whatever exit code the dispatched command module returns.

## Authorised code map

```
bin/agent-runner
scripts/ops/agent-runner-cli.mjs               (+ .test.mjs)
scripts/ops/agent-runner-operator-doctor.mjs    (+ .test.mjs)
scripts/ops/agent-runner-queue-explain.mjs      (+ .test.mjs)
scripts/ops/agent-runner-operator-status.mjs    (+ .test.mjs)
docs/ops/AGENT-RUNNER-OPERATOR-CLI.md
```

No canonical scheduler, admission, queue-repair, state, or dashboard module
was edited to implement this issue.
