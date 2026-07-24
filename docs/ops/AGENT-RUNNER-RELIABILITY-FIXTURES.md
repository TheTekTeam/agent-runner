# Agent Runner reliability fixtures

Issue: `TheTekTeam/agent-runner#69`  
Parent acceptance programme: `TheTekTeam/agent-runner#5`

## Purpose

`scripts/ops/agent-runner-reliability-fixtures.mjs` is a deterministic, test-only driver for the queue-safety behaviours that must be proven before the final Dell acceptance. It does not call GitHub, systemd, a provider, a worker, the network or deployed state.

The driver exercises the canonical production admission function directly and requires injected production selection, circuit, manager-authority, task-outcome and transition-planning functions. It fails closed when any required production function is absent. The fixture therefore does not contain a parallel scheduler or a copied admission/failure-policy table.

## Scenarios

The report always contains these closed scenario identifiers:

1. `machine-profile-refusal-before-selection`
2. `repeated-refusal-preserves-backlog`
3. `issue-specific-skip-continues`
4. `task-local-failure-releases-slot`
5. `genuine-blocker-only-blocked-plan`
6. `invalid-manager-authority-zero-mutation`
7. `serialized-output-redaction`

Each scenario contains only:

- `scenarioId`
- `passed`
- a closed bounded `reason`
- positive-allowlist evidence fields
- counters for candidates inspected, claims, attempts, worker starts and GitHub mutations

The aggregate schema is `agent-runner-reliability-fixtures/v1`, suitable for consumption by the sibling #68 acceptance evaluator.

## Safety and redaction

The fixture output rejects or omits:

- prompts and comments;
- provider output;
- tokens, credentials, cookies and environment values;
- raw stdout, stderr, logs, exception text and stacks;
- local paths;
- session or restricted handles;
- arbitrary nested objects.

Only bounded strings matching closed identifier/reason shapes and primitive positive-allowlist evidence values can be serialized.

## Production injection contract

`runReliabilityFixtures()` requires these production functions:

- `selectCandidate`
- `openProfileCircuit`
- `evaluateManagerAuthority`
- `classifyTaskOutcome`
- `planIssueTransition`

The canonical `admitMachineProfile()` and `FAILURE_SCOPES` exports are imported directly from `agent-runner-admission.mjs`.

The final Dell acceptance harness should provide adapters around the production modules without changing their decisions. Tests use deterministic synthetic adapters only; no fixture is permitted to reach an external service.

## Validation

From the repository root:

```bash
node --check scripts/ops/agent-runner-reliability-fixtures.mjs
node --test scripts/ops/agent-runner-reliability-fixtures.test.mjs
npm test
npm run validate
git diff --check
```

Focused coverage includes every scenario, a multi-candidate backlog, repeated/reopened deterministic evidence, missing production-function fail-closed behaviour, deliberate production regressions and adversarial serialization inputs.

## Non-goals

This work does not deploy, mutate SQLite or GitHub, run queue repair, invoke a worker/provider, alter manager authority, change systemd/timers, perform a canary, or close #5/#69.
