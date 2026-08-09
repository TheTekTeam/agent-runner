import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { IssueReconciliationStore } from './agent-runner-issue-reconciliation-store.mjs';
import {
  classifySchedulerReentrySelection,
  emitSchedulerReentryEvent,
  runSchedulerReentryCycle,
  SchedulerReentryStore,
} from './agent-runner-scheduler-reentry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-08-09T20:52:00.000Z';

function issue(overrides = {}) {
  return { number: 200, statusLabel: 'status:ready', agentLabel: 'agent:claude-code-cli', ...overrides };
}

function skip(overrides = {}) {
  return { issue: 199, statusLabel: 'status:ready', reason: 'issue_not_runnable', ...overrides };
}

/** Drives a durable reconciliation row through pending -> issue_closed -> completed, the only evidence emitSchedulerReentryEvent trusts. */
function completedReconciliation(store, overrides = {}) {
  const base = {
    transactionId: 'recon-tx-0000000000000000000000000000000000000001',
    idempotencyKey: 'recon-idem-0000000000000000000000000000000000000001',
    mergeTransactionId: 'merge-tx-0000000000000000000000000000000000000001',
    projectId: 'alpha-prj',
    repository: 'Owner/alpha',
    issueNumber: 200,
    prNumber: 99,
    sourceBranch: 'claude/issue-200',
    targetBranch: 'main',
    expectedHeadSha: 'a'.repeat(40),
    expectedMergeCommitSha: '9'.repeat(40),
    ...overrides,
  };
  store.beginReconciliation(base, { now: NOW });
  if (overrides.state === 'attention') {
    store.attentionReconciliation(base.transactionId, { reasonCode: 'issue-closed-unexpected-reason', now: NOW });
    return base.transactionId;
  }
  store.recordIssueClosed(base.transactionId, { before: {}, intended: {}, now: NOW });
  if (overrides.state === 'issue_closed') return base.transactionId;
  store.completeReconciliation(base.transactionId, { result: { closed: true }, readback: {}, now: NOW });
  return base.transactionId;
}

test('SchedulerReentryStore.emitPending is idempotent', () => {
  const store = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    const first = store.emitPending('tx-1', { repository: 'Owner/alpha', issueNumber: 200, projectId: 'alpha-prj' });
    const second = store.emitPending('tx-1', { repository: 'Owner/OTHER', issueNumber: 999, projectId: 'other' });
    assert.deepEqual(first, second);
    assert.equal(first.repository, 'Owner/alpha');
    assert.equal(first.nextAction, 'pending');
  } finally {
    store.close();
  }
});

test('SchedulerReentryStore.recordSelectionOutcome only transitions a pending row once', () => {
  const store = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    store.emitPending('tx-1', { repository: 'Owner/alpha', issueNumber: 200 });
    const resolved = store.recordSelectionOutcome('tx-1', { nextAction: 'idle', skippedCount: 0 });
    assert.equal(resolved.nextAction, 'idle');
    const replay = store.recordSelectionOutcome('tx-1', { nextAction: 'candidate_selected', selectedIssueNumber: 5, skippedCount: 0 });
    assert.equal(replay.nextAction, 'idle', 'an already-resolved row must never be overwritten');
  } finally {
    store.close();
  }
});

test('emitSchedulerReentryEvent refuses a missing reconciliation transaction', () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    assert.throws(
      () => emitSchedulerReentryEvent({ reconciliationStore, reentryStore, transactionId: 'missing-tx', now: NOW }),
      (error) => error.code === 'reconciliation-transaction-not-found',
    );
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('emitSchedulerReentryEvent refuses a reconciliation that has not reached completed', () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    const txId = completedReconciliation(reconciliationStore, { state: 'issue_closed' });
    assert.throws(
      () => emitSchedulerReentryEvent({ reconciliationStore, reentryStore, transactionId: txId, now: NOW }),
      (error) => error.code === 'reconciliation-not-completed',
    );
    assert.equal(reentryStore.getEvent(txId), undefined, 'a refused emission must not durably record anything');
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('emitSchedulerReentryEvent refuses an attention (non-terminal) reconciliation', () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    const txId = completedReconciliation(reconciliationStore, { state: 'attention' });
    assert.throws(
      () => emitSchedulerReentryEvent({ reconciliationStore, reentryStore, transactionId: txId, now: NOW }),
      (error) => error.code === 'reconciliation-not-completed',
    );
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('emitSchedulerReentryEvent emits from a completed reconciliation and replay never re-reads it', () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  let reads = 0;
  const spiedReconciliationStore = {
    getTransaction: (...a) => { reads += 1; return reconciliationStore.getTransaction(...a); },
  };
  try {
    const txId = completedReconciliation(reconciliationStore);
    const first = emitSchedulerReentryEvent({ reconciliationStore: spiedReconciliationStore, reentryStore, transactionId: txId, now: NOW });
    assert.equal(first.nextAction, 'pending');
    assert.equal(first.repository, 'Owner/alpha');
    assert.equal(first.issueNumber, 200);
    assert.equal(first.projectId, 'alpha-prj');
    assert.equal(reads, 1);

    const replay = emitSchedulerReentryEvent({ reconciliationStore: spiedReconciliationStore, reentryStore, transactionId: txId, now: NOW });
    assert.deepEqual(replay, first);
    assert.equal(reads, 1, 'a replayed emission must never re-read the reconciliation store (restart safety)');
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('classifySchedulerReentrySelection', () => {
  assert.deepEqual(classifySchedulerReentrySelection({ issue: null, skipped: [] }), {
    nextAction: 'idle', selectedIssueNumber: null, skippedCount: 0,
  });
  assert.deepEqual(classifySchedulerReentrySelection({ issue: issue({ number: 201 }), skipped: [] }), {
    nextAction: 'candidate_selected', selectedIssueNumber: 201, skippedCount: 0,
  });
  assert.deepEqual(classifySchedulerReentrySelection({ issue: issue({ number: 202 }), skipped: [skip()] }), {
    nextAction: 'skip_and_continue', selectedIssueNumber: 202, skippedCount: 1,
  });
});

test('runSchedulerReentryCycle: idle queue makes zero model calls and zero GitHub mutations', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  let calls = 0;
  try {
    const txId = completedReconciliation(reconciliationStore);
    const result = await runSchedulerReentryCycle({
      reconciliationStore, reentryStore, transactionId: txId, now: NOW,
      selectNextCandidate: async () => { calls += 1; return { issue: null, skipped: [] }; },
    });
    assert.equal(result.nextAction, 'idle');
    assert.equal(result.replayed, false);
    assert.equal(calls, 1);
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('runSchedulerReentryCycle: a blocked first candidate is skipped and the second eligible candidate is selected', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    const txId = completedReconciliation(reconciliationStore);
    const result = await runSchedulerReentryCycle({
      reconciliationStore, reentryStore, transactionId: txId, now: NOW,
      selectNextCandidate: async () => ({ issue: issue({ number: 205 }), skipped: [skip({ issue: 199 })] }),
    });
    assert.equal(result.nextAction, 'skip_and_continue');
    assert.equal(result.selectedIssueNumber, 205);
    assert.equal(result.skippedCount, 1);
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('runSchedulerReentryCycle: restart replay never repeats selection or duplicates the recorded outcome', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  let calls = 0;
  try {
    const txId = completedReconciliation(reconciliationStore);
    const selectNextCandidate = async () => { calls += 1; return { issue: issue({ number: 210 }), skipped: [] }; };
    const first = await runSchedulerReentryCycle({ reconciliationStore, reentryStore, transactionId: txId, now: NOW, selectNextCandidate });
    assert.equal(first.replayed, false);
    assert.equal(calls, 1);

    // Simulates a restart/reboot at the exact boundary after reconciliation completed and reentry resolved.
    const second = await runSchedulerReentryCycle({ reconciliationStore, reentryStore, transactionId: txId, now: NOW, selectNextCandidate });
    assert.equal(second.replayed, true);
    assert.equal(second.nextAction, 'candidate_selected');
    assert.equal(second.selectedIssueNumber, 210);
    assert.equal(calls, 1, 'replay must never re-run the next-candidate selection scan');
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('runSchedulerReentryCycle: a crash between emission and selection resumes selection on retry (no duplicate emit)', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  let calls = 0;
  try {
    const txId = completedReconciliation(reconciliationStore);
    // Simulate the prior process emitting the durable marker and crashing before selection ran.
    emitSchedulerReentryEvent({ reconciliationStore, reentryStore, transactionId: txId, now: NOW });
    assert.equal(reentryStore.getEvent(txId).nextAction, 'pending');

    const result = await runSchedulerReentryCycle({
      reconciliationStore, reentryStore, transactionId: txId, now: NOW,
      selectNextCandidate: async () => { calls += 1; return { issue: null, skipped: [] }; },
    });
    assert.equal(result.replayed, false);
    assert.equal(result.nextAction, 'idle');
    assert.equal(calls, 1);
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('runSchedulerReentryCycle: two materially different fixture repositories/projects resolve independently', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    const alphaTx = completedReconciliation(reconciliationStore, {
      transactionId: 'recon-tx-alpha-0000000000000000000000000001',
      idempotencyKey: 'recon-idem-alpha-0000000000000000000000001',
      mergeTransactionId: 'merge-tx-alpha-0000000000000000000000001',
      projectId: 'alpha-prj',
      repository: 'Owner/alpha',
      issueNumber: 200,
    });
    const modelspendTx = completedReconciliation(reconciliationStore, {
      transactionId: 'recon-tx-modelspend-000000000000000000001',
      idempotencyKey: 'recon-idem-modelspend-00000000000000001',
      mergeTransactionId: 'merge-tx-modelspend-00000000000000001',
      projectId: 'modelspend-prj',
      repository: 'TheTekTeam/modelspend',
      issueNumber: 686,
    });

    const alphaResult = await runSchedulerReentryCycle({
      reconciliationStore, reentryStore, transactionId: alphaTx, now: NOW,
      selectNextCandidate: async () => ({ issue: issue({ number: 201 }), skipped: [] }),
    });
    const modelspendResult = await runSchedulerReentryCycle({
      reconciliationStore, reentryStore, transactionId: modelspendTx, now: NOW,
      selectNextCandidate: async () => ({ issue: null, skipped: [] }),
    });

    assert.equal(alphaResult.repository, 'Owner/alpha');
    assert.equal(alphaResult.nextAction, 'candidate_selected');
    assert.equal(modelspendResult.repository, 'TheTekTeam/modelspend');
    assert.equal(modelspendResult.nextAction, 'idle');
    // The exact same generic code path, driven only by data, produced both outcomes.
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('supervised ModelSpend canary: the reentry source contains no ModelSpend-specific branching', () => {
  const source = readFileSync(join(HERE, 'agent-runner-scheduler-reentry.mjs'), 'utf8')
    + readFileSync(join(HERE, 'agent-runner-scheduler-reentry-command.mjs'), 'utf8');
  assert.equal(/modelspend/i.test(source), false, 'the generic adapter must never source-branch on a specific project');
});
