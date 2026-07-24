import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { FAILURE_SCOPES } from './agent-runner-admission.mjs';
import {
  ACCEPTANCE_RECORD_SCHEMA_VERSION,
  EXPECTED_REPOSITORY,
  FIXTURE_REPORT_SCHEMA_VERSION,
  PRODUCTION_DEPENDENCY_IDS,
  REDACTION_CASES,
  SCENARIO_IDS,
  defaultAdversarialValues,
  normalizeReliabilityFixtureReport,
  parseReliabilityFixtureArgs,
  runReliabilityFixtures,
  serializeReliabilityFixtureReport,
} from './agent-runner-reliability-fixtures.mjs';

const HEAD = 'a'.repeat(40);
const NOW = '2026-07-24T20:00:00.000Z';

function report() {
  return runReliabilityFixtures({ head: HEAD, now: NOW });
}

test('fixture report is bounded, complete and uses every required production seam', () => {
  const value = report();
  assert.equal(value.schemaVersion, FIXTURE_REPORT_SCHEMA_VERSION);
  assert.equal(value.acceptanceRecordSchemaVersion, ACCEPTANCE_RECORD_SCHEMA_VERSION);
  assert.equal(value.repository, EXPECTED_REPOSITORY);
  assert.equal(value.head, HEAD);
  assert.equal(value.generatedAt, NOW);
  assert.equal(value.mode, 'test-only');
  assert.equal(value.passed, true);
  assert.deepEqual(value.summary, { required: SCENARIO_IDS.length, passed: SCENARIO_IDS.length, failed: 0 });
  assert.deepEqual(value.scenarios.map(({ id }) => id), SCENARIO_IDS);
  assert.deepEqual([...value.productionModules].sort(), [...PRODUCTION_DEPENDENCY_IDS].sort());
  assert.deepEqual(value.sandbox, {
    repository: 'temporary',
    state: 'temporary-sqlite',
    externalSideEffects: false,
    restartReopenProven: true,
  });
  assert.deepEqual(value.externalSideEffects, {
    githubCalls: 0, networkCalls: 0, providerCalls: 0, subprocessCalls: 0,
    systemdCalls: 0, deployedStateWrites: 0, syntheticWorkerStarts: 1,
  });
});

test('machine/profile refusal happens before selection, attempt, child and GitHub mutation', () => {
  const value = report();
  const record = value.acceptanceRecords.negativeAdmission;
  const scenario = value.scenarios.find(({ id }) => id === 'machine-profile-refusal-before-selection');
  assert.equal(scenario.passed, true);
  assert.equal(record.refusalReason, FAILURE_SCOPES.MACHINE_PROFILE);
  assert.equal(record.claimDelta, 0);
  assert.equal(record.attemptDelta, 0);
  assert.equal(record.workerStartDelta, 0);
  assert.equal(record.githubMutationDelta, 0);
  assert.equal(record.beforeGithubIdentityId, record.afterGithubIdentityId);
  assert.equal(scenario.counters.candidatesInspected, 0);
  assert.equal(scenario.counters.childLaunches, 0);
  assert.equal(scenario.counters.modelCalls, 0);
});

test('unchanged refusal survives a state/circuit reopen and cannot consume the next candidate', () => {
  const value = report();
  const record = value.acceptanceRecords.repeatedRefusal;
  const scenario = value.scenarios.find(({ id }) => id === 'repeated-unchanged-refusal');
  assert.equal(scenario.passed, true);
  assert.equal(value.sandbox.restartReopenProven, true);
  assert.equal(record.refusalCount, 2);
  assert.equal(record.nextCandidateConsumed, false);
  assert.equal(record.claimDelta, 0);
  assert.equal(record.attemptDelta, 0);
  assert.equal(record.workerStartDelta, 0);
  assert.equal(record.githubMutationDelta, 0);
  assert.equal(record.profileFingerprintId, value.acceptanceRecords.negativeAdmission.profileFingerprintId);
});

test('issue-specific manager-authority refusal skips one issue and selects unrelated work', () => {
  const value = report();
  const record = value.acceptanceRecords.issueSkip;
  const scenario = value.scenarios.find(({ id }) => id === 'issue-local-skip-continues-scan');
  assert.equal(scenario.passed, true);
  assert.equal(record.skipReason, FAILURE_SCOPES.ISSUE_NOT_RUNNABLE);
  assert.notEqual(record.skippedIssueNumber, record.continuedIssueNumber);
  assert.equal(record.continuedCandidateSelected, true);
  assert.equal(record.skippedClaimDelta, 0);
  assert.equal(record.skippedGithubMutationDelta, 0);
});

test('task-local worker failure releases the serial slot and maps to handled service semantics', () => {
  const value = report();
  const record = value.acceptanceRecords.taskFailure;
  const scenario = value.scenarios.find(({ id }) => id === 'task-local-worker-failure-isolated');
  assert.equal(scenario.passed, true);
  assert.equal(record.scope, FAILURE_SCOPES.TASK_ATTEMPT);
  assert.equal(record.serviceExitCode, 0);
  assert.equal(record.systemdResult, 'success');
  assert.equal(record.unrelatedIssueStatusPreserved, true);
  assert.equal(record.blockedMutation, false);
  assert.equal(scenario.counters.attempts, 1);
  assert.equal(scenario.counters.workerStarts, 1);
});

test('only a genuine issue-level blocker receives the synthetic blocked transition', () => {
  const value = report();
  const entries = value.acceptanceRecords.blockerAudit.entries;
  const scenario = value.scenarios.find(({ id }) => id === 'genuine-blocker-only-blocked');
  const blocked = entries.filter(({ blockedApplied }) => blockedApplied);
  assert.equal(scenario.passed, true);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].scope, FAILURE_SCOPES.ISSUE_NOT_RUNNABLE);
  assert.match(blocked[0].realBlockerEvidenceId, /^real-blocker:/);
  for (const entry of entries.filter(({ blockedApplied }) => !blockedApplied)) {
    if (entry.scope !== FAILURE_SCOPES.ISSUE_NOT_RUNNABLE) assert.equal(entry.realBlockerEvidenceId, null);
  }
  assert.equal(scenario.counters.githubMutations, 0);
  assert.deepEqual(value.blockerTransitionPlan, {
    evidenceId: blocked[0].realBlockerEvidenceId,
    issueNumber: blocked[0].issueNumber,
    fromStatus: 'status:ready',
    toStatus: 'status:blocked',
    reasonCode: 'plan_only_awaiting_approval',
    externalMutation: false,
  });
});

test('missing, stale and edited manager authority invoke no later worker, model or GitHub path', () => {
  const value = report();
  assert.equal(value.managerAuthority.cases.length, 3);
  assert.deepEqual(value.managerAuthority.cases.map(({ caseId }) => caseId), ['missing', 'stale', 'edited']);
  for (const authorityCase of value.managerAuthority.cases) {
    assert.equal(authorityCase.refused, true);
    assert.equal(authorityCase.workerStartDelta, 0);
    assert.equal(authorityCase.modelCallDelta, 0);
    assert.equal(authorityCase.githubMutationDelta, 0);
  }
  assert.equal(value.managerAuthority.cases[0].reasonCode, 'manager-preflight-required');
  assert.equal(value.managerAuthority.cases[1].reasonCode, 'manager-preflight-revoked');
  assert.equal(value.managerAuthority.cases[2].reasonCode, 'manager-preflight-content-changed');
});

test('serialized output excludes every adversarial sink class and unknown nested fields', () => {
  const adversarial = defaultAdversarialValues();
  const value = report();
  const poisoned = {
    ...value,
    unsafe: adversarial,
    scenarios: value.scenarios.map((scenario) => ({ ...scenario, unsafe: adversarial })),
    acceptanceRecords: { ...value.acceptanceRecords, unsafe: adversarial },
    managerAuthority: { ...value.managerAuthority, unsafe: adversarial },
  };
  const serialized = serializeReliabilityFixtureReport(poisoned);
  for (const secret of Object.values(adversarial)) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(value.acceptanceRecords.redaction.cases, REDACTION_CASES);
  assert.equal(value.acceptanceRecords.redaction.leakCount, 0);
  assert.equal(value.acceptanceRecords.redaction.serialized, true);
  assert.equal(Object.hasOwn(JSON.parse(serialized), 'unsafe'), false);
  assert.equal(JSON.stringify(JSON.parse(serialized)).length < 32_000, true);
});

test('normalizer emits the exact #68 record keys without arbitrary source fields', () => {
  const value = normalizeReliabilityFixtureReport({
    head: HEAD,
    generatedAt: NOW,
    unsafe: defaultAdversarialValues(),
    scenarios: [],
    acceptanceRecords: {},
    managerAuthority: {},
  });
  assert.deepEqual(Object.keys(value.acceptanceRecords), [
    'negativeAdmission',
    'repeatedRefusal',
    'issueSkip',
    'taskFailure',
    'blockerAudit',
    'redaction',
  ]);
  assert.deepEqual(Object.keys(value.acceptanceRecords.negativeAdmission), [
    'evidenceId', 'capturedAt', 'head', 'stateDbId', 'profileFingerprintId', 'refusalReason',
    'beforeGithubIdentityId', 'afterGithubIdentityId', 'claimDelta', 'attemptDelta',
    'workerStartDelta', 'githubMutationDelta',
  ]);
});

test('CLI arguments accept an exact head and deterministic timestamp', () => {
  assert.deepEqual(parseReliabilityFixtureArgs(['--head', HEAD, '--now', NOW], {}), {
    head: HEAD,
    now: NOW,
    outputPath: null,
    help: false,
  });
  assert.throws(() => parseReliabilityFixtureArgs(['--unknown'], {}), /unknown fixture argument/);
});

test('fixture executable has no subprocess, network, systemd or GitHub client capability', () => {
  const source = readFileSync(new URL('./agent-runner-reliability-fixtures.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    /node:child_process/,
    /node:http(?:s)?/,
    /\bfetch\s*\(/,
    /\bexecFile(?:Sync)?\s*\(/,
    /\bspawn(?:Sync)?\s*\(/,
    /\bsystemctl\b/,
    /\bgh\s+(?:issue|pr|api)\b/,
  ]) assert.doesNotMatch(source, forbidden);
});
