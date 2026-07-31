import assert from 'node:assert/strict';
import test from 'node:test';

import { runQueueTriageReleaseExecutor } from './agent-runner-queue-triage-executor.mjs';

const AUTHORITY = {
  revision: 'AR113-TEST.1',
  fingerprint: `sha256:${'a'.repeat(64)}`,
};

function project({ enabled = true, maxMutations = 3 } = {}) {
  return {
    projectId: 'alpha',
    githubRepo: 'Owner/Alpha',
    acceptedAgentLabels: ['agent:test'],
    statusLabels: {
      ready: 'status:ready',
      inProgress: 'status:in-progress',
      blocked: 'status:blocked',
      done: 'status:done',
    },
    priorityLabelRanking: ['priority:P0', 'priority:P1'],
    queueTriage: { enabled, maxMutations },
  };
}

function release({ state = 'pending', result = {} } = {}) {
  return {
    batchId: 'batch-1',
    state,
    releasedAt: '2026-07-31T09:00:00.000Z',
    updatedAt: '2026-07-31T09:00:00.000Z',
    claimToken: null,
    claimExpiresAt: null,
    payload: {
      schemaVersion: 1,
      batchId: 'batch-1',
      projectId: 'alpha',
      repository: 'Owner/Alpha',
      objectKind: 'issue',
      objectNumber: 17,
      settledAt: '2026-07-31T08:59:00.000Z',
      deliveryIds: [],
      shas: [],
      settlement: { reason: 'settled', requiredShas: [], terminalFailures: [] },
    },
    result,
  };
}

class FakeStore {
  constructor(initial) {
    this.release = structuredClone(initial);
    this.claims = 0;
    this.finishes = 0;
  }
  getRelease() { return structuredClone(this.release); }
  claimRelease(_id, { claimToken, now }) {
    if (this.release.state !== 'pending') return null;
    this.claims += 1;
    this.release.state = 'claimed';
    this.release.claimToken = claimToken;
    this.release.updatedAt = now;
    return this.getRelease();
  }
  finishRelease(_id, { claimToken, state, result, now }) {
    if (this.release.state !== 'claimed' || this.release.claimToken !== claimToken) return null;
    this.finishes += 1;
    this.release.state = state;
    this.release.claimToken = null;
    this.release.result = structuredClone(result);
    this.release.updatedAt = now;
    return this.getRelease();
  }
  close() {}
}

function evidence() {
  return {
    schemaVersion: 1,
    observedAt: '2026-07-31T10:00:00.000Z',
    mode: 'release',
    releaseId: 'batch-1',
    project: { projectId: 'alpha', repository: 'Owner/Alpha' },
    changedItems: [],
    rotatingItems: [],
    liveEvidence: {
      queryComplete: true,
      fingerprint: `sha256:${'b'.repeat(64)}`,
    },
  };
}

function labelPlan({ updatedAt = '2026-07-31T10:00:00.000Z', number = 17 } = {}) {
  return {
    schemaVersion: 1,
    projectId: 'alpha',
    repository: 'Owner/Alpha',
    kind: 'issue',
    number,
    exactBefore: {
      labels: ['agent:test', 'area:test', 'priority:P0', 'status:blocked'],
      updatedAt,
    },
    decisiveEvidenceRefs: ['issue:17'],
    authority: null,
    action: 'replace_labels',
    intendedFullLabelSet: ['agent:test', 'area:test', 'priority:P0', 'status:ready'],
    risk: 'low-mechanical',
    expectedPostWriteState: {
      state: 'open',
      labels: ['agent:test', 'area:test', 'priority:P0', 'status:ready'],
    },
    reasons: ['status-reconciliation'],
    idempotencyKey: `queue-triage:alpha:issue:${number}:test`,
    evidenceFingerprint: `sha256:${'c'.repeat(64)}`,
  };
}

function closePlan() {
  const plan = labelPlan();
  return {
    ...plan,
    exactBefore: {
      labels: ['agent:test', 'area:test', 'priority:P0', 'status:done'],
      updatedAt: '2026-07-31T10:00:00.000Z',
    },
    action: 'close_issue',
    intendedFullLabelSet: null,
    expectedPostWriteState: { state: 'closed', stateReason: 'completed' },
    reasons: ['merged-completion-settled'],
  };
}

function report(plans) {
  return {
    schemaVersion: 1,
    observedAt: '2026-07-31T10:00:00.000Z',
    dryRun: true,
    mode: 'release',
    releaseId: 'batch-1',
    fallbackId: null,
    project: { projectId: 'alpha', repository: 'Owner/Alpha' },
    policy: { enabled: true, maxMutations: 3 },
    inspected: { changed: 1, rotating: 0, total: 1 },
    actionPlans: plans,
    exceptions: [],
    counts: {},
    overflow: { changedItems: 0, rotatingItems: 0, debuggerAnomalies: 0, proposedMutations: 0 },
    runControl: {},
  };
}

function labelDefinitions() {
  return [
    'agent:test', 'area:test', 'priority:P0', 'priority:P1',
    'status:ready', 'status:in-progress', 'status:blocked', 'status:done',
  ].map((name) => ({ name }));
}

function issueSnapshot(labels, {
  state = 'open',
  stateReason = null,
  updatedAt = '2026-07-31T10:00:00.000Z',
} = {}) {
  return {
    number: 17,
    state,
    state_reason: stateReason,
    updated_at: updatedAt,
    labels: labels.map((name) => ({ name })),
  };
}

function executeFixture({ plans = [labelPlan()], snapshots, initialRelease = release(), planSequence = null } = {}) {
  const store = new FakeStore(initialRelease);
  const writes = [];
  const queue = [...snapshots];
  let planCall = 0;
  const result = runQueueTriageReleaseExecutor({
    controllerDb: '/tmp/controller.sqlite',
    releaseId: 'batch-1',
    project: project(),
    managerAuthority: AUTHORITY,
    readClient: {
      requestJson(endpoint) {
        if (endpoint.endsWith('/labels')) return labelDefinitions();
        if (endpoint.endsWith('/issues/17')) return queue.shift();
        throw new Error(`unexpected read: ${endpoint}`);
      },
    },
    writeClient: {
      mutateIssue(endpoint, payload) {
        writes.push({ endpoint, payload });
        return {};
      },
    },
    claimToken: 'queue-triage-test-claim',
    observedAt: '2026-07-31T10:01:00.000Z',
    storeFactory: () => store,
    collectEvidence: () => evidence(),
    plan: () => {
      const value = planSequence ? planSequence[Math.min(planCall, planSequence.length - 1)] : report(plans);
      planCall += 1;
      return value;
    },
  });
  return { result, store, writes };
}

test('executes one atomic label replacement and verifies exact read-back', () => {
  const before = issueSnapshot(['status:blocked', 'priority:P0', 'agent:test', 'area:test']);
  const after = issueSnapshot(['status:ready', 'priority:P0', 'agent:test', 'area:test'], {
    updatedAt: '2026-07-31T10:01:01.000Z',
  });
  const { result, store, writes } = executeFixture({ snapshots: [before, after] });
  assert.equal(result.status, 'processed');
  assert.equal(store.release.state, 'processed');
  assert.equal(result.runControl.mutationsAttempted, 1);
  assert.equal(result.runControl.mutationsVerified, 1);
  assert.deepEqual(writes, [{
    endpoint: '/repos/Owner/Alpha/issues/17',
    payload: { labels: ['agent:test', 'area:test', 'priority:P0', 'status:ready'] },
  }]);
  assert.equal(result.terminalResult.execution.outcomes[0].verified, true);
});

test('executes completed issue closure and verifies state reason', () => {
  const before = issueSnapshot(['status:done', 'priority:P0', 'agent:test', 'area:test']);
  const after = issueSnapshot(['status:done', 'priority:P0', 'agent:test', 'area:test'], {
    state: 'closed',
    stateReason: 'completed',
    updatedAt: '2026-07-31T10:01:01.000Z',
  });
  const { result, writes } = executeFixture({ plans: [closePlan()], snapshots: [before, after] });
  assert.equal(result.status, 'processed');
  assert.deepEqual(writes[0].payload, { state: 'closed', state_reason: 'completed' });
});

test('fails closed before writes when the final action plan changes', () => {
  const first = report([labelPlan()]);
  const second = report([labelPlan({ updatedAt: '2026-07-31T10:00:01.000Z' })]);
  const { result, store, writes } = executeFixture({ snapshots: [], planSequence: [first, second] });
  assert.equal(result.status, 'failed');
  assert.equal(store.release.state, 'failed');
  assert.equal(result.terminalResult.failure.code, 'execution-plan-replaced');
  assert.equal(writes.length, 0);
});

test('records a bounded failure and stops after read-back mismatch', () => {
  const before = issueSnapshot(['status:blocked', 'priority:P0', 'agent:test', 'area:test']);
  const mismatch = issueSnapshot(['status:blocked', 'priority:P0', 'agent:test', 'area:test'], {
    updatedAt: '2026-07-31T10:01:01.000Z',
  });
  const { result, writes } = executeFixture({ snapshots: [before, mismatch] });
  assert.equal(result.status, 'failed');
  assert.equal(result.terminalResult.failure.code, 'mutation-readback-mismatch');
  assert.equal(result.runControl.mutationsAttempted, 1);
  assert.equal(result.runControl.mutationsVerified, 0);
  assert.equal(writes.length, 1);
});

test('requires enabled project policy before opening the release store', () => {
  let opened = false;
  assert.throws(() => runQueueTriageReleaseExecutor({
    controllerDb: '/tmp/controller.sqlite',
    releaseId: 'batch-1',
    project: project({ enabled: false }),
    managerAuthority: AUTHORITY,
    readClient: { requestJson() {} },
    writeClient: { mutateIssue() {} },
    storeFactory: () => { opened = true; return new FakeStore(release()); },
  }), /enabled project policy/);
  assert.equal(opened, false);
});

test('already-terminal replay performs no GitHub reads or writes', () => {
  const store = new FakeStore(release({ state: 'processed', result: { ok: true } }));
  let reads = 0;
  let writes = 0;
  const result = runQueueTriageReleaseExecutor({
    controllerDb: '/tmp/controller.sqlite',
    releaseId: 'batch-1',
    project: project(),
    managerAuthority: AUTHORITY,
    readClient: { requestJson() { reads += 1; } },
    writeClient: { mutateIssue() { writes += 1; } },
    storeFactory: () => store,
  });
  assert.equal(result.status, 'already-terminal');
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(store.claims, 0);
});

test('mutation limits fail closed and persist a terminal failure', () => {
  const plans = [17, 18, 19, 20].map((number) => labelPlan({ number }));
  const { result, writes } = executeFixture({ plans, snapshots: [] });
  assert.equal(result.status, 'failed');
  assert.equal(result.terminalResult.failure.code, 'mutation-limit-exceeded');
  assert.equal(writes.length, 0);
});
