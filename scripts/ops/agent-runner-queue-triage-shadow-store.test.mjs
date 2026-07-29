import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { QueueTriageShadowStore } from './agent-runner-queue-triage-shadow-store.mjs';

function release({
  batchId = 'batch-alpha-1',
  projectId = 'alpha',
  repository = 'Owner/Alpha',
  objectNumber = 7,
} = {}) {
  return {
    batchId,
    state: 'pending',
    releasedAt: '2026-07-29T18:00:00Z',
    updatedAt: '2026-07-29T18:00:00Z',
    claimToken: null,
    claimExpiresAt: null,
    payload: {
      schemaVersion: 1,
      batchId,
      projectId,
      repository,
      objectKind: 'issue',
      objectNumber,
      settledAt: '2026-07-29T17:59:00Z',
      deliveryIds: [`delivery-${batchId}`],
      shas: [{ sha: 'a'.repeat(40), role: 'head' }],
      settlement: {
        reason: 'ci-settled',
        requiredShas: ['a'.repeat(40)],
        terminalFailures: [],
      },
    },
    result: {},
  };
}

function evidence(inputRelease = release()) {
  return {
    project: {
      projectId: inputRelease.payload.projectId,
      repository: inputRelease.payload.repository,
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
    observedAt: '2026-07-29T18:05:00Z',
    mode: 'release',
    releaseId: inputRelease.batchId,
    changedItems: [{
      repository: inputRelease.payload.repository,
      kind: 'issue',
      number: inputRelease.payload.objectNumber,
      updatedAt: '2026-07-29T18:01:00Z',
      labels: ['priority:P0', 'status:blocked', 'agent:claude'],
      evidenceRefs: [`issue:${inputRelease.payload.objectNumber}`],
      flags: {},
    }],
    rotatingItems: [],
  };
}

test('observes one pending release idempotently and fails closed on payload collision', () => {
  const store = new QueueTriageShadowStore(':memory:', {
    now: () => '2026-07-29T18:10:00Z',
  });
  try {
    const inputRelease = release();
    assert.equal(store.observeRelease(inputRelease).inserted, true);
    assert.equal(store.observeRelease(inputRelease).replayed, true);
    const changed = structuredClone(inputRelease);
    changed.payload.settlement.reason = 'changed-after-observation';
    assert.throws(
      () => store.observeRelease(changed),
      (error) => error.code === 'shadow-release-collision',
    );
    assert.deepEqual(store.counts(), { observations: 1, reports: 0 });
  } finally {
    store.close();
  }
});

test('persists a planner report once and replays it after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-runner-triage-shadow-store-'));
  const dbPath = join(directory, 'shadow.sqlite');
  const inputRelease = release();
  try {
    let store = new QueueTriageShadowStore(dbPath);
    const first = store.attachEvidenceAndPlan(inputRelease, evidence(inputRelease));
    assert.equal(first.inserted, true);
    assert.equal(first.report.dryRun, true);
    store.close();

    store = new QueueTriageShadowStore(dbPath);
    const replay = store.attachEvidenceAndPlan(inputRelease, evidence(inputRelease));
    assert.equal(replay.replayed, true);
    assert.equal(replay.reportId, first.reportId);
    assert.deepEqual(store.counts(), { observations: 1, reports: 1 });
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects normalized evidence that does not match release identity', () => {
  const store = new QueueTriageShadowStore(':memory:');
  try {
    const inputRelease = release();
    const wrongObject = evidence(inputRelease);
    wrongObject.changedItems[0].number = 99;
    assert.throws(
      () => store.attachEvidenceAndPlan(inputRelease, wrongObject),
      /object identity does not match/,
    );

    const wrongProject = evidence(inputRelease);
    wrongProject.project.projectId = 'other-project';
    assert.throws(
      () => store.attachEvidenceAndPlan(inputRelease, wrongProject),
      /project identity does not match/,
    );
  } finally {
    store.close();
  }
});

test('stores two materially different project releases with the same implementation', () => {
  const store = new QueueTriageShadowStore(':memory:');
  try {
    const alpha = release();
    const beta = release({
      batchId: 'batch-beta-1',
      projectId: 'beta',
      repository: 'Elsewhere/Beta',
      objectNumber: 44,
    });
    assert.equal(store.observeRelease(alpha).inserted, true);
    assert.equal(store.observeRelease(beta).inserted, true);
    assert.deepEqual(store.counts(), { observations: 2, reports: 0 });
    assert.equal(store.getObservation(beta.batchId).repository, 'Elsewhere/Beta');
  } finally {
    store.close();
  }
});
