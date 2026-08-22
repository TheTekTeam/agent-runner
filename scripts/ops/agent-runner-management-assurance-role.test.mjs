import assert from 'node:assert/strict';
import test from 'node:test';

import { createAssuranceCapabilities, resolveRoleCapabilities } from './agent-runner-management-control-mode.mjs';
import { ASSURANCE_FINDING_SEVERITY, runQueueAssurance } from './agent-runner-management-assurance-role.mjs';
import {
  HEAD_SHA,
  LABELS,
  PROJECT_ID,
  PULL_REQUEST_NUMBER,
  READY_ISSUE_NUMBER,
  REPOSITORY,
  SOURCE_SHA,
  T0,
  assuranceObservation,
} from './agent-runner-management-test-fixtures.mjs';

const EVENT = Object.freeze({
  eventId: 'management-assurance-1',
  eventType: 'queue-assurance-required',
  projectId: PROJECT_ID,
  repository: REPOSITORY,
  correlationId: 'correlation-1',
  causalDepth: 1,
});

function runAssurance({ observation = assuranceObservation(), event = EVENT, mode = 'active' } = {}) {
  const capabilities = createAssuranceCapabilities({ mode, readers: { collectEvidence: () => observation } });
  return runQueueAssurance({ event, capabilities, now: T0 });
}

function classesOf(result) {
  return result.findings.map((finding) => finding.findingClass);
}

test('a clean queue produces no finding and no successor', () => {
  const result = runAssurance();
  assert.equal(result.outcome, 'clean');
  assert.equal(result.reason, 'no-discrepancy-detected');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.successors, []);
});

test('a ready label over an open dependency is a false ready state', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      queue: {
        issues: [
          { number: 501, state: 'open', labels: [], dependsOn: [] },
          { number: 502, state: 'open', labels: [LABELS.ready], dependsOn: [501] },
        ],
        readyLabel: LABELS.ready,
        inProgressLabel: LABELS.inProgress,
      },
    }),
  });
  assert.ok(classesOf(result).includes('false-ready-state'));
  assert.equal(result.outcome, 'correctable-discrepancy');
});

test('an in-progress label with no lease and no pull request is a false busy state', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      queue: {
        issues: [{ number: 501, state: 'open', labels: [LABELS.inProgress], dependsOn: [] }],
        readyLabel: LABELS.ready,
        inProgressLabel: LABELS.inProgress,
      },
    }),
  });
  assert.ok(classesOf(result).includes('false-busy-state'));
  assert.equal(result.outcome, 'correctable-discrepancy');
});

test('idle safe capacity with runnable work is a correctable discrepancy that wakes programme reconciliation', () => {
  const result = runAssurance({
    observation: assuranceObservation({ capacity: { implementationSlotOccupied: false, readyWorkAvailable: true } }),
  });
  assert.deepEqual(classesOf(result), ['idle-safe-capacity']);
  assert.equal(result.outcome, 'correctable-discrepancy');
  assert.deepEqual(result.successors.map((entry) => entry.eventType), ['programme-reconcile-required']);
});

test('the correctable successor carries classification identity only, never an instruction', () => {
  const result = runAssurance({
    observation: assuranceObservation({ capacity: { implementationSlotOccupied: false, readyWorkAvailable: true } }),
  });
  const [successor] = result.successors;
  assert.deepEqual(Object.keys(successor).sort(), ['correlationId', 'eventType', 'issueNumber', 'notBefore', 'pullRequestNumber', 'sha']);
  // There is no field in which a label, mutation or command could be carried.
  assert.equal(successor.eventType, 'programme-reconcile-required');
});

test('two live authorities for one issue are a duplicate-authority finding', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      authorities: [
        { authorityKey: 'mwa:key-a', issueNumber: READY_ISSUE_NUMBER, baseSha: SOURCE_SHA, state: 'issued' },
        { authorityKey: 'mwa:key-b', issueNumber: READY_ISSUE_NUMBER, baseSha: SOURCE_SHA, state: 'issued' },
      ],
    }),
  });
  assert.ok(classesOf(result).includes('duplicate-authority'));
  assert.equal(result.outcome, 'owner-attention');
});

test('a repeated authority key is a duplicate even across ledger states', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      authorities: [
        { authorityKey: 'mwa:key-a', issueNumber: READY_ISSUE_NUMBER, baseSha: SOURCE_SHA, state: 'consumed' },
        { authorityKey: 'mwa:key-a', issueNumber: READY_ISSUE_NUMBER, baseSha: SOURCE_SHA, state: 'issued' },
      ],
    }),
  });
  assert.ok(classesOf(result).includes('duplicate-authority'));
});

test('a live authority bound to a moved base is a stale-authority finding', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      authorities: [{ authorityKey: 'mwa:key-a', issueNumber: READY_ISSUE_NUMBER, baseSha: 'c'.repeat(40), state: 'issued' }],
    }),
  });
  assert.deepEqual(classesOf(result), ['stale-authority']);
  assert.equal(result.outcome, 'correctable-discrepancy');
});

test('a required check read at a head other than the current one is wrong-SHA validation', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      checks: [{ pullRequestNumber: PULL_REQUEST_NUMBER, headSha: HEAD_SHA, checkedSha: 'e'.repeat(40), required: true }],
    }),
  });
  assert.deepEqual(classesOf(result), ['wrong-sha-validation']);
  // An advisory check read at a stale head is not a finding.
  const advisory = runAssurance({
    observation: assuranceObservation({
      checks: [{ pullRequestNumber: PULL_REQUEST_NUMBER, headSha: HEAD_SHA, checkedSha: 'e'.repeat(40), required: false }],
    }),
  });
  assert.deepEqual(advisory.findings, []);
});

test('completion claimed without merge evidence needs an owner', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      completions: [{ issueNumber: READY_ISSUE_NUMBER, claimedComplete: true, hasMergeEvidence: false }],
    }),
  });
  assert.deepEqual(classesOf(result), ['completion-without-evidence']);
  assert.equal(result.outcome, 'owner-attention');
  assert.deepEqual(result.successors, []);
});

test('two open pull requests for one issue violate the same-pull-request rule', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      ownership: {
        activeLeases: [],
        openPullRequests: [
          { number: 42, issueNumber: READY_ISSUE_NUMBER, headSha: HEAD_SHA },
          { number: 43, issueNumber: READY_ISSUE_NUMBER, headSha: HEAD_SHA },
        ],
      },
    }),
  });
  assert.ok(classesOf(result).includes('same-pull-request-violation'));
});

test('an open pull request other than the authority-bound one is an unexpected replacement', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      authorities: [{ authorityKey: 'mwa:key-a', issueNumber: READY_ISSUE_NUMBER, baseSha: SOURCE_SHA, state: 'issued', pullRequestNumber: 42 }],
      ownership: { activeLeases: [], openPullRequests: [{ number: 99, issueNumber: READY_ISSUE_NUMBER, headSha: HEAD_SHA }] },
      capacity: { implementationSlotOccupied: false, readyWorkAvailable: false },
    }),
  });
  assert.ok(classesOf(result).includes('unexpected-replacement-pull-request'));
});

test('source drift is a blocking, systemic finding', () => {
  const result = runAssurance({
    observation: assuranceObservation({ expectedSourceSha: 'c'.repeat(40) }),
  });
  assert.deepEqual(classesOf(result), ['source-drift']);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.settlementState, 'blocked');
  assert.deepEqual(result.successors, []);
});

test('a repository that is not the registered one is a blocking identity mismatch', () => {
  const result = runAssurance({
    observation: assuranceObservation({ registeredRepository: 'FixtureOrg/other-repo' }),
  });
  assert.ok(classesOf(result).includes('project-identity-mismatch'));
  assert.equal(result.outcome, 'blocked');
});

test('a scheduler on a host other than the controller is blocking drift', () => {
  const result = runAssurance({
    observation: assuranceObservation({ controllerHost: 'dell', schedulerHost: 'z790' }),
  });
  assert.ok(classesOf(result).includes('scheduler-authority-drift'));
  assert.equal(result.outcome, 'blocked');
});

test('more than one implementation lease, or a slot state that disagrees with the leases, is blocking', () => {
  const twoLeases = runAssurance({
    observation: assuranceObservation({
      ownership: {
        activeLeases: [
          { issueNumber: 501, kind: 'implementation', holder: 'worker-1' },
          { issueNumber: 502, kind: 'implementation', holder: 'worker-2' },
        ],
        openPullRequests: [],
      },
      capacity: { implementationSlotOccupied: true, readyWorkAvailable: false },
    }),
  });
  assert.ok(classesOf(twoLeases).includes('implementation-slot-contradiction'));

  const contradiction = runAssurance({
    observation: assuranceObservation({ capacity: { implementationSlotOccupied: true, readyWorkAvailable: false } }),
  });
  assert.ok(classesOf(contradiction).includes('implementation-slot-contradiction'));
});

test('an observed security-boundary breach is blocking', () => {
  const result = runAssurance({
    observation: assuranceObservation({ security: { boundaryViolations: ['worker-read-outside-workspace'] } }),
  });
  assert.deepEqual(classesOf(result), ['security-boundary-breach']);
  assert.equal(result.outcome, 'blocked');
});

test('credit, balance or dollar-cap admission observed anywhere is a blocking policy violation', () => {
  const credit = runAssurance({
    observation: assuranceObservation({ quotaPolicy: { admissionSignals: ['quota'], forbiddenSignalsObserved: ['account-credit'] } }),
  });
  assert.deepEqual(classesOf(credit), ['credit-admission-observed']);
  assert.equal(credit.outcome, 'blocked');

  const nonQuota = runAssurance({
    observation: assuranceObservation({ quotaPolicy: { admissionSignals: ['quota', 'dollar-cap'], forbiddenSignalsObserved: [] } }),
  });
  assert.deepEqual(classesOf(nonQuota), ['quota-policy-violation']);
  assert.equal(nonQuota.outcome, 'blocked');
});

test('the worst severity present decides the bounded outcome', () => {
  const result = runAssurance({
    observation: assuranceObservation({
      capacity: { implementationSlotOccupied: false, readyWorkAvailable: true },
      completions: [{ issueNumber: 501, claimedComplete: true, hasMergeEvidence: false }],
      expectedSourceSha: 'c'.repeat(40),
    }),
  });
  assert.equal(result.outcome, 'blocked');
  // A blocking outcome never asks programme reconciliation to correct it.
  assert.deepEqual(result.successors, []);
});

test('identical evidence always yields an identical, deterministically ordered result', () => {
  const observation = assuranceObservation({
    capacity: { implementationSlotOccupied: false, readyWorkAvailable: true },
    authorities: [{ authorityKey: 'mwa:key-a', issueNumber: 501, baseSha: 'c'.repeat(40), state: 'issued' }],
  });
  const first = runAssurance({ observation });
  const second = runAssurance({ observation });
  assert.deepEqual(classesOf(first), classesOf(second));
  assert.deepEqual(classesOf(first), ['idle-safe-capacity', 'stale-authority']);
});

test('every finding class carries a declared severity', () => {
  for (const [findingClass, severity] of Object.entries(ASSURANCE_FINDING_SEVERITY)) {
    assert.ok(['correctable', 'owner-attention', 'blocking'].includes(severity), findingClass);
  }
});

test('the role fails closed on a project or repository the event was not raised for', () => {
  assert.throws(() => runAssurance({ event: { ...EVENT, projectId: 'second-project' } }), /but the event is for 'second-project'/);
  assert.throws(() => runAssurance({ event: { ...EVENT, repository: 'FixtureOrg/second-repo' } }), /but the event is for 'FixtureOrg\/second-repo'/);
});

test('an unsupported observation field is refused', () => {
  assert.throws(
    () => runAssurance({ observation: { ...assuranceObservation(), rawWebhookPayload: {} } }),
    /unsupported field\(s\): rawWebhookPayload/,
  );
});

test('assurance reports no suppressed mutation because it never had one to suppress', () => {
  for (const mode of ['shadow', 'active']) {
    assert.equal(runAssurance({ mode }).mutationSuppressed, false, mode);
  }
});

test('a capability set carrying a mutating port can never reach the assurance handler', () => {
  // The generic factory already denies assurance a mutating capability, so the
  // only way to reach the handler's own guard is to hand it another role's set.
  const programme = resolveRoleCapabilities({
    role: 'programme',
    mode: 'active',
    ports: { collectEvidence: () => assuranceObservation(), applyQueueMutation: () => ({}), publishWorkerAuthority: () => {} },
  });
  assert.throws(
    () => runQueueAssurance({ event: EVENT, capabilities: programme, now: T0 }),
    /role capability mismatch: expected 'assurance'/,
  );
});
