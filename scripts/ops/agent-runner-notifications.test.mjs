import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildNotificationContent,
  createDisabledNotificationTransport,
  createSyntheticNotificationTransport,
  DELIVERY_REASON_CODES,
  FAILURE_NOTIFY_OUTCOMES,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_STATE_SCHEMA_VERSION,
  reconcileNotifications,
} from './agent-runner-notifications.mjs';
import { createStateRecorder } from './claude-runner-cron.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';
import { buildAttentionEvent } from './claude-runner-recovery.mjs';

const REPO = 'TheTekTeam/agent-runner';
const OTHER_REPO = 'TheTekTeam/modelspend';

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

/** Activates the cursor-based sources (attention_events/routing_events/recovery_attempts) against whatever currently exists, so later-seeded rows are the only ones a real pass will ever see. */
async function activateCursors(state, repo = REPO, now = () => '2020-01-01T00:00:00.000Z') {
  await reconcileNotifications({ state, args: { repo }, transport: createDisabledNotificationTransport(), now });
}

function seedCompletedAttempt(state, { attemptId = 'completed-attempt-1', repo = REPO, issueNumber = 100, startedAt = '2026-07-24T10:00:00.000Z', finishedAt = '2026-07-24T10:05:00.000Z', agent = 'claude-code-cli' } = {}) {
  state.invoke('recordRecoveryAttempt', {
    attemptId, repo, project: 'agent-runner', issueNumber, agent, model: 'claude-sonnet-5', harness: 'claude',
    startedAt, finishedAt, outcome: 'completed', exitCode: 0, recoveryEligible: false, recoveryAction: 'none', resolutionState: 'resolved',
  });
}

function seedFailedAttemptWithoutAttention(state, {
  attemptId = 'failed-attempt-1', repo = REPO, issueNumber = 105, startedAt = '2026-07-24T10:00:00.000Z', finishedAt = '2026-07-24T10:01:00.000Z',
  outcome = 'permission_or_auth_failure', recoveryEligible = false, resolutionState = 'unresolved', attentionDedupeKey = null,
} = {}) {
  state.invoke('recordRecoveryAttempt', {
    attemptId, repo, project: 'agent-runner', issueNumber, agent: 'claude-code-cli', model: 'claude-sonnet-5', harness: 'claude',
    startedAt, finishedAt, outcome, exitCode: 1, recoveryEligible, resolutionState, attentionDedupeKey,
  });
}

function seedAttentionEvent(state, { attemptId = 'attention-attempt-1', repo = REPO, issueNumber = 101, startedAt = '2026-07-24T10:00:00.000Z', finishedAt = '2026-07-24T10:01:00.000Z', reason = 'unknown_failure' } = {}) {
  const event = buildAttentionEvent({
    repository: repo, project: 'agent-runner', issueNumber, attemptId, reason, agent: 'claude-code-cli',
    startedAt, finishedAt, recoveryStatus: 'forbidden', nextAction: 'Manager review.', dashboardReference: `issue-${issueNumber}`,
  });
  state.invoke('upsertAttentionEvent', event);
  return event;
}

function seedQuotaBlocked(state, { repo = REPO, resetAt = '2026-07-25T00:00:00.000Z', createdAt = '2026-07-24T10:00:00.000Z' } = {}) {
  state.record('recordQuotaHistory', {
    repo, quotaPreflight: { blocked: true, status: 'exhausted', reason: 'session-quota-exhausted', resetAt }, createdAt,
  });
}

function seedQuotaAvailable(state, { repo = REPO, createdAt = '2026-07-24T10:00:00.000Z' } = {}) {
  state.record('recordQuotaHistory', { repo, quotaPreflight: { blocked: false, status: 'available' }, createdAt });
}

function seedReassignment(state, { repo = REPO, issueNumber = 102, dedupeKey = 'reassign-dedupe-1', toAgentId = 'codex-cli', deliveryStatus = 'resolved' } = {}) {
  state.invoke('recordRoutingEvent', {
    repo, issueNumber, eventType: 'reassignment', fromAgentId: 'claude-code-cli', toAgentId,
    reason: 'explicit-agent-ineligible', settingsRevision: 'rev-1', dedupeKey, deliveryStatus,
  });
}

function seedNoQualifiedAgent(state, { repo = REPO, issueNumber = 103, dedupeKey = 'no-qualified-dedupe-1', deliveryStatus = 'resolved' } = {}) {
  state.invoke('recordRoutingEvent', {
    repo, issueNumber, eventType: 'no-qualified-agent', reason: 'no-qualified-agent', settingsRevision: 'rev-1', dedupeKey, deliveryStatus,
  });
}

function seedSystemicPause(state, { repo = REPO, reason = 'store unwritable', at = '2026-07-24T10:00:00.000Z', conditionType = 'systemic_pause' } = {}) {
  state.invoke('openHealthCondition', { repo, conditionType, reason, safeNextAction: 'Investigate.', at });
}

function notificationRows(state) {
  return state.invoke('allRows', 'notification_events');
}

// ---------------------------------------------------------------------------
// buildNotificationContent: closed allowlist + validation
// ---------------------------------------------------------------------------

test('buildNotificationContent only ever returns the closed allowlisted field set', () => {
  const content = buildNotificationContent({
    eventType: 'completed', reasonCode: 'run-completed', repo: REPO, issueNumber: 42, agent: 'claude-code-cli', occurredAt: '2026-07-24T10:00:00.000Z',
  });
  assert.deepEqual(Object.keys(content).sort(), ['agent', 'eventType', 'issueNumber', 'occurredAt', 'reasonCode', 'repo']);
});

test('buildNotificationContent rejects an unrecognized event type, reason code, malformed repo, or malformed timestamp', () => {
  const base = { eventType: 'completed', reasonCode: 'run-completed', repo: REPO, issueNumber: 1, agent: null, occurredAt: '2026-07-24T10:00:00.000Z' };
  assert.equal(buildNotificationContent({ ...base, eventType: 'not-a-real-type' }), null);
  assert.equal(buildNotificationContent({ ...base, reasonCode: 'not-a-real-reason' }), null);
  assert.equal(buildNotificationContent({ ...base, repo: 'not a repo slug' }), null);
  assert.equal(buildNotificationContent({ ...base, occurredAt: 'not-a-timestamp' }), null);
  assert.equal(buildNotificationContent({ ...base, issueNumber: 'forty-two' }), null);
  assert.ok(buildNotificationContent(base));
});

test('buildNotificationContent drops/rejects an agent id that does not look like a bounded label', () => {
  const base = { eventType: 'completed', reasonCode: 'run-completed', repo: REPO, issueNumber: 42, occurredAt: '2026-07-24T10:00:00.000Z' };
  assert.equal(buildNotificationContent({ ...base, agent: 'AKIA1234567890ABCDEF/secret+value=' }), null);
  assert.equal(buildNotificationContent({ ...base, agent: null }).agent, null);
});

// ---------------------------------------------------------------------------
// Six authorized states, end to end
// ---------------------------------------------------------------------------

test('each of the six authorized notification states is discovered (after cursor activation), persisted pending-first, and delivered', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedCompletedAttempt(state);
    seedAttentionEvent(state);
    seedQuotaBlocked(state);
    seedReassignment(state);
    seedNoQualifiedAgent(state);
    seedSystemicPause(state);

    const { transport, deliveries } = createSyntheticNotificationTransport();
    const summary = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });

    assert.equal(summary.inserted, 6);
    assert.equal(summary.delivered, 6);
    assert.deepEqual(new Set(deliveries.map((d) => d.eventType)), new Set(NOTIFICATION_EVENT_TYPES));
    for (const delivery of deliveries) assert.equal(delivery.idempotencyKey.length, 64, 'a stable sha256 idempotency key accompanies every delivery');

    const rows = notificationRows(state);
    assert.equal(rows.length, 6);
    const oneShot = rows.filter((row) => ['completed', 'agent_reassigned', 'no_qualified_agent'].includes(row.event_type));
    assert.equal(oneShot.every((row) => row.delivery_status === 'resolved' && row.resolved_at), true);
    const stateful = rows.filter((row) => ['failed_attention', 'quota_blocked', 'systemic_pause'].includes(row.event_type));
    assert.equal(stateful.every((row) => row.delivery_status === 'delivered' && !row.resolved_at), true);
  });
});

// ---------------------------------------------------------------------------
// Item 1: disabled/paused transport must pause, not exhaust; non-retryable
// must exhaust in one call.
// ---------------------------------------------------------------------------

test('the default (disabled) transport pauses delivery indefinitely -- repeated ordinary passes never consume an attempt or exhaust the row', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedCompletedAttempt(state);
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await reconcileNotifications({ state, args: { repo: REPO }, now: () => `2026-07-24T10:${String(10 + i).padStart(2, '0')}:00.000Z` });
    }
    const [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'pending');
    assert.equal(row.attempt_count, 0);
    assert.equal(row.last_error, null);

    // A real transport enabled later can still deliver it.
    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:20:00.000Z' });
    assert.equal(deliveries.length, 1);
  });
});

test('a non-retryable delivery failure exhausts the row in one call, never entering retryable-failed first', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state);
    const { transport } = createSyntheticNotificationTransport({ fail: () => true, retryable: false });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    const [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'exhausted');
    assert.equal(row.attempt_count, 1);
    assert.equal(DELIVERY_REASON_CODES.includes(row.last_error), true);
  });
});

test('a retryable delivery failure moves the row to retryable-failed with a scheduled next attempt', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state);
    const { transport } = createSyntheticNotificationTransport({ fail: () => true, retryable: true });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z', retryBackoffMs: 60_000 });
    const [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'retryable-failed');
    assert.equal(row.attempt_count, 1);
    assert.equal(row.next_attempt_at, '2026-07-24T10:11:00.000Z');
  });
});

test('retries exhaust after max_attempts and are never retried again', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state);
    const { transport } = createSyntheticNotificationTransport({ fail: () => true, retryable: true });
    let tick = 0;
    const now = () => `2026-07-24T10:${String(10 + tick).padStart(2, '0')}:00.000Z`;
    for (let i = 0; i < 3; i += 1) {
      tick += 1;
      // eslint-disable-next-line no-await-in-loop
      await reconcileNotifications({ state, args: { repo: REPO }, transport, now, maxAttempts: 3, retryBackoffMs: 0 });
    }
    const [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'exhausted');
    assert.equal(row.attempt_count, 3);
    const before = notificationRows(state)[0].attempt_count;
    tick += 1;
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now, maxAttempts: 3, retryBackoffMs: 0 });
    assert.equal(notificationRows(state)[0].attempt_count, before);
  });
});

test('the same stable idempotency key (the dedupe_key) is handed to the transport on every retry attempt', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state);
    const { transport, attempts } = createSyntheticNotificationTransport({ fail: (n, count) => count < 3, retryable: true });
    let tick = 0;
    const now = () => `2026-07-24T10:${String(10 + tick).padStart(2, '0')}:00.000Z`;
    for (let i = 0; i < 3; i += 1) {
      tick += 1;
      // eslint-disable-next-line no-await-in-loop
      await reconcileNotifications({ state, args: { repo: REPO }, transport, now, retryBackoffMs: 0 });
    }
    assert.equal(attempts.length, 3);
    const keys = new Set(attempts.map((a) => a.idempotencyKey));
    assert.equal(keys.size, 1, 'every retry/restart must reuse the exact same idempotency key');
    assert.equal([...keys][0], notificationRows(state)[0].dedupe_key);
  });
});

// ---------------------------------------------------------------------------
// Item 2: crash-safe in-flight delivery ownership.
// ---------------------------------------------------------------------------

test('a stale in-flight row (a prior process crashed mid-delivery) is recovered onto the same identity and redelivered with the same idempotency key', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedCompletedAttempt(state);
    // Create the pending row (disabled transport leaves it pending, untouched).
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z' });
    let [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'pending');
    // Simulate a crash: a prior process claimed the row for delivery, then died before completing it.
    state.invoke('claimNotificationForDelivery', { dedupeKey: row.dedupe_key, owner: 'crashed-process', at: '2026-07-24T10:10:00.000Z' });
    row = notificationRows(state)[0];
    assert.equal(row.delivery_status, 'in-flight');

    const { transport, deliveries } = createSyntheticNotificationTransport();
    const summary = await reconcileNotifications({
      state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:20:00.000Z', staleInFlightMs: 60_000,
    });
    assert.equal(summary.staleRecovered, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].idempotencyKey, row.dedupe_key);
    assert.equal(notificationRows(state)[0].delivery_status, 'resolved');
  });
});

test('a never-resolving transport is bounded by the delivery timeout, and the pass returns promptly (#53 review, item 5)', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state);
    const hungTransport = () => new Promise(() => {}); // never resolves
    const startedAt = Date.now();
    await reconcileNotifications({ state, args: { repo: REPO }, transport: hungTransport, now: () => '2026-07-24T10:10:00.000Z', deliveryTimeoutMs: 50 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(elapsedMs < 2000, true, `reconcileNotifications must return promptly even with a hung transport (took ${elapsedMs}ms)`);
    const [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'retryable-failed', 'a timed-out delivery must release ownership, never stay stuck in-flight');
    assert.equal(row.last_error, 'transport-timeout');
  });
});

test('the total pass duration is bounded, so many due rows cannot starve the caller\'s serial lock', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    for (let i = 0; i < 5; i += 1) seedAttentionEvent(state, { attemptId: `slow-attempt-${i}`, issueNumber: 200 + i });
    const slowTransport = () => new Promise((resolve) => { setTimeout(() => resolve({ ok: true }), 40); });
    const startedAt = Date.now();
    await reconcileNotifications({
      state, args: { repo: REPO }, transport: slowTransport, now: () => '2026-07-24T10:10:00.000Z', maxPassDurationMs: 60,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(elapsedMs < 500, true, `a bounded max pass duration must cap total delivery time (took ${elapsedMs}ms)`);
  });
});

// ---------------------------------------------------------------------------
// Item 3: source-mapping correctness.
// ---------------------------------------------------------------------------

test('a mutation-pending routing event never announces a reassignment; once proven applied it is notified on a later pass', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedReassignment(state, { dedupeKey: 'pending-reassign-1', deliveryStatus: 'mutation-pending' });
    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(notificationRows(state).length, 0, 'a mutation-pending row must never announce a reassignment');

    state.invoke('updateRoutingEventDeliveryStatus', { dedupeKey: 'pending-reassign-1', deliveryStatus: 'evidence-pending' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:20:00.000Z' });
    assert.equal(notificationRows(state).length, 1, 'once proven applied, the reassignment must be notified on a later pass');
    assert.equal(deliveries.length, 1);
  });
});

test('an unrecognized runner_health_conditions condition type is never notified (closed mapping, no generic fallback)', async () => {
  await withState(async (state) => {
    seedSystemicPause(state, { conditionType: 'some_future_condition_type', at: '2026-07-24T10:00:00.000Z' });
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(notificationRows(state).length, 0);
  });
});

test('an older systemic_pause episode is not falsely resolved, and is not kept unresolved forever, by a later episode of the same condition type', async () => {
  await withState(async (state) => {
    seedSystemicPause(state, { at: '2026-07-24T09:00:00.000Z' });
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T09:05:00.000Z' });
    const firstRow = notificationRows(state)[0];
    assert.equal(firstRow.delivery_status, 'delivered');

    // Episode A resolves, then episode B reopens (same condition_type) before
    // this module ever gets a chance to notice A's resolution.
    state.record('resolveHealthCondition', { repo: REPO, conditionType: 'systemic_pause', at: '2026-07-24T09:10:00.000Z' });
    seedSystemicPause(state, { at: '2026-07-24T09:20:00.000Z' }); // reopens -- new opened_at

    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T09:25:00.000Z' });
    const rows = notificationRows(state);
    assert.equal(rows.length, 2, 'episode B must get its own row, not be suppressed by episode A');
    const episodeARow = rows.find((r) => r.dedupe_key === firstRow.dedupe_key);
    assert.equal(episodeARow.delivery_status, 'resolved', 'episode A must resolve once episode B has strictly superseded it, not stay stuck forever');
    const episodeBRow = rows.find((r) => r.dedupe_key !== firstRow.dedupe_key);
    assert.equal(episodeBRow.delivery_status, 'delivered');
    assert.equal(episodeBRow.resolved_at, null, 'episode B (still open) must not be falsely resolved by episode A\'s resolution');
  });
});

test('quota discovery is repository-scoped: a blocked poll for one repo never suppresses or is suppressed by another repo\'s state', async () => {
  await withState(async (state) => {
    seedQuotaBlocked(state, { repo: OTHER_REPO, resetAt: '2026-07-26T00:00:00.000Z', createdAt: '2026-07-24T09:00:00.000Z' });
    seedQuotaAvailable(state, { repo: REPO, createdAt: '2026-07-24T09:30:00.000Z' }); // latest row for REPO is NOT blocked
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:00:00.000Z' });
    assert.equal(notificationRows(state).filter((r) => r.repo === REPO).length, 0, 'REPO must not be notified from OTHER_REPO\'s blocked state');

    await reconcileNotifications({ state, args: { repo: OTHER_REPO }, transport, now: () => '2026-07-24T10:00:00.000Z' });
    assert.equal(notificationRows(state).filter((r) => r.repo === OTHER_REPO).length, 1, 'OTHER_REPO\'s own blocked episode must still be notified');
  });
});

test('quota discovery is occurrence-specific: a second blocked episode (even with no distinct reset timestamp) is not suppressed by an "unspecified" bucket', async () => {
  await withState(async (state) => {
    const { transport } = createSyntheticNotificationTransport();
    seedQuotaBlocked(state, { resetAt: null, createdAt: '2026-07-24T09:00:00.000Z' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T09:05:00.000Z' });
    const firstEpisode = notificationRows(state)[0];
    assert.equal(firstEpisode.delivery_status, 'delivered');

    // Quota clears, then blocks again -- also with no reset timestamp.
    seedQuotaAvailable(state, { createdAt: '2026-07-24T09:30:00.000Z' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T09:35:00.000Z' });
    assert.equal(notificationRows(state)[0].delivery_status, 'resolved', 'the first episode must resolve once quota clears');

    seedQuotaBlocked(state, { resetAt: null, createdAt: '2026-07-24T10:00:00.000Z' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z' });
    const rows = notificationRows(state).filter((r) => r.event_type === 'quota_blocked');
    assert.equal(rows.length, 2, 'a genuinely new blocked episode must never be suppressed by the earlier resolved one');
  });
});

test('a genuine task failure with no attention_events tracking (a closed FAILURE_NOTIFY_OUTCOMES member) is notified once no further retry is eligible', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    assert.equal(FAILURE_NOTIFY_OUTCOMES.includes('permission_or_auth_failure'), true);
    assert.equal(FAILURE_NOTIFY_OUTCOMES.includes('completed'), false);
    assert.equal(FAILURE_NOTIFY_OUTCOMES.includes('quota_paused'), false);

    seedFailedAttemptWithoutAttention(state, { attemptId: 'still-retrying', recoveryEligible: true });
    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(notificationRows(state).length, 0, 'a still-retry-eligible failure is not yet "attention required"');

    // The same attempt row updates in place once retries are exhausted.
    seedFailedAttemptWithoutAttention(state, { attemptId: 'still-retrying', recoveryEligible: false });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:20:00.000Z' });
    assert.equal(notificationRows(state).length, 1, 'once retries are exhausted the SAME row must still be notified, not silently missed');
    assert.equal(deliveries[0].eventType, 'failed_attention');
  });
});

test('a genuine task failure whose attempt already has an attention_events row is never double-notified', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    const attemptId = 'double-notify-attempt';
    seedFailedAttemptWithoutAttention(state, { attemptId, outcome: 'unknown_failure', recoveryEligible: false, attentionDedupeKey: 'attn-dedupe-double' });
    seedAttentionEvent(state, { attemptId, issueNumber: 105, reason: 'unknown_failure' });
    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    const failureNotifications = notificationRows(state).filter((row) => row.event_type === 'failed_attention');
    assert.equal(failureNotifications.length, 1, 'exactly one notification, from the attention_events source, never two');
    assert.equal(deliveries.filter((d) => d.eventType === 'failed_attention').length, 1);
  });
});

// ---------------------------------------------------------------------------
// Item 3 continued: do not create misleading notifications for already-
// resolved historical conditions.
// ---------------------------------------------------------------------------

test('an attention_events row that is already resolved before this module ever sees it is never notified', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state, { attemptId: 'already-resolved-attempt' });
    state.invoke('resolveAttentionForAttempt', 'already-resolved-attempt', '2026-07-24T10:05:00.000Z');
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(notificationRows(state).length, 0);
  });
});

test('a runner_health_conditions episode that is already resolved before this module ever sees it is never notified', async () => {
  await withState(async (state) => {
    seedSystemicPause(state, { at: '2026-07-24T09:00:00.000Z' });
    state.record('resolveHealthCondition', { repo: REPO, conditionType: 'systemic_pause', at: '2026-07-24T09:05:00.000Z' });
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(notificationRows(state).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Item 4: activation cursor -- bounded, no historical flood.
// ---------------------------------------------------------------------------

test('deploying against a database with substantial pre-existing history does not flood notifications -- only post-activation occurrences are ever notified', async () => {
  await withState(async (state) => {
    // Substantial pre-existing history, seeded BEFORE this outbox ever activates.
    for (let i = 0; i < 40; i += 1) {
      seedCompletedAttempt(state, { attemptId: `historical-completed-${i}`, issueNumber: 1000 + i, startedAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`, finishedAt: `2026-01-01T00:${String(i).padStart(2, '0')}:30.000Z` });
      seedAttentionEvent(state, { attemptId: `historical-attention-${i}`, issueNumber: 2000 + i, startedAt: `2026-01-01T01:${String(i).padStart(2, '0')}:00.000Z`, finishedAt: `2026-01-01T01:${String(i).padStart(2, '0')}:30.000Z` });
    }

    const { transport, deliveries } = createSyntheticNotificationTransport();
    const activationSummary = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:00:00.000Z' });
    assert.equal(activationSummary.inserted, 0, 'the very first pass must only activate cursors, never backfill existing history');
    assert.equal(notificationRows(state).length, 0);
    assert.equal(deliveries.length, 0);

    // Only a genuinely new, post-activation occurrence is ever notified.
    seedCompletedAttempt(state, { attemptId: 'post-activation-completed', issueNumber: 9000 });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(notificationRows(state).length, 1);
    assert.equal(deliveries[0].issueNumber, 9000);
  });
});

test('a bounded batch size processes a large post-activation backlog across multiple passes without unbounded work in one pass', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    for (let i = 0; i < 30; i += 1) {
      seedCompletedAttempt(state, { attemptId: `bulk-completed-${i}`, issueNumber: 3000 + i, startedAt: `2026-07-24T11:${String(i).padStart(2, '0')}:00.000Z`, finishedAt: `2026-07-24T11:${String(i).padStart(2, '0')}:30.000Z` });
    }
    const { transport } = createSyntheticNotificationTransport();
    const firstPass = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T12:00:00.000Z', batchSize: 10 });
    assert.equal(firstPass.inserted, 10, 'exactly one bounded batch is processed per pass');
    const secondPass = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T12:01:00.000Z', batchSize: 10 });
    assert.equal(secondPass.inserted, 10);
    const thirdPass = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T12:02:00.000Z', batchSize: 10 });
    assert.equal(thirdPass.inserted, 10);
    assert.equal(notificationRows(state).length, 30);
  });
});

// ---------------------------------------------------------------------------
// Deterministic dedupe / duplicate scheduler pass / restart-safety
// ---------------------------------------------------------------------------

test('deterministic dedupe: an unchanged repeated reconciliation pass inserts nothing new and re-delivers nothing', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedCompletedAttempt(state);
    seedAttentionEvent(state);
    const { transport, attempts } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    const firstRowCount = notificationRows(state).length;
    const firstAttempts = attempts.length;

    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:15:00.000Z' });
    assert.equal(notificationRows(state).length, firstRowCount, 'no duplicate rows on a repeated pass');
    assert.equal(attempts.length, firstAttempts, 'no re-delivery for an already-terminal/unchanged row');
  });
});

test('a genuinely new transition after a prior resolved transition is never suppressed by the old dedupe row', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state, { attemptId: 'attention-episode-1', issueNumber: 200 });
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    let rows = notificationRows(state);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery_status, 'delivered');

    state.invoke('resolveAttentionForAttempt', 'attention-episode-1', '2026-07-24T10:20:00.000Z');
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:21:00.000Z' });
    rows = notificationRows(state);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery_status, 'resolved');

    seedAttentionEvent(state, { attemptId: 'attention-episode-2', issueNumber: 200 });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:30:00.000Z' });
    rows = notificationRows(state);
    assert.equal(rows.length, 2, 'the new episode must get its own row, not be suppressed by the resolved one');
  });
});

test('restart/reopen recovery: a pending row persisted before a crash is discovered and delivered after reopening the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-notifications-restart-'));
  const stateDbPath = join(dir, 'state.sqlite');
  try {
    let state = createStateRecorder({ stateDbPath, outputDir: dir, repo: REPO });
    await activateCursors(state);
    seedCompletedAttempt(state, { attemptId: 'restart-attempt-1', issueNumber: 300 });
    // Simulate a crash between the discovery+insert step and the delivery
    // step by running one reconciliation pass with a transport that throws
    // synchronously, leaving the row retryable-failed/pending.
    await reconcileNotifications({ state, args: { repo: REPO }, transport: () => { throw new Error('simulated crash'); }, now: () => '2026-07-24T10:05:00.000Z' });
    state.close();

    state = createStateRecorder({ stateDbPath, outputDir: dir, repo: REPO });
    const { transport, deliveries } = createSyntheticNotificationTransport();
    const summary = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T11:00:00.000Z' });
    assert.equal(summary.inserted, 0, 'the pre-crash row already exists; discovery must not insert a duplicate');
    assert.equal(deliveries.length, 1, 'the still-pending/retryable row from before restart must be discovered and delivered');
    assert.equal(notificationRows(state)[0].delivery_status, 'resolved');
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Failure isolation / no queue-state corruption
// ---------------------------------------------------------------------------

test('a notification delivery failure leaves queue/claim/run/routing/recovery state completely unchanged', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state, { attemptId: 'no-corruption-attempt', issueNumber: 400 });
    state.record('recordQueueEvent', { repo: REPO, eventType: 'skip', issueNumber: 401, reason: 'unrelated' });
    state.invoke('recordClaim', { repo: REPO, issueNumber: 400, claim: { action: 'claim' } });
    state.record('recordRunResult', { repo: REPO, issueNumber: 400, mode: 'issue-run', exitCode: 1 });

    const before = {
      attention: state.invoke('allRows', 'attention_events'), recovery: state.invoke('allRows', 'recovery_attempts'),
      queue: state.invoke('allRows', 'queue_events'), claims: state.invoke('allRows', 'claims'),
      runs: state.invoke('allRows', 'run_results'), routing: state.invoke('allRows', 'routing_events'),
    };

    await reconcileNotifications({ state, args: { repo: REPO }, transport: async () => { throw new Error('synthetic transport explosion'); }, now: () => '2026-07-24T10:10:00.000Z' });

    const after = {
      attention: state.invoke('allRows', 'attention_events'), recovery: state.invoke('allRows', 'recovery_attempts'),
      queue: state.invoke('allRows', 'queue_events'), claims: state.invoke('allRows', 'claims'),
      runs: state.invoke('allRows', 'run_results'), routing: state.invoke('allRows', 'routing_events'),
    };

    assert.deepEqual(after, before);
    assert.equal(state.healthy, true, 'a notification-local transport fault must never flip state.healthy false');
    assert.equal(state.taskErrors.length > 0, true);
    for (const taskError of state.taskErrors) {
      assert.equal(taskError.message.includes('synthetic transport explosion'), false, 'the raw exception message must never be recorded');
    }
  });
});

test('an unresolved dashboard attention record stays visible after a notification delivery failure', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state, { attemptId: 'dashboard-visible-attempt', issueNumber: 500 });
    const failingTransport = async () => ({ ok: false, retryable: true, reasonCode: 'transport-rejected-retryable' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport: failingTransport, now: () => '2026-07-24T10:10:00.000Z' });
    const attentionRows = state.invoke('allRows', 'attention_events');
    assert.equal(attentionRows.length, 1);
    assert.equal(attentionRows[0].resolved_at, null);
  });
});

// ---------------------------------------------------------------------------
// Item 6: content rebuilt from validated columns, not trusted content_json.
// ---------------------------------------------------------------------------

test('delivery content is rebuilt from validated columns -- a tampered/corrupt content_json is never trusted or delivered', async () => {
  await withState(async (state, { stateDbPath }) => {
    await activateCursors(state);
    seedCompletedAttempt(state, { issueNumber: 700 });
    // Persist the pending row (disabled transport: created, not yet delivered).
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z' });
    assert.equal(notificationRows(state)[0].delivery_status, 'pending');
    state.close();

    // Tamper with content_json directly, as if the row were corrupted.
    const raw = openRunnerStateStore(stateDbPath);
    raw.db.prepare("UPDATE notification_events SET content_json = '{\"eventType\":\"completed\",\"reasonCode\":\"run-completed\",\"repo\":\"TheTekTeam/agent-runner\",\"issueNumber\":700,\"agent\":null,\"occurredAt\":\"2026-07-24T10:00:00.000Z\",\"injected\":\"sk-secret-should-never-appear\"}'").run();
    raw.close();

    const reopened = createStateRecorder({ stateDbPath, outputDir: '/tmp', repo: REPO });
    try {
      const { transport, deliveries } = createSyntheticNotificationTransport();
      await reconcileNotifications({ state: reopened, args: { repo: REPO }, transport, now: () => '2026-07-24T10:20:00.000Z' });
      assert.equal(deliveries.length, 1);
      assert.equal(Object.prototype.hasOwnProperty.call(deliveries[0], 'injected'), false, 'a field only present in the tampered content_json must never reach the transport');
      assert.deepEqual(Object.keys(deliveries[0]).sort(), ['agent', 'eventType', 'idempotencyKey', 'issueNumber', 'occurredAt', 'reasonCode', 'repo']);
    } finally {
      reopened.close();
    }
  });
});

test('a row whose columns fail validation is never delivered, and is marked exhausted with a fixed reason code rather than reaching a transport', async () => {
  await withState(async (state, { stateDbPath }) => {
    await activateCursors(state);
    seedCompletedAttempt(state, { issueNumber: 701 });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z' });
    assert.equal(notificationRows(state)[0].delivery_status, 'pending');
    state.close();

    const raw = openRunnerStateStore(stateDbPath);
    const changes = raw.db.prepare("UPDATE notification_events SET repo = 'not a valid repo slug!!'").run();
    assert.equal(changes.changes, 1);
    raw.close();

    const reopened = createStateRecorder({ stateDbPath, outputDir: '/tmp', repo: REPO });
    try {
      const { transport, deliveries } = createSyntheticNotificationTransport();
      await reconcileNotifications({ state: reopened, args: { repo: 'not a valid repo slug!!' }, transport, now: () => '2026-07-24T10:20:00.000Z' });
      assert.equal(deliveries.length, 0);
      const [row] = reopened.invoke('allRows', 'notification_events');
      assert.equal(row.delivery_status, 'exhausted');
      assert.equal(row.last_error, 'transport-rejected-permanent');
    } finally {
      reopened.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Item 7: every conditional SQLite transition verified before reporting success.
// ---------------------------------------------------------------------------

test('a transport success whose durable delivered-state write does not apply is never counted as delivered, and is recorded as a fixed local diagnostic', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedCompletedAttempt(state);
    const fakeState = {
      healthy: true,
      taskErrors: [],
      recordTaskError(stage, error) { this.taskErrors.push({ stage, message: String(error?.message || error) }); },
      invoke(method, ...args) {
        if (method === 'markNotificationDelivered') return false; // simulate the conditional write not applying
        return state.invoke(method, ...args);
      },
    };
    const { transport, deliveries } = createSyntheticNotificationTransport();
    const summary = await reconcileNotifications({ state: fakeState, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(deliveries.length, 1, 'the transport itself did succeed');
    assert.equal(summary.delivered, 0, 'but an unproven durable write must never be counted as delivered');
    assert.equal(fakeState.taskErrors.some((e) => e.message === 'state-transition-mismatch'), true);
  });
});

// ---------------------------------------------------------------------------
// Item 8: schema/config bounds; malformed source rows fail closed, not systemic.
// ---------------------------------------------------------------------------

test('an out-of-range configured maxAttempts/batchSize/timeout is clamped to a bounded default rather than accepted verbatim', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state);
    const { transport } = createSyntheticNotificationTransport({ fail: () => true, retryable: true });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z', maxAttempts: 100_000, retryBackoffMs: 0 });
    const [row] = notificationRows(state);
    assert.equal(row.max_attempts <= 20, true, 'max_attempts must be clamped, matching the schema CHECK constraint bound');
  });
});

test('creating a notification_events row with an out-of-vocabulary event_type/reason_code/delivery_status is rejected by the schema CHECK constraints', async () => {
  await withState(async (state, { stateDbPath }) => {
    state.close();
    const raw = openRunnerStateStore(stateDbPath);
    assert.throws(() => raw.recordNotificationEvent({
      repo: REPO, eventType: 'not-a-real-type', reasonCode: 'run-completed', sourceTable: 'recovery_attempts', sourceRef: 'x', occurredAt: '2026-07-24T10:00:00.000Z', dedupeKey: 'bad-1',
    }), /CHECK constraint failed/);
    assert.throws(() => raw.recordNotificationEvent({
      repo: REPO, eventType: 'completed', reasonCode: 'not-a-real-reason', sourceTable: 'recovery_attempts', sourceRef: 'x', occurredAt: '2026-07-24T10:00:00.000Z', dedupeKey: 'bad-2',
    }), /CHECK constraint failed/);
    raw.close();
  });
});

test('a malformed/unrecognized source row is skipped with a fixed local diagnostic, never escalated to a systemic failure or reached to a transport', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    // A recovery_attempts row with an outcome outside every known vocabulary.
    state.invoke('recordRecoveryAttempt', {
      attemptId: 'weird-outcome-attempt', repo: REPO, project: 'agent-runner', issueNumber: 800, agent: 'claude-code-cli',
      startedAt: '2026-07-24T10:00:00.000Z', finishedAt: '2026-07-24T10:01:00.000Z', outcome: 'some_unrecognized_outcome_value', exitCode: 1,
    });
    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(deliveries.length, 0);
    assert.equal(state.healthy, true, 'an unrecognized outcome must never flip state.healthy false');
  });
});

// ---------------------------------------------------------------------------
// Adversarial redaction (extended): secrets/prompts/endpoints/paths/session
// handles/provider text/branch names/comment text never surface anywhere --
// delivered content, last_error, or taskErrors.
// ---------------------------------------------------------------------------

test('adversarial redaction: secrets, prompts, endpoints, paths, session references, provider text, branch names and comment text never surface in delivered content, last_error, or taskErrors', async () => {
  await withState(async (state) => {
    await activateCursors(state);
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

    const { transport, deliveries } = createSyntheticNotificationTransport({ fail: () => true, retryable: true });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });

    const forbidden = ['Bearer', 'sk-secret-token', 'sk-live-abcdef', 'hunter2', 'id_rsa', '.ssh', 'claude/secret-feature-42', 'internal.example', 'token=abc123', 'Retry after', 'reset password'];
    const serializedDeliveries = JSON.stringify(deliveries);
    const serializedRows = JSON.stringify(notificationRows(state));
    const serializedTaskErrors = JSON.stringify(state.taskErrors);
    for (const text of forbidden) {
      assert.equal(serializedDeliveries.includes(text), false, `leaked into delivered content: ${text}`);
      assert.equal(serializedRows.includes(text), false, `leaked into a notification_events row: ${text}`);
      assert.equal(serializedTaskErrors.includes(text), false, `leaked into taskErrors: ${text}`);
    }
    for (const row of notificationRows(state)) {
      if (row.last_error) assert.equal(DELIVERY_REASON_CODES.includes(row.last_error), true, 'last_error must always be one of the fixed closed reason codes');
      if (row.agent) assert.match(row.agent, /^[a-z][a-z0-9._-]{0,63}$/);
    }
  });
});

test('the default transport is disabled and makes no real delivery', async () => {
  const transport = createDisabledNotificationTransport();
  const result = await transport({ eventType: 'completed' });
  assert.equal(result.ok, false);
  assert.equal(result.paused, true);
  assert.equal(result.reasonCode, 'transport-disabled');
});

test('reconcileNotifications never throws even when the transport throws synchronously', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedCompletedAttempt(state);
    await assert.doesNotReject(reconcileNotifications({ state, args: { repo: REPO }, transport: () => { throw new Error('boom'); }, now: () => '2026-07-24T10:10:00.000Z' }));
  });
});

test('new SQLite columns on notification_events (including in-flight ownership) are excluded from dashboard output until positively allowlisted', async () => {
  await withState(async (state, { stateDbPath }) => {
    await activateCursors(state);
    seedCompletedAttempt(state);
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    state.close();

    const { buildRunnerDashboard } = await import('./claude-runner-dashboard-api.mjs');
    const dashboard = buildRunnerDashboard(stateDbPath);
    assert.equal(dashboard.latest.notifications.length, 1);
    const exposed = dashboard.latest.notifications[0];
    for (const forbiddenKey of ['dedupe_key', 'source_table', 'source_ref', 'content_json', 'last_error', 'in_flight_owner', 'in_flight_claimed_at']) {
      assert.equal(Object.prototype.hasOwnProperty.call(exposed, forbiddenKey), false, `${forbiddenKey} must not reach dashboard output`);
    }
  });
});

test('NOTIFICATION_STATE_SCHEMA_VERSION is a stable positive integer', () => {
  assert.equal(Number.isInteger(NOTIFICATION_STATE_SCHEMA_VERSION), true);
  assert.equal(NOTIFICATION_STATE_SCHEMA_VERSION >= 1, true);
});
