# Agent Runner reliability fixtures

Issue: `TheTekTeam/agent-runner#69`  
Parent acceptance programme: `TheTekTeam/agent-runner#5`  
Manager packet: `AR69-RELIABILITY-FIXTURES-2026-07-24.2`

## Purpose

`scripts/ops/agent-runner-reliability-fixtures.mjs` is a deterministic,
test-only fault-injection harness for the remaining reliability acceptance
claims in #5. It exercises the production admission, candidate-selection,
manager-authority, circuit-breaker, state-store, recovery and service-semantics
modules through injected dependencies. It does not copy their policy tables or
implement an alternative scheduler.

The executable creates only:

- a temporary repository marker under the operating-system temporary directory;
- a temporary Agent Runner SQLite state database;
- a temporary admission-circuit SQLite database.

All three are removed before the process returns. The harness has no subprocess,
network, GitHub-client, systemd, provider or deployed-state capability.

## Scenarios

| Fixture | Production boundary | Required proof |
| --- | --- | --- |
| Machine/profile refusal before selection | `admitMachineProfile`, `AdmissionCircuitBreaker`, `serviceExitCode`, `openRunnerStateStore` | No candidate inspection, claim, attempt, child launch, worker start, model call or GitHub mutation; handled service result. |
| Repeated unchanged refusal | `AdmissionCircuitBreaker.check`, reopened temporary SQLite | The existing profile circuit stops the next pass before selection and the next candidate remains unconsumed. |
| Issue-specific non-runnable candidate | `resolveIssueSelection` | Missing manager authority skips one issue while a separate issue with valid authority remains selectable; no claim or mutation occurs for the skipped issue. |
| Task-local worker failure | `serviceExitCode`, `resolveIssueSelection` | A synthetic worker start fails locally, the serial slot is released in `finally`, systemd semantics remain successful and the next issue stays eligible. No real provider is called. |
| Genuine issue blocker only | `decideRecovery`, `FAILURE_SCOPES` | Only the synthetic issue-level `plan_only_awaiting_approval` case produces an in-memory `status:ready → status:blocked` plan. Systemic, machine-profile, task-attempt, completed and ordinary issue-skip cases do not. |
| Manager authority refusals | `resolveCurrentManagerAuthority`, `parseManagerPreflightPacket`, `managerAuthorityKeyIsCurrent` | Missing, superseded and same-revision edited authority all refuse before worker/model/GitHub callbacks. |
| Serialized redaction | positive-allowlist report serializer | Credentials, environment values, exception text, full issue bodies, local secret paths, prompts, provider output, raw logs and restricted handles are absent from the complete serialized report. |

The `modelCalls` and `workerStarts` counters are synthetic control-flow counters.
A value of one in the task-local fixture means the injected test worker boundary
was reached; it does not represent a provider request. `externalSideEffects`
separately proves all real external-capability counts are zero.

## Running

Run against the exact repository head represented by the evidence:

```bash
node scripts/ops/agent-runner-reliability-fixtures.mjs \
  --head "$(git rev-parse HEAD)" \
  --output /tmp/agent-runner-reliability-fixtures.json
```

The executable does not run `git` itself. `--head` is explicit so the caller,
CI job or later Dell acceptance command binds the report to the exact checked
out commit without granting the fixture subprocess capability.

Options:

```text
--head <40-character SHA>  required unless GITHUB_SHA is present
--now <ISO timestamp>      deterministic capture time
--output <file>            optional mode-0600 JSON file; stdout otherwise
--help
```

Exit `0` means all seven fixture scenarios passed. Exit `1` means an invariant
failed or the input was invalid. Errors are deliberately collapsed to one fixed
message; arbitrary exception text is never emitted.

## Evidence schema

Top-level schema:

```text
agent-runner-reliability-fixtures/v1
```

The report contains:

- exact repository head and generated timestamp;
- seven bounded scenario results;
- the production functions actually exercised;
- temporary-repository/temporary-SQLite and restart/reopen proof;
- a positive-allowlist `managerAuthority` result;
- one explicit synthetic blocker transition plan;
- zero-valued real external-side-effect counters;
- `acceptanceRecords`, whose six record shapes match the corresponding strict
  fields in #68's `agent-runner-reliability-evidence/v1` bundle.

The #68-compatible records are:

```text
negativeAdmission
repeatedRefusal
issueSkip
taskFailure
blockerAudit
redaction
```

A later Dell acceptance collector may copy those six objects directly into the
same-named `records.*` positions of the full #68 evidence bundle. It must still
supply the operational evidence that a test-only fixture cannot prove:
repository/deployment identity, timer state, backup/schema, validations,
notification/dashboard correlation, canary, repair, recurrence and reboot.
The fixture report is therefore consumable evidence, not a substitute for the
live acceptance gate.

## Redaction contract

Serialization reconstructs the report from a positive allowlist. Unknown keys
are discarded at the top level and within nested scenarios, acceptance records,
authority cases and transition plans. No raw issue, comment, environment,
exception, log, provider or filesystem object is serialized.

The adversarial test injects unique values for all nine redaction classes into
unknown fields and into the synthetic thrown worker error, serializes the entire
report and verifies every value is absent. The #68-compatible redaction record
contains exactly the case names expected by the acceptance evaluator and a zero
leak count.

## External-side-effect boundary

The fixture executable imports no `node:child_process`, `node:http`,
`node:https` or GitHub client. It contains no `fetch`, `gh`, `systemctl`, worker
binary or provider invocation. It never reads or writes the deployed Dell state,
never mutates a real issue, never runs queue repair, never changes a timer and
never creates a worktree or pull request.

All GitHub operations used to implement #69 occur outside the fixture through
the ordinary reviewed repository workflow.

## Validation

Required repository checks:

```bash
node --check scripts/ops/agent-runner-reliability-fixtures.mjs
node --check scripts/ops/agent-runner-reliability-fixtures.test.mjs
node --test scripts/ops/agent-runner-reliability-fixtures.test.mjs
npm test
npm run validate
git diff --check
```

The focused suite covers every scenario above, state/circuit reopen behaviour,
strict #68 record keys, deterministic CLI parsing and a source-level assertion
that the fixture executable has no external execution or network capability.
