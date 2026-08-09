import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IssueReconciliationStore } from './agent-runner-issue-reconciliation-store.mjs';
import {
  classifyProductionHandoffResult,
  runSchedulerReentryCycle,
  SchedulerReentryStore,
} from './agent-runner-scheduler-reentry.mjs';
import { runProductionCronPass } from './agent-runner-scheduler-reentry-command.mjs';

const NOW = '2026-08-09T21:00:00.000Z';

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
  store.recordIssueClosed(base.transactionId, { before: {}, intended: {}, now: NOW });
  store.completeReconciliation(base.transactionId, { result: { closed: true }, readback: {}, now: NOW });
  return base.transactionId;
}

/** A fake standing in for `claude-runner-cron.mjs`'s exported `main()`: prints exactly one terminal JSON line, the same contract every real terminal branch honours. */
function fakeCronMain(payload, { calls } = {}) {
  return async () => {
    if (calls) calls.count += 1;
    console.log(JSON.stringify(payload));
    return payload.exitCode ?? 0;
  };
}

test('classifyProductionHandoffResult: a genuine claim is candidate_selected-shaped', () => {
  const result = classifyProductionHandoffResult({ selectedIssue: 205, claim: { claimId: 'x' }, skipped: [] });
  assert.deepEqual(result, { issue: { number: 205 }, skipped: [] });
});

test('classifyProductionHandoffResult: skipped entries survive alongside a genuine claim', () => {
  const result = classifyProductionHandoffResult({
    selectedIssue: 205, claim: { claimId: 'x' }, skipped: [{ issue: 199, reason: 'issue_not_runnable' }],
  });
  assert.deepEqual(result, { issue: { number: 205 }, skipped: [{ issue: 199, reason: 'issue_not_runnable' }] });
});

test('classifyProductionHandoffResult: an inspected-but-never-claimed candidate is idle-shaped, never misreported as selected', () => {
  // Mirrors dispatch-authority-rejected / model-resolution-invalid / workspace-ownership-conflict /
  // settings-revision-changed: selectedIssue is present but claim is null because claimIssueForExecution never ran.
  const result = classifyProductionHandoffResult({ selectedIssue: 205, claim: null, skipped: [] });
  assert.deepEqual(result, { issue: null, skipped: [] });
});

test('classifyProductionHandoffResult: no candidate (idle/quota-blocked/no-selection) is idle-shaped', () => {
  assert.deepEqual(classifyProductionHandoffResult({ selectedIssue: null, claim: null, skipped: [] }), { issue: null, skipped: [] });
  assert.deepEqual(classifyProductionHandoffResult({}), { issue: null, skipped: [] });
});

test('runProductionCronPass: captures the terminal JSON line and restores console.log', async () => {
  const originalLog = console.log;
  const payload = { selectedIssue: 210, claim: { claimId: 'y' }, skipped: [] };
  const result = await runProductionCronPass(['--execute'], {}, { cronMain: fakeCronMain(payload) });
  assert.deepEqual(result, payload);
  assert.equal(console.log, originalLog, 'console.log must be restored after the call');
});

test('runProductionCronPass: only the last JSON-parseable console.log call is used', async () => {
  const cronMain = async () => {
    console.log('non-json diagnostic line');
    console.log(JSON.stringify({ selectedIssue: 1, claim: null, skipped: [] }));
    console.log(JSON.stringify({ selectedIssue: 220, claim: { claimId: 'z' }, skipped: [] }));
  };
  const result = await runProductionCronPass([], {}, { cronMain });
  assert.deepEqual(result, { selectedIssue: 220, claim: { claimId: 'z' }, skipped: [] });
});

test('runProductionCronPass: console.log is restored even when the production entrypoint throws', async () => {
  const originalLog = console.log;
  const cronMain = async () => { throw new Error('simulated systemic failure'); };
  await assert.rejects(() => runProductionCronPass([], {}, { cronMain }));
  assert.equal(console.log, originalLog, 'console.log must be restored even on failure');
});

test('production handoff: a selected fixture candidate reaches the claim/worker boundary exactly once per completed transaction', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  const calls = { count: 0 };
  try {
    const txId = completedReconciliation(reconciliationStore);
    const cronMain = fakeCronMain({ selectedIssue: 205, claim: { claimId: 'claim-205' }, skipped: [] }, { calls });
    const selectNextCandidate = async () => {
      const payload = await runProductionCronPass(['--execute'], {}, { cronMain });
      return classifyProductionHandoffResult(payload);
    };

    const first = await runSchedulerReentryCycle({ reconciliationStore, reentryStore, transactionId: txId, now: NOW, selectNextCandidate });
    assert.equal(first.nextAction, 'candidate_selected');
    assert.equal(first.selectedIssueNumber, 205);
    assert.equal(calls.count, 1, 'the production entrypoint must be invoked exactly once for a fresh reconciliation');

    // Restart/replay at the exact boundary after the outcome was durably recorded.
    const replay = await runSchedulerReentryCycle({ reconciliationStore, reentryStore, transactionId: txId, now: NOW, selectNextCandidate });
    assert.equal(replay.replayed, true);
    assert.equal(replay.nextAction, 'candidate_selected');
    assert.equal(calls.count, 1, 'a replayed transaction must never re-invoke the production entrypoint (idempotent)');
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('production handoff: a blocked first candidate is skipped, the second eligible candidate is claimed and launched', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    const txId = completedReconciliation(reconciliationStore);
    const cronMain = fakeCronMain({
      selectedIssue: 206, claim: { claimId: 'claim-206' }, skipped: [{ issue: 199, reason: 'issue_not_runnable' }],
    });
    const selectNextCandidate = async () => classifyProductionHandoffResult(await runProductionCronPass([], {}, { cronMain }));

    const result = await runSchedulerReentryCycle({ reconciliationStore, reentryStore, transactionId: txId, now: NOW, selectNextCandidate });
    assert.equal(result.nextAction, 'skip_and_continue');
    assert.equal(result.selectedIssueNumber, 206);
    assert.equal(result.skippedCount, 1);
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('production handoff: empty queue settles idle with the production entrypoint invoked exactly once, no candidate misreported', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  const calls = { count: 0 };
  try {
    const txId = completedReconciliation(reconciliationStore);
    const cronMain = fakeCronMain({ selectedIssue: null, claim: null, skipped: [], quotaBlocked: false }, { calls });
    const selectNextCandidate = async () => classifyProductionHandoffResult(await runProductionCronPass([], {}, { cronMain }));

    const result = await runSchedulerReentryCycle({ reconciliationStore, reentryStore, transactionId: txId, now: NOW, selectNextCandidate });
    assert.equal(result.nextAction, 'idle');
    assert.equal(result.selectedIssueNumber, null);
    assert.equal(calls.count, 1);
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('production handoff: a candidate-specific blocker (inspected, never claimed) settles idle rather than a false candidate_selected', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    const txId = completedReconciliation(reconciliationStore);
    // Mirrors dispatch-authority-rejected / workspace-ownership-conflict: a candidate was
    // inspected (selectedIssue set) but claimIssueForExecution never ran (claim stays null).
    const cronMain = fakeCronMain({ selectedIssue: 207, claim: null, skipped: [], exitCode: 1 });
    const selectNextCandidate = async () => classifyProductionHandoffResult(await runProductionCronPass([], {}, { cronMain }));

    const result = await runSchedulerReentryCycle({ reconciliationStore, reentryStore, transactionId: txId, now: NOW, selectNextCandidate });
    assert.equal(result.nextAction, 'idle');
    assert.equal(result.selectedIssueNumber, null, 'an inspected-but-unclaimed candidate must never be recorded as selected');
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('production handoff: a systemic failure leaves the reentry row pending rather than recording a false outcome', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  try {
    const txId = completedReconciliation(reconciliationStore);
    const cronMain = async () => { throw new Error('simulated systemic-pause condition'); };
    const selectNextCandidate = async () => classifyProductionHandoffResult(await runProductionCronPass([], {}, { cronMain }));

    await assert.rejects(() => runSchedulerReentryCycle({ reconciliationStore, reentryStore, transactionId: txId, now: NOW, selectNextCandidate }));
    assert.equal(reentryStore.getEvent(txId).nextAction, 'pending', 'a systemic failure must never record a resolved outcome');
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});

test('production handoff: two materially different fixture repositories each reach the claim boundary exactly once via the same generic path', async () => {
  const reconciliationStore = new IssueReconciliationStore(':memory:', { now: () => NOW });
  const reentryStore = new SchedulerReentryStore(':memory:', { now: () => NOW });
  const alphaCalls = { count: 0 };
  const modelspendCalls = { count: 0 };
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

    const alphaCronMain = fakeCronMain({ selectedIssue: 201, claim: { claimId: 'claim-alpha-201' }, skipped: [] }, { calls: alphaCalls });
    const modelspendCronMain = fakeCronMain({ selectedIssue: null, claim: null, skipped: [] }, { calls: modelspendCalls });

    const alphaResult = await runSchedulerReentryCycle({
      reconciliationStore, reentryStore, transactionId: alphaTx, now: NOW,
      selectNextCandidate: async () => classifyProductionHandoffResult(await runProductionCronPass([], {}, { cronMain: alphaCronMain })),
    });
    const modelspendResult = await runSchedulerReentryCycle({
      reconciliationStore, reentryStore, transactionId: modelspendTx, now: NOW,
      selectNextCandidate: async () => classifyProductionHandoffResult(await runProductionCronPass([], {}, { cronMain: modelspendCronMain })),
    });

    assert.equal(alphaResult.repository, 'Owner/alpha');
    assert.equal(alphaResult.nextAction, 'candidate_selected');
    assert.equal(alphaCalls.count, 1);
    assert.equal(modelspendResult.repository, 'TheTekTeam/modelspend');
    assert.equal(modelspendResult.nextAction, 'idle');
    assert.equal(modelspendCalls.count, 1);
    // The exact same generic runSchedulerReentryCycle/runProductionCronPass path, driven only by data, produced both outcomes.
  } finally {
    reentryStore.close();
    reconciliationStore.close();
  }
});
