# Agent Runner Dell reliability acceptance gate

This command is the report-only final evidence evaluator for
`TheTekTeam/agent-runner#5`, implemented by `#68` and hardened by `#74`. It
accepts one bounded JSON evidence bundle, evaluates every required acceptance
domain against one exact deployed Agent Runner head, and emits a deterministic
JSON report.

It does **not** gather or create operational evidence. Evidence capture,
deployment, queue repair, supervised canary execution, timer changes and reboot
work remain separate, explicitly authorised operator actions.

## Safety boundary

The evaluator is deliberately incapable of operational mutation:

- it imports only Node.js file-read/stat and URL helpers plus the canonical,
  side-effect-free `RUNNER_STATE_SCHEMA_VERSION` export from
  `claude-runner-state.mjs`;
- importing that constant does not construct `DatabaseSync`, call
  `openRunnerStateStore()` or open a SQLite file;
- it does not import `child_process`, HTTP/network clients or a GitHub client;
- it does not invoke `git`, `gh`, `systemctl`, a runner, worker or provider;
- it does not open or modify the live state database;
- it never executes queue repair, notification delivery, deployment, timer or
  reboot actions;
- its only runtime side effects are reading one explicitly supplied regular
  file and writing a bounded report to standard output.

The input file is limited to 1 MiB. Objects use exact positive allowlists,
arrays are bounded, and identifiers use a restricted token grammar. Unknown or
missing fields fail the complete report closed. Raw input values are never used
as error text.

## Usage

```bash
node scripts/ops/agent-runner-reliability-acceptance.mjs \
  --evidence /path/to/bounded-acceptance-evidence.json \
  --expected-head 0123456789abcdef0123456789abcdef01234567
```

Deterministic replay options:

```text
--now <ISO timestamp>       Evaluation time used for freshness checks
--max-age-seconds <n>       Maximum evidence-window age; default 604800
--help                      Print usage
```

Exit codes:

| Code | Meaning |
|---:|---|
| `0` | All 20 required gates passed |
| `1` | The evidence parsed, but at least one gate failed |
| `2` | CLI, file, size, JSON or schema input failure |

A command exit code is never acceptance evidence. A successful report requires
all durable, correlated fields described below.

## Evidence bundle contract

The top-level schema is `agent-runner-reliability-evidence/v1` and contains
exactly:

| Field | Contract |
|---|---|
| `schemaVersion` | Exact schema string |
| `acceptanceId` | Bounded evidence-run identifier |
| `repository` | Must be `TheTekTeam/agent-runner` |
| `issueNumber` | Must be `5` |
| `expectedHead` | Exact 40-character lower-case commit SHA |
| `deployedHead` | Must equal `expectedHead` and the CLI `--expected-head` |
| `stateDbId` | Opaque bounded identity for the inspected live state database |
| `stateSchemaVersion` | Must equal the evaluated code's canonical `RUNNER_STATE_SCHEMA_VERSION` |
| `windowStartedAt`, `windowEndedAt` | ISO timestamps bounding every evidence record |
| `records` | The exact record set below |

Every primary record contains `evidenceId`, `capturedAt` and `head`. Records
that depend on runner state also contain the same `stateDbId`; issue/attempt
records carry bounded numeric/string identities. Evidence outside the
acceptance window, newer than the evaluation time, from another head, state
database, issue or attempt fails closed.

The `records` object contains exactly:

| Record | Required proof |
|---|---|
| `repository` | Exact repository/head and clean deployed checkout |
| `timer` | Pre-acceptance execution service inactive and timer disabled/inactive |
| `backup` | Verified backup identity, source state identity and live/backup schema versions each equal to the canonical code schema |
| `focusedValidation` | Passing totals plus `parser`, `correlation`, `stale_evidence`, `fault_injection`, `adversarial_redaction` assertions |
| `fullValidation` | Passing totals plus `node_check`, `npm_test`, `npm_validate`, `diff_check` assertions |
| `notification` | Delivered event through the synthetic capture transport only |
| `dashboard` | Same issue, attempt and notification event, plus bounded run evidence generated after notification capture |
| `negativeAdmission` | Equal before/after GitHub identity and zero claim, attempt, worker-start and GitHub-mutation deltas |
| `repeatedRefusal` | Same profile/reason, at least two refusals, zero deltas and the next candidate unconsumed |
| `issueSkip` | `issue_not_runnable` skip with no skipped-issue mutation and continued selection of an unrelated issue |
| `taskFailure` | `task_attempt` scope, exit `0`/systemd success, unrelated issue preserved and no blocked mutation |
| `blockerAudit` | Every applied blocked transition is `issue_not_runnable` and has a genuine blocker evidence identifier |
| `canary` | One exact manager/claim/worker/change/draft-PR/terminal/notification/dashboard chain |
| `repair` | Deterministic exact first-pass restoration and a no-op second pass |
| `recurrence` | At least two distinct, strictly ordered timer triggers and service runs; enabled state alone is insufficient |
| `reboot` | Distinct before/after boot identities, enabled unit and healthy post-boot service evidence |
| `redaction` | Serialized adversarial suite, complete closed case set and zero leaks |

### Canary correlation

The canary record is intentionally stricter than a process result. Its parent
and every component must agree on the exact canary issue, attempt, deployed
runner head and state-database identity. The chain must be chronological:

1. immutable manager packet revision and SHA-256 fingerprint;
2. durable claim bound to that authority;
3. worker start bound to that authority;
4. repository change with at least one changed file and an exact commit;
5. draft pull request for that exact commit;
6. durable terminal `completed` result;
7. delivered notification for the attempt;
8. dashboard record referencing the same terminal run and notification.

An exit code of zero without durable completed evidence returns
`exit_code_only`. Historical rows, another issue or attempt, a different
manager revision/fingerprint, a non-draft publication, or mismatched dashboard
and notification identities cannot satisfy the gate.

### Backup identity and canonical schema

`stateDbId` identifies the inspected live database instance. `backupStateDbId`
records the source database identity captured by the backup evidence and must
equal it. `backupId` identifies the distinct backup artefact and therefore must
not equal `stateDbId`.

The `state_schema_current` gate is bound to the evaluated code, not to agreement
between input fields. It passes only when all three values equal the imported
`RUNNER_STATE_SCHEMA_VERSION`:

1. top-level `stateSchemaVersion`;
2. `records.backup.schemaVersion` for the live-state capture;
3. `records.backup.backupSchemaVersion` for the copied backup.

A bundle that reports the same stale version in all three places fails with
`schema_mismatch`. A mismatch in only one component also fails. Existing head,
state-database identity, freshness and backup-correlation checks still apply.

When the runner schema is bumped, the schema migration, the
`RUNNER_STATE_SCHEMA_VERSION` change, acceptance fixtures/tests, evidence
producer expectations and this documentation must be updated in the same
reviewed change. The evaluator deliberately imports the canonical constant so
it cannot retain a second numeric schema version that drifts from runtime code.
Previously captured evidence must be recaptured against the new exact head.

### Redaction proof

The exact required case vocabulary is:

```text
credentials
environment_values
exception_messages
full_issue_bodies
local_secret_paths
prompts
provider_output
raw_logs
restricted_handles
```

The proof must be over fully serialized output, set `serialized: true`, and
report `leakCount: 0`. The evaluator itself outputs only allowlisted metadata,
closed reason codes and bounded evidence identifiers. It never prints raw logs,
prompts, provider output, credentials, environment values, local secret paths,
restricted handles, arbitrary exception messages or complete issue bodies.

## Gate vocabulary

The report always contains these 20 gates in this order:

1. `repository_exact_head`
2. `checkout_clean`
3. `timer_preacceptance_disabled`
4. `state_backup_recorded`
5. `state_schema_current`
6. `focused_validation_passed`
7. `full_validation_passed`
8. `synthetic_notification_smoke_passed`
9. `dashboard_refresh_correlated`
10. `negative_admission_zero_mutation`
11. `repeated_refusal_no_queue_consumption`
12. `issue_skip_continues_scan`
13. `task_local_failure_isolated`
14. `real_blocker_only_blocked`
15. `supervised_canary_correlated`
16. `false_block_repair_verified`
17. `repair_second_pass_idempotent`
18. `timer_recurrence_passed`
19. `reboot_survival_passed`
20. `redaction_passed`

Each gate contains exactly:

```json
{
  "id": "closed_gate_identifier",
  "passed": false,
  "reasonCode": "closed_reason_code",
  "evidenceIds": ["bounded-id"],
  "safeNextAction": "Fixed, non-input-derived operator action."
}
```

The closed failure-reason vocabulary is:

```text
input_schema_invalid, input_read_failed, evidence_missing, evidence_stale,
evidence_future_dated, repository_mismatch, head_mismatch, checkout_dirty,
timer_not_disabled, service_state_invalid, backup_identity_mismatch,
schema_mismatch, validation_failed, notification_unproven,
dashboard_uncorrelated, state_db_mismatch, unexpected_mutation,
candidate_consumed, scan_not_continued, task_failure_not_isolated,
unsafe_blocked_status, issue_mismatch, attempt_mismatch, authority_mismatch,
canary_uncorrelated, exit_code_only, repair_not_deterministic,
repair_not_idempotent, recurrence_unproven, reboot_unproven,
redaction_failed, contradictory_evidence
```

Passing gates always use `passed` as the reason code.

## Output schema

The aggregate schema is
`agent-runner-reliability-acceptance-report/v1`:

```json
{
  "schemaVersion": "agent-runner-reliability-acceptance-report/v1",
  "mode": "report-only",
  "passed": false,
  "acceptanceId": "bounded-id-or-null",
  "repository": "TheTekTeam/agent-runner-or-null",
  "issueNumber": 5,
  "deployedHead": "40-character-sha-or-null",
  "evaluatedAt": "ISO timestamp",
  "summary": {
    "required": 20,
    "passed": 0,
    "failed": 20
  },
  "gates": []
}
```

The aggregate passes only when all 20 gates pass. Schema/read failures produce
all 20 failed gates and do not echo the supplied path, input, parser exception
or rejected field.

## Operational sequence

The evidence producer should capture one bounded acceptance window in this
order while retaining the same deployed head and state identity:

1. exact-head/clean checkout, timer-disabled and backup/schema evidence;
2. focused/full validation and synthetic notification/dashboard evidence;
3. negative admission, repeated refusal, skip, failure-isolation and blocked
   status audit evidence;
4. one supervised canary;
5. deterministic repair plus idempotent second pass;
6. recurrence and controlled reboot-survival evidence;
7. serialized redaction proof;
8. run this evaluator with the same exact head.

The command does not make the report merge-ready by itself. Exact-head GitHub
Actions must also pass, and the final operational acceptance remains governed
by `#70` and the parent `#5` human review/closure gates.
