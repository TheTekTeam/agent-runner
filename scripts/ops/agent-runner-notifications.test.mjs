import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildNotificationContent,
  createDisabledNotificationTransport,
  createSyntheticNotificationTransport,
  discoverNotificationCandidates,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_STATE_SCHEMA_VERSION,
  reconcileNotifications,
} from './agent-runner-notifications.mjs';
import { createStateRecorder } from './claude-runner-cron.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';
import { buildAttentionEvent } from './claude-runner-recovery.mjs';

const REPO = 'TheTekTeam/agent-runner';

async function withState(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-notifications-'));
  const stateDbPath = join(dir, 'state.sqlite');
  const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: REPO });
  try {
    return await fn(state, { dir, stateDbPath });
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedCompletedAttempt(state, { attemptId = 'completed-attempt-1', issueNumber = 100, startedAt = '2026-07-24T10:00:00.000Z', finishedAt = '2026-07-24T10:05:00.000Z', agent = 'claude-code-cli' } = {}) {
  state.invoke('recordRecoveryAttempt', {
    attemptId, repo: REPO, project: 'agent-runner', issueNumber, agent, model: 'claude-sonnet-5', harness: 'claude',
    startedAt, finishedAt, outcome: 'completed', exitCode: 0, recoveryEligible: false, recoveryAction: 'none',
  });
}

function seedAttentionEvent(state, { attemptId = 'attention-attempt-1', issueNumber = 101, startedAt = '2026-07-24T10:00:00.000Z', finishedAt = '2026-07-24T10:01:00.000Z', reason = 'unknown_failure' } = {}) {
  const event = buildAttentionEvent({
    repository: REPO, project: 'agent-runner', issueNumber, attemptId, reason, agent: 'claude-code-cli',
    startedAt, finishedAt, recoveryStatus: 'forbidden', nextAction: 'Manager review.', dashboardReference: `issue-${issueNumber}`,
  });
  state.invoke('upsertAttentionEvent', event);
  return event;
}

function seedQuotaBlocked(state, { resetAt = '2026-07-25T00:00:00.000Z', createdAt = '2026-07-24T10:00:00.000Z' } = {}) {
  state.record('recordQuotaHistory', {
    repo: REPO,
    quotaPreflight: { blocked: true, status: 'exhausted', reason: 'session-quota-exhausted', resetAt },
    createdAt,
  });
}

function seedReassignment(state, { issueNumber = 102, dedupeKey = 'reassign-dedupe-1', toAgentId = 'codex-cli' } = {}) {
  state.invoke('recordRoutingEvent', {
    repo: REPO, issueNumber, eventType: 'reassignment', fromAgentId: 'claude-code-cli', toAgentId,
    reason: 'explicit-agent-ineligible', settingsRevision: 'rev-1', dedupeKey, deliveryStatus: 'resolved',
  });
}

function seedNoQualifiedAgent(state, { issueNumber = 103, dedupeKey = 'no-qualified-dedupe-1' } = {}) {
  state.invoke('recordRoutingEvent', {
    repo: REPO, issueNumber, eventType: 'no-qualified-agent', reason: 'no-qualified-agent',
    settingsRevision: 'rev-1', dedupeKey, deliveryStatus: 'resolved',
  });
}

function seedSystemicPause(state, { reason = 'store unwritable', at = '2026-07-24T10:00:00.000Z' } = {}) {
  state.invoke('openHealthCondition', { repo: REPO, conditionType: 'systemic_pause', reason, safeNextAction: 'Investigate.', at });
}

test('buildNotificationContent only ever returns the closed allowlisted field set', () => {
  const content = buildNotificationContent({
    eventType: 'completed', reasonCode: 'run-completed', repo: REPO, issueNumber: 42, agent: 'claude-code-cli', occurredAt: '2026-07-24T10:00:00.000Z',
  });
  assert.deepEqual(Object.keys(content).sort(), ['agent', 'eventType', 'issueNumber', 'occurredAt', 'reasonCode', 'repo']);
});

test('buildNotificationContent drops an agent id that does not look like a bounded label', () => {
  const content = buildNotificationContent({
    eventType: 'completed', reasonCode: 'run-completed', repo: REPO, issueNumber: 42,
    agent: 'AKIA1234567890ABCDEF/secret+value=', occurredAt: '2026-07-24T10:00:00.000Z',
  });
  assert.equal(content.agent, null);
});

test('each of the six authorized notification states is discovered, persisted pending-first, and delivered', async () => {
  await withState(async (state) => {
    seedCompletedAttempt(state);
    seedAttentionEvent(state);
    seedQuotaBlocked(state);
    seedReassignment(state);
    seedNoQualifiedAgent(state);
    seedSystemicPause(state);

    const { transport, deliveries } = createSyntheticNotificationTransport();
    const summary = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });

    assert.equal(summary.discovered, 6);
    assert.equal(summary.inserted, 6);
    assert.equal(summary.delivered, 6);
    assert.deepEqual(new Set(deliveries.map((d) => d.eventType)), new Set(NOTIFICATION_EVENT_TYPES));

    const rows = state.invoke('allRows', 'notification_events');
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(['delivered', 'resolved'].includes(row.delivery_status), true);
    }
    // completed/agent_reassigned/no_qualified_agent are one-shot: resolved immediately.
    const oneShot = rows.filter((row) => ['completed', 'agent_reassigned', 'no_qualified_agent'].includes(row.event_type));
    assert.equal(oneShot.every((row) => row.delivery_status === 'resolved' && row.resolved_at), true);
    // failed_attention/quota_blocked/systemic_pause are stateful: delivered but not yet resolved.
    const stateful = rows.filter((row) => ['failed_attention', 'quota_blocked', 'systemic_pause'].includes(row.event_type));
    assert.equal(stateful.every((row) => row.delivery_status === 'delivered' && !row.resolved_at), true);
  });
});

test('pending intent is persisted before any delivery attempt is made', async () => {
  await withState(async (state) => {
    seedCompletedAttempt(state);
    let sawPendingBeforeDelivery = false;
    const transport = async (notification) => {
      const rows = state.invoke('allRows', 'notification_events');
      const row = rows.find((r) => r.event_type === notification.eventType);
      // The pending row must already exist (with attempt_count still 0) at
      // the moment the transport is invoked -- proving intent-before-delivery.
      sawPendingBeforeDelivery = Boolean(row) && row.attempt_count === 0 && row.delivered_at === null;
      return { ok: true };
    };
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(sawPendingBeforeDelivery, true);
  });
});

test('a retryable delivery failure moves the row to retryable-failed with a scheduled next attempt', async () => {
  await withState(async (state) => {
    seedAttentionEvent(state);
    const { transport } = createSyntheticNotificationTransport({ fail: () => true, retryable: true });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z', retryBackoffMs: 60_000 });
    const [row] = state.invoke('allRows', 'notification_events');
    assert.equal(row.delivery_status, 'retryable-failed');
    assert.equal(row.attempt_count, 1);
    assert.equal(row.next_attempt_at, '2026-07-24T10:11:00.000Z');
  });
});

test('retries exhaust after max_attempts and are never retried again', async () => {
  await withState(async (state) => {
    seedAttentionEvent(state);
    const { transport } = createSyntheticNotificationTransport({ fail: () => true, retryable: true });
    let tick = 0;
    const now = () => `2026-07-24T10:${String(10 + tick).padStart(2, '0')}:00.000Z`;
    for (let i = 0; i < 3; i += 1) {
      tick += 1;
      // eslint-disable-next-line no-await-in-loop
      await reconcileNotifications({ state, args: { repo: REPO }, transport, now, maxAttempts: 3, retryBackoffMs: 0 });
    }
    const [row] = state.invoke('allRows', 'notification_events');
    assert.equal(row.delivery_status, 'exhausted');
    assert.equal(row.attempt_count, 3);

    // A further pass must not re-attempt an exhausted row.
    const before = state.invoke('allRows', 'notification_events')[0].attempt_count;
    tick += 1;
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now, maxAttempts: 3, retryBackoffMs: 0 });
    const after = state.invoke('allRows', 'notification_events')[0].attempt_count;
    assert.equal(after, before);
  });
});

test('deterministic dedupe: an unchanged repeated reconciliation pass inserts nothing new and re-delivers nothing', async () => {
  await withState(async (state) => {
    seedCompletedAttempt(state);
    seedAttentionEvent(state);
    const { transport, attempts } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    const firstRowCount = state.invoke('allRows', 'notification_events').length;
    const firstAttempts = attempts.length;

    // Second, duplicate scheduler pass over identical source state.
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:15:00.000Z' });
    const secondRowCount = state.invoke('allRows', 'notification_events').length;
    const secondAttempts = attempts.length;

    assert.equal(secondRowCount, firstRowCount, 'no duplicate rows on a repeated pass');
    assert.equal(secondAttempts, firstAttempts, 'no re-delivery for an already-terminal/unchanged row');
  });
});

test('a genuinely new transition after a prior resolved transition is never suppressed by the old dedupe row', async () => {
  await withState(async (state) => {
    seedAttentionEvent(state, { attemptId: 'attention-episode-1', issueNumber: 200 });
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });

    let rows = state.invoke('allRows', 'notification_events');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery_status, 'delivered');

    // The underlying attention resolves.
    state.invoke('resolveAttentionForAttempt', 'attention-episode-1', '2026-07-24T10:20:00.000Z');
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:21:00.000Z' });
    rows = state.invoke('allRows', 'notification_events');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery_status, 'resolved');

    // A genuinely new failure episode on the same issue (different attempt).
    seedAttentionEvent(state, { attemptId: 'attention-episode-2', issueNumber: 200 });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:30:00.000Z' });
    rows = state.invoke('allRows', 'notification_events');
    assert.equal(rows.length, 2, 'the new episode must get its own row, not be suppressed by the resolved one');
    const resolved = rows.find((row) => row.delivery_status === 'resolved');
    const delivered = rows.find((row) => row.delivery_status === 'delivered');
    assert.ok(resolved && delivered);
    assert.notEqual(resolved.source_ref, delivered.source_ref);
  });
});

test('restart/reopen recovery: a pending row persisted before a crash is discovered and delivered after reopening the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-notifications-restart-'));
  const stateDbPath = join(dir, 'state.sqlite');
  try {
    let state = createStateRecorder({ stateDbPath, outputDir: dir, repo: REPO });
    seedCompletedAttempt(state, { attemptId: 'restart-attempt-1', issueNumber: 300 });
    // Simulate a crash between persisting intent and attempting delivery: the
    // discovery+insert step ran, but the process died before the delivery
    // step. Reproduce that by inserting the pending row directly.
    const candidates = discoverNotificationCandidates({ state, repo: REPO });
    const target = candidates.find((c) => c.issueNumber === 300);
    state.invoke('recordNotificationEvent', {
      repo: target.repo, project: target.project, issueNumber: target.issueNumber, eventType: target.eventType,
      reasonCode: target.reasonCode, agent: target.agent, sourceTable: target.sourceTable, sourceRef: target.sourceRef,
      occurredAt: target.occurredAt, dedupeKey: target.dedupeKey, content: { eventType: target.eventType },
    });
    state.close();

    // Restart: fresh store, fresh state wrapper, same DB path.
    state = createStateRecorder({ stateDbPath, outputDir: dir, repo: REPO });
    const { transport, deliveries } = createSyntheticNotificationTransport();
    const summary = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T11:00:00.000Z' });
    assert.equal(summary.inserted, 0, 'the pre-crash row already exists; discovery must not insert a duplicate');
    assert.equal(deliveries.length, 1, 'the still-pending row from before restart must be discovered and delivered');
    const [row] = state.invoke('allRows', 'notification_events');
    assert.equal(row.delivery_status, 'resolved');
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a notification delivery failure leaves queue/claim/run/routing/recovery state completely unchanged', async () => {
  await withState(async (state) => {
    seedAttentionEvent(state, { attemptId: 'no-corruption-attempt', issueNumber: 400 });
    state.record('recordQueueEvent', { repo: REPO, eventType: 'skip', issueNumber: 401, reason: 'unrelated' });
    state.invoke('recordClaim', { repo: REPO, issueNumber: 400, claim: { action: 'claim' } });
    state.record('recordRunResult', { repo: REPO, issueNumber: 400, mode: 'issue-run', exitCode: 1 });

    const before = {
      attention: state.invoke('allRows', 'attention_events'),
      recovery: state.invoke('allRows', 'recovery_attempts'),
      queue: state.invoke('allRows', 'queue_events'),
      claims: state.invoke('allRows', 'claims'),
      runs: state.invoke('allRows', 'run_results'),
      routing: state.invoke('allRows', 'routing_events'),
    };

    const failingTransport = async () => { throw new Error('synthetic transport explosion'); };
    await reconcileNotifications({ state, args: { repo: REPO }, transport: failingTransport, now: () => '2026-07-24T10:10:00.000Z' });

    const after = {
      attention: state.invoke('allRows', 'attention_events'),
      recovery: state.invoke('allRows', 'recovery_attempts'),
      queue: state.invoke('allRows', 'queue_events'),
      claims: state.invoke('allRows', 'claims'),
      runs: state.invoke('allRows', 'run_results'),
      routing: state.invoke('allRows', 'routing_events'),
    };

    assert.deepEqual(after, before);
    assert.equal(state.healthy, true, 'a notification-local transport fault must never flip state.healthy false');
    assert.deepEqual(state.taskErrors.length > 0, true, 'the transport fault is recorded as a task-local error, not swallowed silently');
  });
});

test('an unresolved dashboard attention record stays visible after a notification delivery failure', async () => {
  await withState(async (state) => {
    seedAttentionEvent(state, { attemptId: 'dashboard-visible-attempt', issueNumber: 500 });
    const failingTransport = async () => ({ ok: false, retryable: true, reason: 'synthetic-failure' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport: failingTransport, now: () => '2026-07-24T10:10:00.000Z' });
    const attentionRows = state.invoke('allRows', 'attention_events');
    assert.equal(attentionRows.length, 1);
    assert.equal(attentionRows[0].resolved_at, null, 'unresolved attention must remain unresolved regardless of notification delivery outcome');
  });
});

test('adversarial redaction: secrets, prompts, endpoints, paths, session references, provider text, branch names and comment text never surface in notification content', async () => {
  await withState(async (state) => {
    const adversarialAgent = 'claude-code-cli\nAuthorization: Bearer sk-secret-token-12345';
    state.invoke('recordRecoveryAttempt', {
      attemptId: 'adversarial-attempt-1', repo: REPO, project: 'agent-runner', issueNumber: 600,
      agent: adversarialAgent, model: 'claude-sonnet-5', harness: 'claude',
      startedAt: '2026-07-24T10:00:00.000Z', finishedAt: '2026-07-24T10:01:00.000Z', outcome: 'completed', exitCode: 0,
    });
    const adversarialEvent = buildAttentionEvent({
      repository: REPO, project: 'agent-runner', issueNumber: 601, attemptId: 'adversarial-attempt-2',
      reason: 'unknown_failure', agent: 'claude-code-cli',
      startedAt: '2026-07-24T10:00:00.000Z', finishedAt: '2026-07-24T10:01:00.000Z', recoveryStatus: 'forbidden',
      nextAction: 'See branch claude/secret-feature-42 and /home/user/.ssh/id_rsa; comment: "sk-live-abcdef reset password to hunter2"',
      dashboardReference: 'https://internal.example/secret-endpoint?token=abc123',
    });
    state.invoke('upsertAttentionEvent', adversarialEvent);

    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });

    const serialized = JSON.stringify(deliveries);
    for (const forbidden of [
      'Bearer', 'sk-secret-token', 'sk-live-abcdef', 'hunter2', 'id_rsa', '.ssh',
      'claude/secret-feature-42', 'internal.example', 'token=abc123', 'Retry after', 'reset password',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `adversarial content leaked: ${forbidden}`);
    }
    // The adversarial agent id must have been dropped entirely (fails the bounded label pattern).
    for (const delivery of deliveries) {
      if (delivery.agent) assert.match(delivery.agent, /^[a-z][a-z0-9._-]{0,63}$/);
    }
  });
});

test('new SQLite columns on notification_events are excluded from dashboard output until positively allowlisted', async () => {
  await withState(async (state, { stateDbPath }) => {
    seedCompletedAttempt(state);
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    state.close();

    const { buildRunnerDashboard } = await import('./claude-runner-dashboard-api.mjs');
    const dashboard = buildRunnerDashboard(stateDbPath);
    assert.equal(dashboard.latest.notifications.length, 1);
    const exposed = dashboard.latest.notifications[0];
    for (const forbiddenKey of ['dedupe_key', 'source_table', 'source_ref', 'content_json', 'last_error', 'payload_json']) {
      assert.equal(Object.prototype.hasOwnProperty.call(exposed, forbiddenKey), false, `${forbiddenKey} must not reach dashboard output`);
    }
    // re-open a plain store to keep the withState() finally-block close() a no-op double-close-safe path.
    const reopened = openRunnerStateStore(stateDbPath);
    reopened.close();
  });
});

test('the default transport is disabled and makes no real delivery', async () => {
  const transport = createDisabledNotificationTransport();
  const result = await transport({ eventType: 'completed' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'transport-disabled');
});

test('reconcileNotifications never throws even when the transport throws synchronously', async () => {
  await withState(async (state) => {
    seedCompletedAttempt(state);
    const throwingTransport = () => { throw new Error('boom'); };
    await assert.doesNotReject(reconcileNotifications({ state, args: { repo: REPO }, transport: throwingTransport, now: () => '2026-07-24T10:10:00.000Z' }));
  });
});

test('NOTIFICATION_STATE_SCHEMA_VERSION is a stable positive integer', () => {
  assert.equal(Number.isInteger(NOTIFICATION_STATE_SCHEMA_VERSION), true);
  assert.equal(NOTIFICATION_STATE_SCHEMA_VERSION >= 1, true);
});
