import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTINUATION_KINDS,
  LIFECYCLE_CLASSES,
  MANAGER_CONTINUATION_AUTHORITY_SCHEMA_VERSION,
  MANAGER_LIFECYCLE_SETTLEMENT_SCHEMA_VERSION,
  SETTLEMENT_SUCCESSOR_HINTS,
  assertNormalizedContinuationAuthorityShape,
  assertNormalizedLifecycleSettlementShape,
  authorizeManagerContinuation,
  serializeManagerLifecycleSettlement,
  settleManagerLifecycle,
} from './agent-runner-manager-lifecycle-settlement.mjs';
import { AUTHORITY_CONSUMER_DOMAIN } from './agent-runner-manager-worker-authority.mjs';
import {
  ATTEMPT_ID,
  HEAD_SHA,
  IMPLEMENTATION_BRANCH,
  NEXT_HEAD_SHA,
  OTHER_ISSUE_NUMBER,
  PULL_REQUEST_NUMBER,
  READY_ISSUE_NUMBER,
  SOURCE_SHA,
  buildAuthority,
  buildEvidence,
  ciInput,
  producer,
  publicationInput,
  pullRequestInput,
  reviewInput,
} from './agent-runner-manager-authority-review-test-fixtures.mjs';

const authority = buildAuthority();

function settle(evidenceOverrides = {}, previousSettlement = null) {
  return settleManagerLifecycle({
    evidence: buildEvidence(authority, evidenceOverrides),
    previousSettlement,
  });
}

function blockingFinding(overrides = {}) {
  return {
    id: 'finding-1',
    severity: 'blocking',
    category: 'correctness',
    summary: 'The exact-head behaviour is not covered by a test.',
    actionable: true,
    ...overrides,
  };
}

const failingCi = ciInput({ checks: [{ name: 'validate', state: 'failure', required: true, failureClass: 'test-failure' }] });

test('a terminal green exact-head snapshot settles to independent assurance', () => {
  const settlement = settle();
  assert.equal(settlement.schemaVersion, MANAGER_LIFECYCLE_SETTLEMENT_SCHEMA_VERSION);
  assert.equal(settlement.lifecycleClass, 'assurance-required');
  assert.equal(settlement.reason, 'exact-head-evidence-terminal-green');
  assert.equal(settlement.successorHint, 'queue-assurance-required');
  assert.equal(settlement.continuation, null);
  assert.ok(Object.isFrozen(settlement));
});

test('a settlement preserves the exact project, repository, issue, authority, attempt, branch, base, pull request and head', () => {
  const settlement = settle();
  assert.equal(settlement.projectId, authority.projectId);
  assert.equal(settlement.repository.full, authority.repository.full);
  assert.equal(settlement.issueNumber, READY_ISSUE_NUMBER);
  assert.equal(settlement.authorityKey, authority.authorityKey);
  assert.equal(settlement.authorityFingerprint, authority.authorityFingerprint);
  assert.equal(settlement.attemptId, ATTEMPT_ID);
  assert.equal(settlement.branch, IMPLEMENTATION_BRANCH);
  assert.equal(settlement.baseSha, SOURCE_SHA);
  assert.equal(settlement.pullRequestNumber, PULL_REQUEST_NUMBER);
  assert.equal(settlement.headSha, HEAD_SHA);
  assert.equal(settlement.evidenceSequence, 1);
  assert.match(settlement.evidenceFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(settlement.settlementFingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('a failing required check at the exact head continues execution on the same pull request', () => {
  const settlement = settle({ ci: failingCi });
  assert.equal(settlement.lifecycleClass, 'continue-execution');
  assert.equal(settlement.reason, 'required-check-failed-at-exact-head');
  assert.equal(settlement.successorHint, 'execution-reconcile-required');
  assert.equal(settlement.continuation.kind, 'same-pull-request');
  assert.equal(settlement.continuation.pullRequestNumber, PULL_REQUEST_NUMBER);
  assert.equal(settlement.continuation.headSha, HEAD_SHA);
  assert.deepEqual(
    settlement.continuation.defects.map((defect) => [defect.source, defect.id, defect.classification]),
    [['ci', 'validate', 'test-failure']],
  );
});

test('a failing check that is not required never continues execution on its own', () => {
  const settlement = settle();
  assert.equal(settlement.lifecycleClass, 'assurance-required');
});

test('an actionable blocking review finding continues execution on the same pull request', () => {
  const settlement = settle({
    review: reviewInput({ state: 'changes-requested', findings: [blockingFinding()] }),
  });
  assert.equal(settlement.lifecycleClass, 'continue-execution');
  assert.equal(settlement.reason, 'actionable-review-defect');
  assert.deepEqual(
    settlement.continuation.defects.map((defect) => [defect.source, defect.id]),
    [['review', 'finding-1']],
  );
});

test('a review reporting no blockers never continues execution', () => {
  const settlement = settle({
    review: reviewInput({
      state: 'no-blockers',
      findings: [blockingFinding({ severity: 'advisory', actionable: true })],
    }),
  });
  assert.equal(settlement.lifecycleClass, 'assurance-required');
  assert.equal(settlement.reason, 'exact-head-evidence-terminal-green');
});

test('a blocking finding the implementation cannot decide escalates to an owner', () => {
  const settlement = settle({
    review: reviewInput({
      state: 'changes-requested',
      findings: [blockingFinding({ actionable: false, category: 'product-decision' })],
    }),
  });
  assert.equal(settlement.lifecycleClass, 'owner-attention');
  assert.equal(settlement.reason, 'non-actionable-blocking-finding');
  assert.equal(settlement.continuation, null);
  assert.equal(settlement.successorHint, 'programme-reconcile-required');
});

test('an abandoned attempt escalates to an owner', () => {
  const settlement = settle({ publication: publicationInput({ completionState: 'abandoned' }) });
  assert.equal(settlement.lifecycleClass, 'owner-attention');
  assert.equal(settlement.reason, 'worker-attempt-abandoned');
});

test('a pull request that is no longer open is a programme fact, not an implementation defect', () => {
  for (const state of ['merged', 'closed']) {
    const settlement = settle({ pullRequest: pullRequestInput({ state }), ci: failingCi });
    assert.equal(settlement.lifecycleClass, 'programme-reconcile');
    assert.equal(settlement.reason, 'authorised-pull-request-no-longer-open');
    assert.equal(settlement.successorHint, 'programme-reconcile-required');
  }
});

test('a failed publication is a blocked deterministic prerequisite', () => {
  const settlement = settle({ publication: publicationInput({ completionState: 'failed' }) });
  assert.equal(settlement.lifecycleClass, 'blocked');
  assert.equal(settlement.reason, 'worker-publication-failed');
});

test('a publication claiming completion with no pull request evidence is blocked', () => {
  const settlement = settle({
    publication: publicationInput({ pullRequestNumber: null }),
    pullRequest: null,
    ci: null,
    review: null,
  });
  assert.equal(settlement.lifecycleClass, 'blocked');
  assert.equal(settlement.reason, 'no-authorised-pull-request-evidence');
});

test('an incomplete attempt with no pull request is a delayed retry', () => {
  const settlement = settle({
    publication: publicationInput({ completionState: 'incomplete', pullRequestNumber: null }),
    pullRequest: null,
    ci: null,
    review: null,
  });
  assert.equal(settlement.lifecycleClass, 'delayed-retry');
  assert.equal(settlement.reason, 'attempt-incomplete-without-pull-request');
  assert.equal(settlement.successorHint, 'delayed-retry');
});

test('an incomplete attempt on the authorised pull request continues execution', () => {
  const settlement = settle({ publication: publicationInput({ completionState: 'incomplete' }) });
  assert.equal(settlement.lifecycleClass, 'continue-execution');
  assert.equal(settlement.reason, 'attempt-incomplete-on-authorised-pull-request');
  assert.deepEqual(
    settlement.continuation.defects.map((defect) => defect.classification),
    ['attempt-incomplete'],
  );
});

test('missing, pending or unreported exact-head checks are delayed retries, never green', () => {
  const missing = settle({ ci: null });
  assert.equal(missing.lifecycleClass, 'delayed-retry');
  assert.equal(missing.reason, 'exact-head-check-evidence-missing');

  const pending = settle({ ci: ciInput({ checks: [{ name: 'validate', state: 'pending', required: true }] }) });
  assert.equal(pending.lifecycleClass, 'delayed-retry');
  assert.equal(pending.reason, 'required-check-pending-at-exact-head');

  const unreported = settle({ ci: ciInput({ checks: [{ name: 'advisory-lint', state: 'success', required: false }] }) });
  assert.equal(unreported.lifecycleClass, 'delayed-retry');
  assert.equal(unreported.reason, 'no-required-check-reported-at-exact-head');
});

test('an ambiguous required check is never read as green', () => {
  for (const state of ['cancelled', 'neutral']) {
    const settlement = settle({ ci: ciInput({ checks: [{ name: 'validate', state, required: true }] }) });
    assert.equal(settlement.lifecycleClass, 'assurance-required');
    assert.equal(settlement.reason, 'ambiguous-required-check-state');
    assert.equal(settlement.continuation, null);
  }
});

test('green checks with no completed review still require independent assurance', () => {
  const missingReview = settle({ review: null });
  assert.equal(missingReview.lifecycleClass, 'assurance-required');
  assert.equal(missingReview.reason, 'independent-assurance-outstanding');

  const pendingReview = settle({ review: reviewInput({ state: 'pending' }) });
  assert.equal(pendingReview.lifecycleClass, 'assurance-required');
  assert.equal(pendingReview.reason, 'independent-assurance-outstanding');
});

test('a snapshot with no worker publication is a no-op', () => {
  const settlement = settle({ publication: null, pullRequest: null, ci: null, review: null });
  assert.equal(settlement.lifecycleClass, 'no-op');
  assert.equal(settlement.reason, 'no-worker-publication');
  assert.equal(settlement.successorHint, 'none');
  assert.equal(settlement.headSha, null);
  assert.equal(settlement.pullRequestNumber, null);
});

test('precedence between simultaneously true conditions is fixed and deterministic', () => {
  // A closed pull request outranks a failing check, an abandoned attempt and a
  // blocking finding: the programme fact is settled first.
  const closed = settle({
    pullRequest: pullRequestInput({ state: 'closed' }),
    publication: publicationInput({ completionState: 'abandoned' }),
    ci: failingCi,
    review: reviewInput({ state: 'changes-requested', findings: [blockingFinding({ actionable: false })] }),
  });
  assert.equal(closed.lifecycleClass, 'programme-reconcile');

  // An owner decision outranks a correctable implementation defect.
  const ownerFirst = settle({
    ci: failingCi,
    review: reviewInput({
      state: 'changes-requested',
      findings: [blockingFinding(), blockingFinding({ id: 'finding-2', actionable: false })],
    }),
  });
  assert.equal(ownerFirst.lifecycleClass, 'owner-attention');

  // A failing required check outranks an outstanding review.
  const checkFirst = settle({ ci: failingCi, review: reviewInput({ state: 'pending' }) });
  assert.equal(checkFirst.lifecycleClass, 'continue-execution');
  assert.equal(checkFirst.reason, 'required-check-failed-at-exact-head');
});

test('settling identical evidence twice yields an identical settlement', () => {
  const first = settle({ ci: failingCi });
  const second = settle({ ci: failingCi });
  assert.equal(first.settlementFingerprint, second.settlementFingerprint);
  assert.equal(serializeManagerLifecycleSettlement(first), serializeManagerLifecycleSettlement(second));
});

test('replaying already-settled evidence is an idempotent no-change settlement', () => {
  const first = settle({ ci: failingCi });
  const replay = settle({ ci: failingCi }, first);
  assert.equal(replay.lifecycleClass, 'no-op');
  assert.equal(replay.reason, 'replayed-settled-evidence');
  assert.equal(replay.continuation, null);
  assert.equal(replay.evidenceFingerprint, first.evidenceFingerprint);
});

test('conflicting or out-of-order replay fails closed', () => {
  const settled = settle({ evidenceSequence: 5 });
  assert.throws(
    () => settle({ evidenceSequence: 4 }, settled),
    /precedes the already-settled sequence 5/,
  );
  assert.throws(
    () => settle({ evidenceSequence: 5, ci: failingCi }, settled),
    /was already settled with different evidence/,
  );
  const advanced = settle({ evidenceSequence: 6, ci: failingCi }, settled);
  assert.equal(advanced.lifecycleClass, 'continue-execution');
});

test('a previous settlement for another authority or attempt fails closed', () => {
  const otherAuthority = buildAuthority({ request: { curationKey: 'qc:fixture-project:evidence-contract', branch: 'agent/other-implementation-501', scope: ['Implement the bounded evidence contract and its focused tests.'], stopConditions: ['Stop and report if the accepted base commit changes.'] } });
  const otherSettlement = settleManagerLifecycle({ evidence: buildEvidence(otherAuthority, { branch: otherAuthority.branch, pullRequest: pullRequestInput({ branch: otherAuthority.branch }) }) });
  assert.throws(
    () => settle({}, otherSettlement),
    /belongs to a different worker authority/,
  );

  const otherAttempt = settleManagerLifecycle({ evidence: buildEvidence(authority, { attemptId: 'attempt-501-2', publication: publicationInput({ attemptId: 'attempt-501-2' }) }) });
  assert.throws(() => settle({}, otherAttempt), /belongs to a different attempt/);
});

test('settlement refuses evidence and previous settlements that were never validated', () => {
  assert.throws(
    () => settleManagerLifecycle({ evidence: Object.freeze({ publication: null }) }),
    /was not produced by validateManagerSettlementEvidence/,
  );
  assert.throws(
    () => settleManagerLifecycle({ evidence: buildEvidence(authority), previousSettlement: Object.freeze({ evidenceFingerprint: 'x' }) }),
    /was not produced by settleManagerLifecycle/,
  );
  assert.throws(() => settleManagerLifecycle({ evidence: buildEvidence(authority), extra: 1 }), /input\.extra is not a recognised field/);
  assert.throws(() => settleManagerLifecycle('nope'), /input must be an object/);
});

test('a look-alike settlement is never accepted as validated', () => {
  const settlement = settle();
  const lookAlike = Object.freeze(JSON.parse(JSON.stringify(settlement)));
  assert.throws(() => assertNormalizedLifecycleSettlementShape(lookAlike), /was not produced by settleManagerLifecycle/);
});

test('every lifecycle class and successor hint stays inside the published contract', () => {
  const settlements = [
    settle(),
    settle({ ci: failingCi }),
    settle({ pullRequest: pullRequestInput({ state: 'merged' }) }),
    settle({ publication: publicationInput({ completionState: 'failed' }) }),
    settle({ publication: publicationInput({ completionState: 'abandoned' }) }),
    settle({ ci: ciInput({ checks: [{ name: 'validate', state: 'pending', required: true }] }) }),
    settle({ publication: null, pullRequest: null, ci: null, review: null }),
  ];
  const observed = new Set(settlements.map((settlement) => settlement.lifecycleClass));
  assert.deepEqual([...observed].sort(), [
    'assurance-required', 'blocked', 'continue-execution', 'delayed-retry', 'no-op', 'owner-attention', 'programme-reconcile',
  ]);
  for (const settlement of settlements) {
    assert.ok(LIFECYCLE_CLASSES.includes(settlement.lifecycleClass));
    assert.ok(SETTLEMENT_SUCCESSOR_HINTS.includes(settlement.successorHint));
  }
});

test('a continuation is a separately authorised manager transition on the same pull request', () => {
  const settlement = settle({ ci: failingCi });
  const continuation = authorizeManagerContinuation({
    authority,
    settlement,
    producer: producer(),
    request: { pullRequestNumber: PULL_REQUEST_NUMBER, branch: IMPLEMENTATION_BRANCH, headSha: HEAD_SHA },
  });

  assert.equal(continuation.schemaVersion, MANAGER_CONTINUATION_AUTHORITY_SCHEMA_VERSION);
  assert.equal(continuation.kind, 'same-pull-request');
  assert.ok(CONTINUATION_KINDS.includes(continuation.kind));
  assert.equal(continuation.repository.full, authority.repository.full);
  assert.equal(continuation.issueNumber, READY_ISSUE_NUMBER);
  assert.equal(continuation.pullRequestNumber, PULL_REQUEST_NUMBER);
  assert.equal(continuation.branch, IMPLEMENTATION_BRANCH);
  assert.equal(continuation.baseSha, SOURCE_SHA);
  assert.equal(continuation.headSha, HEAD_SHA);
  assert.equal(continuation.parentAuthorityKey, authority.authorityKey);
  assert.equal(continuation.adapter, authority.adapter);
  assert.equal(continuation.model, authority.model);
  assert.equal(continuation.effort, authority.effort);
  assert.deepEqual([...continuation.validation.requiredChecks], [...authority.validation.requiredChecks]);
  assert.match(continuation.continuationRevision, /^mwc:[a-f0-9]{32}$/);
  assert.match(continuation.continuationAuthorityKey, /^manager-preflight:mwc:/);
  assert.ok(Object.isFrozen(continuation));
});

test('an identical continuation is deterministic and replay-stable', () => {
  const settlement = settle({ ci: failingCi });
  const first = authorizeManagerContinuation({ authority, settlement, producer: producer() });
  const second = authorizeManagerContinuation({ authority, settlement, producer: producer() });
  assert.equal(first.continuationFingerprint, second.continuationFingerprint);
  assert.equal(first.continuationAuthorityKey, second.continuationAuthorityKey);
});

test('a continuation can never become a replacement pull request, branch or head', () => {
  const settlement = settle({ ci: failingCi });
  const attempt = (request, expected) => assert.throws(
    () => authorizeManagerContinuation({ authority, settlement, producer: producer(), request }),
    expected,
  );
  attempt({ pullRequestNumber: 99 }, /would replace the authorised pull request/);
  attempt({ branch: 'agent/replacement-branch' }, /would replace the authorised branch/);
  attempt({ headSha: NEXT_HEAD_SHA }, /is not the exact current pull-request head/);
  attempt({ unexpected: true }, /request\.unexpected is not a recognised field/);
});

test('a worker can never mint its own continuation authority', () => {
  const settlement = settle({ ci: failingCi });
  assert.throws(
    () => authorizeManagerContinuation({ authority, settlement, producer: producer({ domain: AUTHORITY_CONSUMER_DOMAIN }) }),
    /a worker may never mint its own continuation authority/,
  );
  assert.throws(
    () => authorizeManagerContinuation({ authority, settlement, producer: producer({ type: 'chatgpt_scheduled_task' }) }),
    /producer\.type must be/,
  );
});

test('only a continue-execution settlement authorises a continuation', () => {
  for (const overrides of [{}, { publication: publicationInput({ completionState: 'failed' }) }, { pullRequest: pullRequestInput({ state: 'merged' }) }]) {
    const settlement = settle(overrides);
    assert.throws(
      () => authorizeManagerContinuation({ authority, settlement, producer: producer() }),
      /does not authorise a continuation/,
    );
  }
});

test('a continuation fails closed on recovery, implementation-slot or pull-request ownership conflict', () => {
  const settlement = settle({ ci: failingCi });
  const attempt = (ownership, expected) => assert.throws(
    () => authorizeManagerContinuation({ authority, settlement, producer: producer(), ownership }),
    expected,
  );
  attempt(
    { activeLeases: [{ issueNumber: READY_ISSUE_NUMBER, kind: 'recovery', holder: 'recovery-a' }] },
    /can never take recovery-owned work/,
  );
  attempt(
    { activeLeases: [{ issueNumber: OTHER_ISSUE_NUMBER, kind: 'implementation', holder: 'worker-a' }] },
    /one-global-implementation-slot invariant refuses this continuation/,
  );
  attempt(
    { openPullRequests: [{ number: 99, issueNumber: READY_ISSUE_NUMBER, headSha: HEAD_SHA }] },
    /pull-request ownership is ambiguous/,
  );
  attempt(
    { openPullRequests: [{ number: PULL_REQUEST_NUMBER, issueNumber: READY_ISSUE_NUMBER, headSha: NEXT_HEAD_SHA }] },
    /not the settled head/,
  );
  attempt(
    { workspace: { branch: 'agent/other-branch', ownerAttemptId: ATTEMPT_ID } },
    /the owning workspace is bound to branch/,
  );
  attempt(
    { workspace: { branch: IMPLEMENTATION_BRANCH, ownerAttemptId: 'attempt-501-2' } },
    /the owning workspace belongs to attempt/,
  );
  attempt({ unexpected: true }, /ownership\.unexpected is not a recognised field/);
});

test('the attempt that owns the authorised workspace and pull request may continue', () => {
  const settlement = settle({ ci: failingCi });
  const continuation = authorizeManagerContinuation({
    authority,
    settlement,
    producer: producer(),
    ownership: {
      activeLeases: [{ issueNumber: READY_ISSUE_NUMBER, kind: 'implementation', holder: 'worker-fixture' }],
      openPullRequests: [{ number: PULL_REQUEST_NUMBER, issueNumber: READY_ISSUE_NUMBER, headSha: HEAD_SHA }],
      workspace: { branch: IMPLEMENTATION_BRANCH, ownerAttemptId: ATTEMPT_ID },
    },
  });
  assert.equal(continuation.pullRequestNumber, PULL_REQUEST_NUMBER);
  assert.equal(continuation.headSha, HEAD_SHA);
});

test('a continuation refuses unvalidated authority, settlement or input shapes', () => {
  const settlement = settle({ ci: failingCi });
  assert.throws(
    () => authorizeManagerContinuation({ authority: Object.freeze({ ...authority }), settlement, producer: producer() }),
    /was not produced by issueManagerWorkerAuthority/,
  );
  assert.throws(
    () => authorizeManagerContinuation({ authority, settlement: Object.freeze({ lifecycleClass: 'continue-execution' }), producer: producer() }),
    /was not produced by settleManagerLifecycle/,
  );
  assert.throws(() => authorizeManagerContinuation({ authority, settlement, producer: producer(), extra: 1 }), /input\.extra is not a recognised field/);
  assert.throws(() => authorizeManagerContinuation('nope'), /input must be an object/);
  assert.throws(
    () => assertNormalizedContinuationAuthorityShape(Object.freeze({ kind: 'same-pull-request' })),
    /was not produced by authorizeManagerContinuation/,
  );
});

test('a settlement for one authority never authorises a continuation of another', () => {
  const settlement = settle({ ci: failingCi });
  const otherAuthority = buildAuthority({
    request: {
      curationKey: 'qc:fixture-project:evidence-contract',
      branch: 'agent/other-implementation-501',
      scope: ['Implement the bounded evidence contract and its focused tests.'],
      stopConditions: ['Stop and report if the accepted base commit changes.'],
    },
  });
  assert.throws(
    () => authorizeManagerContinuation({ authority: otherAuthority, settlement, producer: producer() }),
    /settlement does not belong to the supplied worker authority/,
  );
});
