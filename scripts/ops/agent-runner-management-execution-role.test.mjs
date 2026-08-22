import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRoleCapabilities } from './agent-runner-management-control-mode.mjs';
import { runExecutionReconciliation } from './agent-runner-management-execution-role.mjs';
import { settleManagerLifecycle } from './agent-runner-manager-lifecycle-settlement.mjs';
import {
  HEAD_SHA,
  NEXT_HEAD_SHA,
  PROJECT_ID,
  PULL_REQUEST_NUMBER,
  READY_ISSUE_NUMBER,
  REPOSITORY,
  T0,
  buildAuthority,
  buildSettlementEvidence,
  ciInput,
  executionEvidence,
  portFactory,
  publicationInput,
  pullRequestInput,
  reviewInput,
} from './agent-runner-management-test-fixtures.mjs';

const EVENT = Object.freeze({
  eventId: 'management-execution-1',
  eventType: 'execution-reconcile-required',
  projectId: PROJECT_ID,
  repository: REPOSITORY,
  issueNumber: READY_ISSUE_NUMBER,
  correlationId: 'correlation-1',
  causalDepth: 1,
});

function runExecution({ mode = 'active', evidence = executionEvidence(), event = EVENT, calls } = {}) {
  const recorded = calls ?? { queueMutation: [], workerAuthority: [], continuation: [], appliedOperations: [] };
  const { resolvePorts } = portFactory({ execution: evidence, calls: recorded });
  const ports = resolvePorts({ role: 'execution' });
  const collected = ports.collectEvidence();
  const capabilities = resolveRoleCapabilities({
    role: 'execution', mode, ports: { ...ports, collectEvidence: () => collected },
  });
  return { result: runExecutionReconciliation({ event, capabilities, now: T0 }), calls: recorded };
}

/** Build settlement evidence for one authority with bounded overrides. */
function evidenceFor(overrides = {}, authority = buildAuthority()) {
  return executionEvidence({ authority, settlementEvidence: buildSettlementEvidence(authority, overrides) });
}

test('a green exact-head attempt settles to independent assurance', () => {
  const { result } = runExecution();
  assert.equal(result.outcome, 'assurance-required');
  assert.equal(result.reason, 'exact-head-evidence-terminal-green');
  assert.deepEqual(result.successors.map((entry) => entry.eventType), ['queue-assurance-required']);
  assert.equal(result.identity.issueNumber, READY_ISSUE_NUMBER);
  assert.equal(result.identity.pullRequestNumber, PULL_REQUEST_NUMBER);
  assert.equal(result.identity.sha, HEAD_SHA);
});

test('an incomplete attempt authorises a bounded same-pull-request continuation', () => {
  const { result, calls } = runExecution({
    evidence: evidenceFor({ publication: publicationInput({ completionState: 'incomplete' }) }),
  });
  assert.equal(result.outcome, 'continue-execution');
  assert.equal(result.reason, 'continuation-authorised');
  assert.equal(calls.continuation.length, 1);
  assert.deepEqual(result.successors.map((entry) => entry.eventType), ['execution-reconcile-required']);
});

test('shadow mode computes the continuation decision but publishes nothing', () => {
  const { result, calls } = runExecution({
    mode: 'shadow',
    evidence: evidenceFor({ publication: publicationInput({ completionState: 'incomplete' }) }),
  });
  assert.equal(result.outcome, 'continue-execution');
  assert.equal(result.reason, 'continuation-suppressed');
  assert.equal(calls.continuation.length, 0);
  assert.equal(result.mutationSuppressed, true);
});

test('a failed required check at the exact head continues on the same pull request', () => {
  const { result, calls } = runExecution({
    evidence: evidenceFor({ ci: ciInput({ checks: [{ name: 'validate', state: 'failure', required: true }] }) }),
  });
  assert.equal(result.outcome, 'continue-execution');
  assert.equal(calls.continuation.length, 1);
});

test('a pending required check schedules a bounded delayed retry rather than busy-waiting', () => {
  const { result } = runExecution({
    evidence: evidenceFor({ ci: ciInput({ checks: [{ name: 'validate', state: 'pending', required: true }] }) }),
  });
  assert.equal(result.outcome, 'delayed-retry');
  const [successor] = result.successors;
  assert.equal(successor.eventType, 'execution-reconcile-required');
  assert.ok(Date.parse(successor.notBefore) > Date.parse(T0));
});

test('an actionable review defect continues on the same pull request', () => {
  const { result, calls } = runExecution({
    evidence: evidenceFor({
      review: reviewInput({
        state: 'changes-requested',
        findings: [{ id: 'finding-1', severity: 'blocking', category: 'correctness', summary: 'Bounded defect to correct.', actionable: true }],
      }),
    }),
  });
  assert.equal(result.outcome, 'continue-execution');
  assert.equal(calls.continuation.length, 1);
});

test('a non-actionable blocking finding escalates to owner attention and frees the slot', () => {
  const { result, calls } = runExecution({
    evidence: evidenceFor({
      review: reviewInput({
        state: 'changes-requested',
        findings: [{ id: 'finding-1', severity: 'blocking', category: 'product', summary: 'A product decision is required.', actionable: false }],
      }),
    }),
  });
  assert.equal(result.outcome, 'owner-attention');
  assert.equal(calls.continuation.length, 0);
  assert.deepEqual(result.successors.map((entry) => entry.eventType), ['programme-reconcile-required']);
});

test('a pull request that is no longer open frees the slot and wakes programme reconciliation promptly', () => {
  for (const state of ['merged', 'closed']) {
    const { result } = runExecution({
      evidence: evidenceFor({ pullRequest: pullRequestInput({ state }) }),
    });
    assert.equal(result.outcome, 'programme-reconcile', state);
    // No delay: the slot is free now, so the next dependency-correct work must
    // be chosen without waiting for any timer.
    assert.equal(result.successors[0].eventType, 'programme-reconcile-required');
    assert.equal(result.successors[0].notBefore, null);
  }
});

test('a failed publication blocks and still wakes programme reconciliation', () => {
  const { result } = runExecution({
    evidence: evidenceFor({ publication: publicationInput({ completionState: 'failed' }) }),
  });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.settlementState, 'blocked');
  assert.deepEqual(result.successors.map((entry) => entry.eventType), ['programme-reconcile-required']);
});

test('an abandoned attempt escalates to owner attention', () => {
  const { result } = runExecution({
    evidence: evidenceFor({ publication: publicationInput({ completionState: 'abandoned' }) }),
  });
  assert.equal(result.outcome, 'owner-attention');
});

test('replayed identical evidence settles as an explicit no-op with no successor', () => {
  const authority = buildAuthority();
  const settlementEvidence = buildSettlementEvidence(authority);
  const previousSettlement = settleManagerLifecycle({ evidence: settlementEvidence, previousSettlement: null });
  const { result, calls } = runExecution({
    evidence: executionEvidence({ authority, settlementEvidence, previousSettlement }),
  });
  assert.equal(result.outcome, 'no-op');
  assert.equal(result.reason, 'replayed-settled-evidence');
  assert.equal(result.successors.length, 0);
  assert.equal(calls.continuation.length, 0);
});

test('check evidence read at a stale head is refused before any lifecycle decision', () => {
  const authority = buildAuthority();
  assert.throws(
    () => buildSettlementEvidence(authority, { ci: ciInput({ headSha: NEXT_HEAD_SHA }) }),
    /Invalid agent runner manager settlement evidence/,
  );
});

test('the role fails closed when the event names a different project, repository or issue', () => {
  assert.throws(() => runExecution({ event: { ...EVENT, projectId: 'second-project' } }), /but the event is for 'second-project'/);
  assert.throws(() => runExecution({ event: { ...EVENT, repository: 'FixtureOrg/second-repo' } }), /but the event is for 'FixtureOrg\/second-repo'/);
  assert.throws(() => runExecution({ event: { ...EVENT, issueNumber: 999 } }), /but the event is for issue #999/);
});

test('a replacement pull request can never be adopted in place of the authorised one', () => {
  assert.throws(
    () => runExecution({
      evidence: executionEvidence({
        settlementEvidence: buildSettlementEvidence(buildAuthority(), { publication: publicationInput({ completionState: 'incomplete' }) }),
        ownership: {
          activeLeases: [],
          openPullRequests: [{ number: 4242, issueNumber: READY_ISSUE_NUMBER, headSha: HEAD_SHA }],
          workspace: null,
        },
      }),
    }),
    /pull-request ownership is ambiguous/,
  );
});

test('a continuation is refused when another issue holds the global implementation lease', () => {
  assert.throws(
    () => runExecution({
      evidence: executionEvidence({
        settlementEvidence: buildSettlementEvidence(buildAuthority(), { publication: publicationInput({ completionState: 'incomplete' }) }),
        ownership: {
          activeLeases: [{ issueNumber: 777, kind: 'implementation', holder: 'worker-2' }],
          openPullRequests: [],
          workspace: null,
        },
      }),
    }),
    /one-global-implementation-slot invariant refuses this continuation/,
  );
});

test('collected evidence must carry provenance from the accepted validators', () => {
  // Real settlement evidence paired with a hand-built authority look-alike: the
  // role's own provenance check must refuse it.
  const authority = buildAuthority();
  assert.throws(
    () => runExecution({
      evidence: {
        ...executionEvidence({ authority }),
        authority: Object.freeze({
          projectId: PROJECT_ID,
          repository: { owner: 'FixtureOrg', name: 'fixture-repo', full: REPOSITORY },
          issueNumber: READY_ISSUE_NUMBER,
        }),
      },
    }),
    /was not produced by issueManagerWorkerAuthority/,
  );
  assert.throws(
    () => runExecution({
      evidence: { ...executionEvidence({ authority }), settlementEvidence: Object.freeze({ authorityKey: 'forged' }) },
    }),
    /was not produced by validateManagerSettlementEvidence/,
  );
  assert.throws(
    () => runExecution({ evidence: { ...executionEvidence(), unexpectedField: true } }),
    /unsupported field\(s\): unexpectedField/,
  );
});

test('the execution role can never curate a queue or mint a fresh worker authority', () => {
  const { resolvePorts } = portFactory();
  const capabilities = resolveRoleCapabilities({ role: 'execution', mode: 'active', ports: resolvePorts({ role: 'execution' }) });
  for (const name of ['applyQueueMutation', 'publishWorkerAuthority', 'merge', 'closeIssue', 'activateSource']) {
    assert.equal(name in capabilities.ports, false, name);
  }
});

test('the projection advances lifecycle state without inventing programme facts', () => {
  const projectionContext = {
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    objective: 'Keep the fixture project queue curated deterministically.',
    planRevision: 'qcr:abcdef0123456789abcdef0123456789',
    milestones: [{ id: 'foundation', title: 'Foundation', total: 2, completed: 1, blocked: 0 }],
    counts: { ready: 1, inProgress: 1, blocked: 1, review: 1, completed: 0 },
    criticalPath: [],
    currentEvent: null,
    lifecycleState: 'awaiting-execution',
    recentDecisions: [],
    risks: [],
    blockers: [],
    nextAction: { classification: 'execution-reconcile', eventType: 'execution-reconcile-required', notBefore: null },
    ownerAttentionRequired: false,
    controlMode: 'active',
  };
  const { result } = runExecution({ evidence: executionEvidence({ projectionContext }) });
  assert.equal(result.projection.lifecycleState, 'awaiting-review');
  // Programme-owned counts are carried through verbatim.
  assert.deepEqual(result.projection.counts, projectionContext.counts);
  assert.equal(result.projection.nextAction.classification, 'queue-assurance');
});
