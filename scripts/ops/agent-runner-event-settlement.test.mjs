import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acceptGitHubWebhook, EventIngressStore } from './agent-runner-event-ingress.mjs';
import {
  EventSettlementStore,
  normalizeCheckSnapshot,
  settlementBatchKey,
} from './agent-runner-event-settlement.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';

const SECRET = 'settlement-fixture-webhook-secret-minimum-32-bytes';
const T0 = Date.parse('2026-07-29T00:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

function projectConfig() {
  return {
    projectId: 'alpha',
    displayName: 'Alpha',
    githubRepo: 'Owner/Alpha',
    localRepoPath: '/srv/alpha',
    outputDir: '.var/agent-runner',
    stateDbPath: '.var/agent-runner/state.sqlite',
    acceptedAgentLabels: ['agent:claude'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: ['npm test'],
    systemd: { serviceName: 'alpha.service', timerName: 'alpha.timer' },
    runner: { lockPath: '.var/agent-runner/alpha.lock', candidateLimit: 10 },
  };
}

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-event-settlement-'));
  const configPath = join(dir, 'alpha.json');
  const registryPath = join(dir, 'registry.json');
  const dbPath = join(dir, 'controller.sqlite');
  writeFileSync(configPath, JSON.stringify(projectConfig()));
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: ['alpha.json'] }));
  const registry = loadProjectRegistry({ registryPath });
  const context = {
    registry,
    ingress: new EventIngressStore(dbPath),
    settlement: new EventSettlementStore(dbPath),
    dbPath,
  };
  try {
    return fn(context);
  } finally {
    context.settlement.close();
    context.ingress.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function deliver({ registry, ingress }, payload, {
  deliveryId,
  eventName,
  receivedAt,
}) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return acceptGitHubWebhook({
    rawBody,
    headers: {
      'x-github-delivery': deliveryId,
      'x-github-event': eventName,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
    },
    secret: SECRET,
    registry,
    store: ingress,
    receivedAt,
  });
}

function prPayload(action, { number = 7, head = 'a', merge = null } = {}) {
  return {
    action,
    repository: { full_name: 'Owner/Alpha', default_branch: 'main' },
    pull_request: {
      number,
      merged: Boolean(merge),
      merge_commit_sha: merge ? merge.repeat(40) : null,
      head: { sha: head.repeat(40), ref: `feature-${number}` },
      base: { sha: 'b'.repeat(40), ref: 'main' },
    },
  };
}

function issuePayload(action, number = 9) {
  return {
    action,
    repository: { full_name: 'Owner/Alpha', default_branch: 'main' },
    issue: { number },
  };
}

function snapshot(sha, observedAt, checks, queryComplete = true) {
  return { sha, observedAt, queryComplete, checks };
}

const pendingCheck = (id = 1) => ({ provider: 'workflow_run', externalId: id, name: 'validate', status: 'in_progress' });
const successfulCheck = (id = 1) => ({
  provider: 'workflow_run', externalId: id, name: 'validate', status: 'completed', conclusion: 'success',
});
const failedCheck = (id = 1) => ({
  provider: 'workflow_run', externalId: id, name: 'validate', status: 'completed', conclusion: 'failure',
});

test('builds deterministic project/object batch keys', () => {
  assert.equal(settlementBatchKey({
    projectId: 'alpha', repository: 'Owner/Alpha', pullRequestNumber: 7,
  }), 'alpha:owner/alpha:pull_request:7');
  assert.equal(settlementBatchKey({
    projectId: 'alpha', repository: 'Owner/Alpha', issueNumber: 9,
  }), 'alpha:owner/alpha:issue:9');
  assert.equal(settlementBatchKey({ projectId: null, repository: null }), null);
});

test('coalesces related PR fan-out into one batch and ignores a system ping', () => fixture((context) => {
  deliver(context, { zen: 'ping' }, { deliveryId: 'ping-1', eventName: 'ping', receivedAt: at(0) });
  deliver(context, prPayload('synchronize'), {
    deliveryId: 'pr-sync', eventName: 'pull_request', receivedAt: at(1_000),
  });
  deliver(context, prPayload('closed', { merge: 'c' }), {
    deliveryId: 'pr-merge', eventName: 'pull_request', receivedAt: at(2_000),
  });

  const attached = context.settlement.attachPendingDeliveries({ now: at(3_000), settlementTimeoutMs: 60_000 });
  assert.equal(attached.length, 3);
  assert.equal(attached[0].ignored, true);
  const batchIds = new Set(attached.filter((item) => !item.ignored).map((item) => item.batchId));
  assert.equal(batchIds.size, 1);
  const batch = context.settlement.getBatch([...batchIds][0]);
  assert.deepEqual(batch.deliveries, ['pr-sync', 'pr-merge']);
  assert.deepEqual(new Set(context.settlement.requiredShas(batch.batchId)), new Set(['a'.repeat(40), 'c'.repeat(40)]));
  assert.equal(context.ingress.getDelivery('ping-1').processingState, 'processed');
}));

test('correlates a post-merge push and SHA-only check event into the active PR batch', () => fixture((context) => {
  deliver(context, prPayload('closed', { head: 'a', merge: 'c' }), {
    deliveryId: 'merge-pr', eventName: 'pull_request', receivedAt: at(0),
  });
  const [{ batchId }] = context.settlement.attachPendingDeliveries({ now: at(100), settlementTimeoutMs: 60_000 });

  deliver(context, {
    repository: { full_name: 'Owner/Alpha', default_branch: 'main' },
    ref: 'refs/heads/main',
    before: 'b'.repeat(40),
    after: 'c'.repeat(40),
  }, { deliveryId: 'main-push', eventName: 'push', receivedAt: at(1_000) });
  const [pushAttachment] = context.settlement.attachPendingDeliveries({ now: at(1_100), settlementTimeoutMs: 60_000 });
  assert.equal(pushAttachment.batchId, batchId);
  assert.equal(context.settlement.getBatch(batchId).objectKind, 'pull_request');
  assert.deepEqual(new Set(context.settlement.requiredShas(batchId)), new Set(['a'.repeat(40), 'c'.repeat(40)]));

  deliver(context, {
    action: 'completed',
    repository: { full_name: 'Owner/Alpha', default_branch: 'main' },
    check_run: { head_sha: 'c'.repeat(40), pull_requests: [] },
  }, { deliveryId: 'merge-check', eventName: 'check_run', receivedAt: at(1_500) });
  const [checkAttachment] = context.settlement.attachPendingDeliveries({ now: at(1_600), settlementTimeoutMs: 60_000 });
  assert.equal(checkAttachment.batchId, batchId);
  assert.deepEqual(context.settlement.getBatch(batchId).deliveries, ['merge-pr', 'main-push', 'merge-check']);
}));

test('issue-only batches settle after debounce and quiet period without CI assumptions', () => fixture((context) => {
  deliver(context, issuePayload('closed'), { deliveryId: 'issue-closed', eventName: 'issues', receivedAt: at(0) });
  const [{ batchId }] = context.settlement.attachPendingDeliveries({ now: at(500), settlementTimeoutMs: 60_000 });
  assert.equal(context.settlement.evaluateBatch(batchId, { now: at(1_000), debounceMs: 2_000, quietPeriodMs: 3_000 }).state, 'collecting');
  const quiet = context.settlement.evaluateBatch(batchId, { now: at(2_000), debounceMs: 2_000, quietPeriodMs: 3_000 });
  assert.equal(quiet.state, 'quiet_period');
  const settled = context.settlement.evaluateBatch(batchId, { now: at(5_000), debounceMs: 2_000, quietPeriodMs: 3_000 });
  assert.equal(settled.state, 'settled');
  assert.equal(context.ingress.getDelivery('issue-closed').processingState, 'processed');
}));

test('non-terminal checks block and terminal failures remain evidence rather than blockers', () => fixture((context) => {
  deliver(context, prPayload('synchronize'), { deliveryId: 'pr-check', eventName: 'pull_request', receivedAt: at(0) });
  const [{ batchId }] = context.settlement.attachPendingDeliveries({ now: at(100), settlementTimeoutMs: 60_000 });
  const head = 'a'.repeat(40);
  context.settlement.recordCheckSnapshot(batchId, snapshot(head, at(2_000), [pendingCheck()]));
  const waiting = context.settlement.evaluateBatch(batchId, { now: at(2_000), debounceMs: 1_000, quietPeriodMs: 2_000 });
  assert.equal(waiting.state, 'waiting_for_checks');
  assert.equal(waiting.result.nonTerminalChecks.length, 1);

  context.settlement.recordCheckSnapshot(batchId, snapshot(head, at(3_000), [failedCheck()]));
  const quiet = context.settlement.evaluateBatch(batchId, { now: at(3_000), debounceMs: 1_000, quietPeriodMs: 2_000 });
  assert.equal(quiet.state, 'quiet_period');
  assert.equal(quiet.result.terminalFailures[0].outcome, 'failure');
  context.settlement.recordCheckSnapshot(batchId, snapshot(head, at(5_000), [failedCheck()]));
  const settled = context.settlement.evaluateBatch(batchId, { now: at(5_000), debounceMs: 1_000, quietPeriodMs: 2_000 });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.result.terminalFailures[0].outcome, 'failure');
}));

test('requires a final post-quiet recheck and resets quiet time for a late-starting run', () => fixture((context) => {
  deliver(context, prPayload('synchronize'), { deliveryId: 'late-check', eventName: 'pull_request', receivedAt: at(0) });
  const [{ batchId }] = context.settlement.attachPendingDeliveries({ now: at(100), settlementTimeoutMs: 60_000 });
  const head = 'a'.repeat(40);
  context.settlement.recordCheckSnapshot(batchId, snapshot(head, at(2_000), [successfulCheck()]));
  const firstQuiet = context.settlement.evaluateBatch(batchId, { now: at(2_000), debounceMs: 1_000, quietPeriodMs: 3_000 });
  assert.equal(firstQuiet.state, 'quiet_period');
  const noRecheck = context.settlement.evaluateBatch(batchId, { now: at(5_000), debounceMs: 1_000, quietPeriodMs: 3_000 });
  assert.equal(noRecheck.state, 'quiet_period');
  assert.equal(noRecheck.result.reason, 'final-recheck-required');

  context.settlement.recordCheckSnapshot(batchId, snapshot(head, at(5_100), [successfulCheck(), pendingCheck(2)]));
  const lateRun = context.settlement.evaluateBatch(batchId, { now: at(5_100), debounceMs: 1_000, quietPeriodMs: 3_000 });
  assert.equal(lateRun.state, 'waiting_for_checks');
  context.settlement.recordCheckSnapshot(batchId, snapshot(head, at(6_000), [successfulCheck(), successfulCheck(2)]));
  const resetQuiet = context.settlement.evaluateBatch(batchId, { now: at(6_000), debounceMs: 1_000, quietPeriodMs: 3_000 });
  assert.equal(resetQuiet.state, 'quiet_period');
  assert.equal(resetQuiet.quietStartedAt, at(6_000));
  context.settlement.recordCheckSnapshot(batchId, snapshot(head, at(9_000), [successfulCheck(), successfulCheck(2)]));
  assert.equal(
    context.settlement.evaluateBatch(batchId, { now: at(9_000), debounceMs: 1_000, quietPeriodMs: 3_000 }).state,
    'settled',
  );
}));

test('replaces the required PR head when a newer synchronize event arrives', () => fixture((context) => {
  deliver(context, prPayload('synchronize', { head: 'a' }), {
    deliveryId: 'head-a', eventName: 'pull_request', receivedAt: at(0),
  });
  const [{ batchId }] = context.settlement.attachPendingDeliveries({ now: at(100), settlementTimeoutMs: 60_000 });
  deliver(context, prPayload('synchronize', { head: 'd' }), {
    deliveryId: 'head-d', eventName: 'pull_request', receivedAt: at(2_000),
  });
  context.settlement.attachPendingDeliveries({ now: at(2_100), settlementTimeoutMs: 60_000 });
  assert.deepEqual(context.settlement.requiredShas(batchId), ['d'.repeat(40)]);
  assert.throws(
    () => context.settlement.recordCheckSnapshot(batchId, snapshot('a'.repeat(40), at(3_000), [successfulCheck()])),
    /not tracked by batch/,
  );
}));

test('rejects unrelated check snapshots and blocks safely on timeout', () => fixture((context) => {
  deliver(context, prPayload('synchronize'), { deliveryId: 'timeout-check', eventName: 'pull_request', receivedAt: at(0) });
  const [{ batchId }] = context.settlement.attachPendingDeliveries({ now: at(0), settlementTimeoutMs: 5_000 });
  assert.throws(
    () => context.settlement.recordCheckSnapshot(batchId, snapshot('d'.repeat(40), at(1_000), [])),
    /not tracked by batch/,
  );
  const blocked = context.settlement.evaluateBatch(batchId, { now: at(5_000), debounceMs: 1_000, quietPeriodMs: 1_000 });
  assert.equal(blocked.state, 'settlement_blocked');
  assert.equal(blocked.result.reason, 'ci-settlement-timeout');
  assert.deepEqual(blocked.result.missingShas, ['a'.repeat(40)]);
  assert.equal(context.ingress.getDelivery('timeout-check').processingState, 'batched');
}));

test('a new relevant delivery reopens a blocked batch and extends its deadline', () => fixture((context) => {
  deliver(context, prPayload('synchronize'), { deliveryId: 'blocked-1', eventName: 'pull_request', receivedAt: at(0) });
  const [{ batchId }] = context.settlement.attachPendingDeliveries({ now: at(0), settlementTimeoutMs: 2_000 });
  assert.equal(
    context.settlement.evaluateBatch(batchId, { now: at(2_000), debounceMs: 500, quietPeriodMs: 500 }).state,
    'settlement_blocked',
  );
  deliver(context, prPayload('synchronize'), { deliveryId: 'blocked-2', eventName: 'pull_request', receivedAt: at(3_000) });
  const [attached] = context.settlement.attachPendingDeliveries({ now: at(3_000), settlementTimeoutMs: 4_000 });
  assert.equal(attached.batchId, batchId);
  const reopened = context.settlement.getBatch(batchId);
  assert.equal(reopened.state, 'collecting');
  assert.equal(reopened.deadlineAt, at(7_000));
}));

test('durable batches and snapshots survive store restart without duplicate attachment', () => fixture((context) => {
  deliver(context, prPayload('synchronize'), { deliveryId: 'restart-batch', eventName: 'pull_request', receivedAt: at(0) });
  const [{ batchId }] = context.settlement.attachPendingDeliveries({ now: at(100), settlementTimeoutMs: 60_000 });
  context.settlement.recordCheckSnapshot(batchId, snapshot('a'.repeat(40), at(2_000), [successfulCheck()]));
  context.settlement.close();
  const reopened = new EventSettlementStore(context.dbPath);
  context.settlement = reopened;
  const recovered = reopened.getBatch(batchId);
  assert.equal(recovered.deliveries.length, 1);
  assert.equal(reopened.snapshots(batchId).length, 1);
  assert.deepEqual(reopened.attachPendingDeliveries({ now: at(3_000) }), []);
}));

test('ignores stale check snapshots and rejects duplicate check identities', () => fixture((context) => {
  deliver(context, prPayload('synchronize'), { deliveryId: 'stale-snapshot', eventName: 'pull_request', receivedAt: at(0) });
  const [{ batchId }] = context.settlement.attachPendingDeliveries({ now: at(100), settlementTimeoutMs: 60_000 });
  const head = 'a'.repeat(40);
  context.settlement.recordCheckSnapshot(batchId, snapshot(head, at(3_000), [successfulCheck()]));
  context.settlement.recordCheckSnapshot(batchId, snapshot(head, at(2_000), [pendingCheck()]));
  assert.equal(context.settlement.snapshots(batchId)[0].observedAt, at(3_000));
  assert.equal(context.settlement.snapshots(batchId)[0].checks[0].terminal, true);
  assert.throws(() => normalizeCheckSnapshot({
    sha: head,
    observedAt: at(4_000),
    checks: [successfulCheck(1), successfulCheck(1)],
  }), /duplicate check identity/);
}));

test('normalizes terminal commit statuses and incomplete provider queries', () => {
  const terminal = normalizeCheckSnapshot({
    sha: 'a'.repeat(40), observedAt: at(0), checks: [{ provider: 'status', id: 'lint', status: 'failure' }],
  });
  assert.equal(terminal.checks[0].terminal, true);
  const incomplete = normalizeCheckSnapshot({
    sha: 'a'.repeat(40), observedAt: at(0), queryComplete: false, checks: [],
  });
  assert.equal(incomplete.queryComplete, false);
  assert.throws(() => normalizeCheckSnapshot({
    sha: 'a'.repeat(40), observedAt: at(0), checks: Array.from({ length: 1_001 }, () => successfulCheck()),
  }), /bounded limit/);
});
