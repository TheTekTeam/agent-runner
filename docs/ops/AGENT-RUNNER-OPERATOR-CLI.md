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
agent-runner projects <list|show|add|enable|disable|remove|set-default|validate>
```

All commands accept `--config <path>` to select a project config file
(consistent with every other `scripts/ops/*.mjs` entrypoint). `doctor` and
`queue explain` additionally require `--project <id>`, which must equal the
loaded config's `projectId`; a mismatch fails closed with the closed reason
`project-identity-mismatch` rather than silently operating on the wrong
project.

### `doctor`

Reports effective project/config identity, local checkout state
(present/clean/HEAD, tracked and untracked, never raw filenames or diffs),
configured service/timer `LoadState`/`ActiveState`/`UnitFileState`,
SQLite/schema health (via `readOnlyRunnerStateSnapshot()`, see below),
accepted-adapter routability, machine admission (`admitMachineProfile()`),
and one bounded `safeNextAction`. Read-only: it never mutates GitHub,
SQLite, or systemd unit state.

Machine admission is evaluated as if execution were requested
(`admitMachineProfile({ argv: ['--execute'], env })`) so the report reflects
the real configured opt-in/approver state rather than trivially reporting
"dry-run allowed" — `admitMachineProfile()` is a pure computation over
env/argv with no side effects, so this does not execute, claim, or launch
anything.

### Genuinely read-only state inspection (`readOnlyRunnerStateSnapshot()`)

`doctor` and `status` share one bounded, read-only SQLite projection,
defined once in `agent-runner-operator-doctor.mjs` and imported by
`agent-runner-operator-status.mjs`. It deliberately does **not** use
`claude-runner-dashboard-api.mjs`'s `buildRunnerDashboard()`/
`summarizeRunnerState()` or `claude-runner-state.mjs`'s
`openRunnerStateStore()`: `RunnerStateStore`'s constructor unconditionally
creates the parent directory, opens SQLite writable, and runs its full
migration path (`PRAGMA journal_mode=WAL`, schema creation, schema-version
writes) even when every table already exists.

Instead it opens the database via node:sqlite's `DatabaseSync` with a
`file:<path>?mode=ro&immutable=1` URI. This was verified empirically before
relying on it: a bare `{ readOnly: true }` open of a live WAL-mode database
still creates that database's `-shm`/`-wal` files (needed to coordinate
reads against the WAL index); adding `immutable=1` does not. The tradeoff,
made deliberately: an immutable connection makes no promise about what it
sees if the file changes underneath it mid-read. For a short-lived,
single-pass diagnostic snapshot this is an acceptable point-in-time read,
not a hard consistency requirement — the alternative (a normal read-only
connection) would violate the "never create a WAL/SHM file" requirement.

Every table and column read is drawn from a fixed local allowlist (never
`SELECT *`), and every SQL-side `LIMIT` is bounded before use. The snapshot
fails closed — a bounded `{ ok: false, status, reason, safeNextAction }`
shape, with one fixed `safeNextAction` string
(`STATE_UNAVAILABLE_SAFE_NEXT_ACTION`) shared across every failure case, and
**never** "No action required" — for:

- a missing path or missing file (`status: 'missing'`), without ever
  creating the file or its parent directory;
- a database missing any table this schema requires (`status: 'incomplete'`);
- a database that cannot be opened or queried at all, e.g. a corrupt file
  (`status: 'error'`).

`doctor`/`status` both treat any non-`ok` state as a **systemic** failure
(exit `1`), overriding any other otherwise-healthy signal.

For `status`, the same read-only-fetched `latest`/`currentHealthConditions`
data is then handed to the exact canonical, already-reviewed *pure*
functions `buildRunnerActivity()`, `buildRunnerMetrics()`, and
`buildRunnerOperatorStatus()` (`claude-runner-dashboard-api.mjs`) — those
functions only transform already-fetched plain JS data and never touch the
database themselves, so this is genuine reuse of canonical derivation
logic, not a reimplementation of it, while fixing the read path underneath
it.

### systemd unit inspection (`inspectUnit()`)

Both commands inspect `LoadState`, `ActiveState` and `UnitFileState` via one
bounded, read-only `systemctl --user show <unit> --property=... --value`
call (systemd's own fixed vocabulary — `loaded`/`not-found`/`masked`/...;
`active`/`inactive`/`failed`/...; `enabled`/`disabled`/`static`/... — never
free text, so it is safe to pass through verbatim). This distinguishes
three cases a boolean is-active/is-enabled check collapsed together:

- `installed` — the unit is loaded, regardless of its active/enabled state.
  An installed-but-inactive/disabled timer or service is the expected,
  healthy state today (the execution timer stays disabled pending #5's
  acceptance gate) and does **not** fail closed.
- `not-found` — no such unit is installed on this host at all.
- `unavailable` — inspection itself could not run (missing `systemctl`,
  unreachable `--user` bus, or any other spawn/exit failure).

`not-found` and `unavailable` for either the configured service or timer
unit both fail doctor/status closed (systemic exit `1`); only `installed`
is accepted, independent of its active/enabled state.

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
notification state, built from `readOnlyRunnerStateSnapshot()` (shared with
`doctor`, see above) plus a bounded, **read-only** projection of the
admission circuit-breaker's persisted state
(`agent-runner-circuit-breaker.mjs`'s SQLite schema, read directly through
the same `mode=ro&immutable=1` path as the main state DB, rather than via
`AdmissionCircuitBreaker` — that class's constructor unconditionally creates
the circuit database and its tables, and its `check()` method can delete a
stale-fingerprint row; neither belongs in a read-only command). If the
circuit database does not already exist, `status` never creates it.

Only an explicit allowlist of fields is ever forwarded: `operatorStatus`,
`currentTask` (from `buildRunnerActivity()`), `queue` (from
`buildRunnerMetrics().queue`), `health` (current unresolved health
conditions), `counts`, `schemaVersionState`, `ok`, `status`, `attention`
(bounded, from the read-only-fetched `attentionEvents`), and `notification`
(bounded, from the read-only-fetched `notification_events`). The raw
`queueEvents`/`quota`/`selections`/`claims` projections fetched to compute
`currentTask`/`queue`/`operatorStatus` are used only as inputs to those pure
functions and are never themselves included in the final report; neither is
`dbPath` or any raw error/exception text.

## Read-only / dry-run-by-default guarantees

- `doctor`, `queue explain`, and `status` never call a GitHub-mutating `gh`
  subcommand, never write to the runner state or circuit-breaker SQLite
  databases (both are opened exclusively through the `mode=ro&immutable=1`
  read-only path described above — verified to create no directory,
  database file, WAL/SHM file, table, index, migration or schema row, and
  to never even open a database that does not yet exist), and never mutate
  systemd unit state (`systemctl --user show ... --value` is a read-only
  query). This is proven in each module's test suite by asserting the state
  database's SHA-256 digest, `sqlite_master` schema objects,
  `runner_state_schema` rows, and parent-directory listing are byte-for-byte
  identical before and after the command runs (not merely that row counts
  match), by asserting a missing database's parent directory is never
  created, and by recording every `gh` invocation a fake runner receives and
  asserting none is a mutating subcommand.
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
| `0` | Healthy: state DB present/complete/readable, both required systemd units `installed` (regardless of active/enabled state), and (for `doctor`) machine admission allowed |
| `1` | Systemic: the state database is missing/structurally incomplete/unreadable, either required systemd unit is `not-found` or `unavailable`, `queue explain`'s candidate scan degraded, or `status`'s dashboard reports `global_systemic_pause` |
| `2` | Usage error: unknown/missing argument, or a `--project` value that does not match the loaded config |
| `3` | Fail-closed policy pause: machine admission or the admission circuit breaker currently blocks execution (matches the existing `CANDIDATE_PAUSED_EXIT_CODE` used by `agent-runner-admission.mjs`/`agent-runner-candidate-admission.mjs`/`agent-runner-circuit-breaker.mjs`) |

A missing/incomplete/unreadable state database, or a `not-found`/
`unavailable` required systemd unit, **always** fails closed with exit `1`
and a fixed `safeNextAction` — never `0`, and never "No action required".
State/unit health is checked before admission, so an admission-blocked pass
against an otherwise-unhealthy host still reports exit `1`, not `3`.

`agent-runner-cli.mjs` itself only ever returns `0` (help), `2` (unknown
command/subcommand, or a caught `queue repair` argument-parse throw), or
whatever exit code the dispatched command module returns.

## Authorised code map

```
bin/agent-runner
scripts/ops/agent-runner-cli.mjs               (+ .test.mjs)
scripts/ops/agent-runner-projects-command.mjs   (+ .test.mjs)
scripts/ops/agent-runner-operator-doctor.mjs    (+ .test.mjs)
scripts/ops/agent-runner-queue-explain.mjs      (+ .test.mjs)
scripts/ops/agent-runner-operator-status.mjs    (+ .test.mjs)
docs/ops/AGENT-RUNNER-OPERATOR-CLI.md
```

No canonical scheduler, admission, queue-repair, state, or dashboard module
was edited to implement this issue.

## `projects` (issue #177)

`agent-runner projects` is the machine-local project registry management
surface. It dispatches to `agent-runner-projects-command.mjs`, which holds no
registry policy of its own and calls only the typed contract in
`agent-runner-project-registry-store.mjs`. See
[`AGENT-RUNNER-PROJECT-REGISTRY.md`](AGENT-RUNNER-PROJECT-REGISTRY.md) for the
mutation, rollback, remove and audit semantics.

`list`, `show` and `validate` are read-only. `add`, `enable`, `disable`,
`remove` and `set-default` mutate the registry atomically under one machine-
local lock, and reconcile any mutation a previous process death interrupted
before they plan their own. Every subcommand refuses to run as root
(`root-not-permitted`), never clones a repository, never performs a GitHub
mutation, and never starts, stops, installs or alters a systemd unit, timer
or service.

`add` writes the generated project config into the registry-owned project
configuration directory (`<registry dir>/projects/`). There is no CLI flag
for that location, and the containment rule is enforced by the typed library
rather than by this command, so no caller can place a project config
elsewhere.

| Exit | Meaning |
| --- | --- |
| `0` | Command succeeded (including an idempotent no-change enable/disable) |
| `1` | Fail-closed refusal or mutation failure; stderr carries a bounded `reason` code |
| `2` | Usage error, or a root execution refusal |

`validate` returns `1` when the registry is invalid, so it is usable as a
gate. Failure output is a bounded `{ "ok": false, "reason": "<code>" }`
envelope; raw validator text (which can embed absolute machine paths) is only
added under an explicit local `--verbose`.
