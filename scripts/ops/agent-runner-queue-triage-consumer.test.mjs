import assert from 'node:assert/strict';
import test from 'node:test';

import { runQueueTriageReleaseConsumer } from './agent-runner-queue-triage-consumer.mjs';

const RELEASE_ID = 'batch-consumer-fixture-0001';
const OBSERVED_AT = '2026-07-30T15:30:00.000Z';

function project() {
  return {
    projectId: 'alpha',
    githubRepo: 'Owner/Alpha',
    acceptedAgentLabels: ['agent:claude'],
    statusLabels: {
      ready: 'status:ready',
      inProgress: 'status:in-progress',
      blocked: 'status:blocked',
      done: 'status:done',
    },
    priorityLabelRanking: ['priority:P0'],
    queueTriage: { enabled: false },
  };
}

function release(state = 'pending') {
  return {
    batchId: RELEASE_ID,
    state,
    releasedAt: '2026-07-30T15:00:00.000Z',
    updatedAt: '2026-07-30T15:00:00.000Z',
    payload: {
      schemaVersion: 1,
      batchId: RELEASE_ID,
      projectId: 'alpha',
      repository: 'Owner/Alpha',
      objectKind: 'issue',
      objectNumber: 17,
      settledAt: '2026-07-30T14:59:00.000Z',
      deliveryIds: ['delivery-1'],
      shas: [],
      settlement: { reason: 'ci-settled', requiredShas: [], terminalFailures: [] },
    },
    result: {},
    claimToken: null,
    claimExpiresAt: null,
  };
}

function fixtureStore(initial = release()) {
  const shared = { release: structuredClone(initial), claims: 0, finishes: 0 };
  class Store {
    getRelease(batchId) {
      return batchId === RELEASE_ID ? structuredClone(shared.release) : null;
    }
    claimRelease(batchId, { claimToken, leaseMs, now }) {
      if (batchId !== RELEASE_ID || shared.release.state !== 'pending') return null;
      shared.claims += 1;
      shared.release.state = 'claimed';
      shared.release.claimToken = claimToken;
      shared.release.claimExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      shared.release.updatedAt = now;
      return structuredClone(shared.release);
    }
    finishRelease(batchId, { claimToken, state, result, now }) {
      if (batchId !== RELEASE_ID || shared.release.state !== 'claimed' || shared.release.claimToken !== claimToken) return null;
      shared.finishes += 1;
      shared.release.state = state;
      shared.release.result = structuredClone(result);
      shared.release.claimToken = null;
      shared.release.claimExpiresAt = null;
      shared.release.updatedAt = now;
      return structuredClone(shared.release);
    }
    close() {}
  }
  return { shared, storeFactory: () => new Store() };
}

function completeEvidence() {
  return {
    schemaVersion: 1,
    project: {
      projectId: 'alpha',
      repository: 'Owner/Alpha',
      acceptedAgentLabels: ['agent:claude'],
      statusLabels: {
        ready: 'status:ready',
        inProgress: 'status:in-progress',
        blocked: 'status:blocked',
        done: 'status:done',
      },
      priorityLabels: ['priority:P0'],
      policy: { enabled: false },
    },
    observedAt: OBSERVED_AT,
    mode: 'release',
    releaseId: RELEASE_ID,
    changedItems: [],
    rotatingItems: [],
    liveEvidence: {
      queryComplete: true,
      diagnostics: [],
      identity: { releaseId: RELEASE_ID },
      fingerprint: 'sha256:' + 'a'.repeat(64),
    },
  };
}

function dryRunReport() {
  return {
    schemaVersion: 1,
    observedAt: OBSERVED_AT,
    dryRun: true,
    mode: 'release',
    releaseId: RELEASE_ID,
    fallbackId: null,
    project: { projectId: 'alpha', repository: 'Owner/Alpha' },
    inspected: { changed: 1, rotating: 0, total: 1 },
    actionPlans: [{ action: 'replace_labels' }],
    exceptions: [],
    runControl: { mutationAllowed: false },
  };
}

function run(options = {}) {
  const store = options.store ?? fixtureStore();
  return {
    store,
    result: runQueueTriageReleaseConsumer({
      controllerDb: '/tmp/controller.sqlite',
      releaseId: RELEASE_ID,
      project: project(),
      client: { requestJson() { return {}; } },
      claimToken: options.claimToken ?? 'queue-triage-fixture-token',
      observedAt: OBSERVED_AT,
      storeFactory: store.storeFactory,
      collectEvidence: options.collectEvidence ?? (() => completeEvidence()),
      plan: options.plan ?? (() => dryRunReport()),
      afterClaim: options.afterClaim ?? null,
    }),
  };
}

test('claims one explicit release and persists a bounded processed dry-run result', () => {
  const { store, result } = run();
  assert.equal(result.status, 'processed');
  assert.equal(store.shared.release.state, 'processed');
  assert.equal(store.shared.claims, 1);
  assert.equal(store.shared.finishes, 1);
  assert.equal(result.terminalResult.report.actionPlanCount, 1);
  assert.equal(result.terminalResult.report.exceptionCount, 0);
  assert.equal(result.runControl.githubReadOnly, true);
  assert.equal(result.runControl.githubWritesPerformed, false);
  assert.equal(result.runControl.actionPlansExecuted, 0);
  assert.equal(result.runControl.mutationAllowed, false);
  const persisted = JSON.stringify(store.shared.release.result);
  for (const forbidden of ['commentBody', 'rawPayload', 'providerOutput', 'claimToken', 'secret']) {
    assert.equal(persisted.includes(forbidden), false);
  }
});

test('a duplicate invocation after terminal processing is a deterministic no-op', () => {
  const store = fixtureStore();
  const first = run({ store });
  let collections = 0;
  const second = run({
    store,
    collectEvidence() {
      collections += 1;
      return completeEvidence();
    },
  });
  assert.equal(first.result.status, 'processed');
  assert.equal(second.result.status, 'already-terminal');
  assert.equal(store.shared.claims, 1);
  assert.equal(store.shared.finishes, 1);
  assert.equal(collections, 0);
  assert.equal(second.result.runControl.releasesClaimed, 0);
  assert.equal(second.result.runControl.releasesFinished, 0);
});

test('incomplete live evidence cannot finish processed and records a bounded failed result', () => {
  const store = fixtureStore();
  const incomplete = completeEvidence();
  incomplete.liveEvidence.queryComplete = false;
  incomplete.liveEvidence.diagnostics = [{ surface: 'checks', code: 'provider-read-failed' }];
  const { result } = run({ store, collectEvidence: () => incomplete });
  assert.equal(result.status, 'failed');
  assert.equal(store.shared.release.state, 'failed');
  assert.equal(result.terminalResult.failure.code, 'live-evidence-incomplete');
  assert.equal(result.terminalResult.failure.stage, 'live-evidence');
  assert.equal(result.runControl.githubWritesPerformed, false);
});

test('an existing live claim is rejected without evidence collection or terminal mutation', () => {
  const claimed = release('claimed');
  claimed.claimToken = 'other-claim-token';
  claimed.claimExpiresAt = '2026-07-30T16:00:00.000Z';
  const store = fixtureStore(claimed);
  let collections = 0;
  assert.throws(() => run({
    store,
    collectEvidence() {
      collections += 1;
      return completeEvidence();
    },
  }), /already claimed/);
  assert.equal(collections, 0);
  assert.equal(store.shared.finishes, 0);
  assert.equal(store.shared.release.state, 'claimed');
});

test('an interruption after claim preserves the lease for the existing expiry recovery path', () => {
  const store = fixtureStore();
  const interruption = new Error('simulated process interruption');
  interruption.code = 'simulated-interruption';
  interruption.preserveClaim = true;
  assert.throws(() => run({
    store,
    afterClaim() {
      throw interruption;
    },
  }), /simulated process interruption/);
  assert.equal(store.shared.release.state, 'claimed');
  assert.equal(store.shared.claims, 1);
  assert.equal(store.shared.finishes, 0);
  assert.equal(store.shared.release.claimToken, 'queue-triage-fixture-token');
});

test('exact claim-token ownership is rechecked before terminal finish', () => {
  const store = fixtureStore();
  assert.throws(() => run({
    store,
    afterClaim() {
      store.shared.release.claimToken = 'replacement-owner-token';
    },
  }), /ownership changed/);
  assert.equal(store.shared.release.state, 'claimed');
  assert.equal(store.shared.finishes, 0);
  assert.equal(store.shared.release.claimToken, 'replacement-owner-token');
});
