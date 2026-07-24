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

// ---------------------------------------------------------------------------
// Manager review round 3.
// ---------------------------------------------------------------------------

// Round 3, item 1: stateful source truth is revalidated before delivery.

test('round 3, item 1: a stateful source that clears while its notification is still pending resolves the row instead of delivering a stale alert', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state, { attemptId: 'clears-while-pending' });
    // The disabled transport leaves the discovered row pending indefinitely.
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z' });
    let [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'pending');
    assert.equal(row.event_type, 'failed_attention');

    // The operator fixes the underlying problem before a transport was ever enabled.
    assert.equal(state.invoke('resolveAttentionForAttempt', 'clears-while-pending', '2026-07-24T10:30:00.000Z'), 1);

    const { transport, deliveries, attempts } = createSyntheticNotificationTransport();
    const summary = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T11:00:00.000Z' });

    assert.equal(attempts.length, 0, 'a cleared source must never reach the transport at all');
    assert.equal(deliveries.length, 0);
    assert.equal(summary.delivered, 0);
    assert.equal(summary.resolved >= 1, true);
    [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'resolved');
    assert.equal(row.attempt_count, 0, 'resolving a cleared source consumes no delivery attempt');
  });
});

test('round 3, item 1: a retryable-failed stateful row whose source clears is resolved rather than retried', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state, { attemptId: 'clears-while-retrying' });
    const { transport } = createSyntheticNotificationTransport({ fail: () => true, retryable: true });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z' });
    let [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'retryable-failed');

    assert.equal(state.invoke('resolveAttentionForAttempt', 'clears-while-retrying', '2026-07-24T10:30:00.000Z'), 1);
    const second = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport: second.transport, now: () => '2026-07-24T12:00:00.000Z' });

    assert.equal(second.attempts.length, 0);
    [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'resolved');
  });
});

test('round 3, item 1: an exhausted quota episode whose source clears is resolved, and a later blocked episode is no longer suppressed', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedQuotaBlocked(state, { createdAt: '2026-07-24T10:00:00.000Z' });

    // Burn the whole delivery budget with permanent rejections so the row exhausts.
    const rejecting = createSyntheticNotificationTransport({ fail: () => true, retryable: false });
    await reconcileNotifications({ state, args: { repo: REPO }, transport: rejecting.transport, now: () => '2026-07-24T10:05:00.000Z' });
    let rows = notificationRows(state);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery_status, 'exhausted');
    assert.equal(rows[0].event_type, 'quota_blocked');

    // Quota becomes available again. The exhausted row must resolve -- under
    // round 2 it stayed unresolved forever, and openNotificationExists() then
    // suppressed every future quota_blocked episode for this repo.
    seedQuotaAvailable(state, { createdAt: '2026-07-24T11:00:00.000Z' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport: rejecting.transport, now: () => '2026-07-24T11:05:00.000Z' });
    rows = notificationRows(state);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivery_status, 'resolved', 'a cleared exhausted quota episode must resolve');

    // A genuinely new blocked episode must now be discovered and delivered.
    seedQuotaBlocked(state, { createdAt: '2026-07-24T12:00:00.000Z' });
    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T12:05:00.000Z' });
    rows = notificationRows(state);
    assert.equal(rows.length, 2, 'the later blocked episode must not be suppressed by the earlier exhausted one');
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].eventType, 'quota_blocked');
  });
});

// Round 3, item 2: a recovery-attempt-sourced failed_attention row can resolve.

test('round 3, item 2: a failed_attention notification derived directly from a recovery attempt resolves once the attempt resolution_state becomes resolved', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    const attemptId = `${REPO}#405:2026-07-24T10:00:00.000Z`;
    seedFailedAttemptWithoutAttention(state, { attemptId, issueNumber: 405, resolutionState: 'unresolved' });

    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z' });
    let [row] = notificationRows(state);
    assert.equal(row.event_type, 'failed_attention');
    assert.equal(row.source_table, 'recovery_attempts');
    assert.equal(row.source_ref, attemptId, 'the persisted reference must be the bounded, lookup-capable attempt id -- not an unparseable hash');
    assert.equal(row.delivery_status, 'delivered');
    assert.equal(deliveries.length, 1);

    // Repeated passes while it is still unresolved must not resolve it.
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.equal(notificationRows(state)[0].delivery_status, 'delivered', 'an unresolved attempt must keep its notification unresolved');

    // The attempt is resolved; the notification must follow.
    seedFailedAttemptWithoutAttention(state, { attemptId, issueNumber: 405, resolutionState: 'resolved' });
    const summary = await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T11:00:00.000Z' });
    assert.equal(summary.resolved >= 1, true);
    [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'resolved');
    assert.equal(row.resolved_at, '2026-07-24T11:00:00.000Z');
  });
});

// Round 3, item 3: the recovery cursor is lossless.

test('round 3, item 3: two recovery attempts sharing the exact same started_at are both discovered, at activation and during batch advancement', async () => {
  await withState(async (state) => {
    const sharedStartedAt = '2026-07-24T10:00:00.000Z';
    // Pre-existing history sharing the same millisecond as the new rows.
    seedCompletedAttempt(state, { attemptId: `${REPO}#500:${sharedStartedAt}`, issueNumber: 500, startedAt: sharedStartedAt });
    await activateCursors(state);
    assert.equal(notificationRows(state).length, 0, 'activation skips pre-existing history');

    // Two genuinely new attempts, both on the activation boundary millisecond.
    seedCompletedAttempt(state, { attemptId: `${REPO}#501:${sharedStartedAt}`, issueNumber: 501, startedAt: sharedStartedAt });
    seedCompletedAttempt(state, { attemptId: `${REPO}#502:${sharedStartedAt}`, issueNumber: 502, startedAt: sharedStartedAt });

    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z' });
    assert.deepEqual(
      notificationRows(state).map((row) => row.issue_number).sort((a, b) => a - b),
      [501, 502],
      'an equal-timestamp attempt must never be dropped by the cursor',
    );
    assert.equal(deliveries.length, 2);

    // A third attempt on the same millisecond, after the cursor has advanced.
    seedCompletedAttempt(state, { attemptId: `${REPO}#503:${sharedStartedAt}`, issueNumber: 503, startedAt: sharedStartedAt });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.deepEqual(
      notificationRows(state).map((row) => row.issue_number).sort((a, b) => a - b),
      [501, 502, 503],
      'normal batch advancement across an equal timestamp must also be lossless',
    );
  });
});

test('round 3, item 3: a bounded batch splits equal-timestamp attempts across passes without dropping any', async () => {
  await withState(async (state) => {
    const sharedStartedAt = '2026-07-24T10:00:00.000Z';
    await activateCursors(state);
    for (let i = 0; i < 5; i += 1) {
      seedCompletedAttempt(state, { attemptId: `${REPO}#60${i}:${sharedStartedAt}`, issueNumber: 600 + i, startedAt: sharedStartedAt });
    }
    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z', batchSize: 2 });
    assert.equal(notificationRows(state).length, 2);
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:06:00.000Z', batchSize: 2 });
    assert.equal(notificationRows(state).length, 4);
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:07:00.000Z', batchSize: 2 });
    assert.deepEqual(
      notificationRows(state).map((row) => row.issue_number).sort((a, b) => a - b),
      [600, 601, 602, 603, 604],
      'every equal-timestamp attempt is eventually discovered exactly once',
    );
  });
});

// Round 3, item 4: no head-of-line blocking.

test('round 3, item 4: an unresolved recovery attempt does not prevent a later independent attempt from being notified, and is itself notified exactly once when it becomes final', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    // A still-running attempt (no finished_at) -- its fate is not yet decided.
    state.invoke('recordRecoveryAttempt', {
      attemptId: `${REPO}#700:2026-07-24T10:00:00.000Z`, repo: REPO, project: 'agent-runner', issueNumber: 700,
      agent: 'claude-code-cli', startedAt: '2026-07-24T10:00:00.000Z', finishedAt: null, outcome: null,
    });
    // A later, independently final attempt.
    seedCompletedAttempt(state, { attemptId: `${REPO}#701:2026-07-24T10:01:00.000Z`, issueNumber: 701, startedAt: '2026-07-24T10:01:00.000Z' });

    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z' });
    assert.deepEqual(
      notificationRows(state).map((row) => row.issue_number),
      [701],
      'a later independent row must still create its notification intent while an earlier row is undecided',
    );
    assert.equal(deliveries.length, 1);

    // Repeated passes must not duplicate the later row while the earlier one stays undecided.
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:06:00.000Z' });
    assert.equal(notificationRows(state).length, 1, 're-scanning past the blocked row must be an exact no-op');

    // The blocked row finally reaches a terminal state.
    state.invoke('recordRecoveryAttempt', {
      attemptId: `${REPO}#700:2026-07-24T10:00:00.000Z`, repo: REPO, project: 'agent-runner', issueNumber: 700,
      agent: 'claude-code-cli', startedAt: '2026-07-24T10:00:00.000Z', finishedAt: '2026-07-24T10:20:00.000Z',
      outcome: 'completed', exitCode: 0, recoveryEligible: false, resolutionState: 'resolved',
    });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:25:00.000Z' });
    assert.deepEqual(
      notificationRows(state).map((row) => row.issue_number).sort((a, b) => a - b),
      [700, 701],
      'the previously-blocked row is notified once it becomes final',
    );

    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:26:00.000Z' });
    assert.equal(notificationRows(state).length, 2, 'and exactly once -- never re-notified on a later pass');
  });
});

test('round 3, item 4: a mutation-pending routing row does not prevent a later resolved no-qualified-agent row from being notified', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedReassignment(state, { issueNumber: 710, dedupeKey: 'hol-pending-reassign', deliveryStatus: 'mutation-pending' });
    seedNoQualifiedAgent(state, { issueNumber: 711, dedupeKey: 'hol-no-qualified', deliveryStatus: 'resolved' });

    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z' });
    assert.deepEqual(
      notificationRows(state).map((row) => row.event_type),
      ['no_qualified_agent'],
      'a permanently mutation-pending row must not hide every later routing row',
    );
    assert.equal(deliveries.length, 1);

    // The pending mutation is finally proven applied.
    state.invoke('updateRoutingEventDeliveryStatus', { dedupeKey: 'hol-pending-reassign', deliveryStatus: 'evidence-pending' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.deepEqual(
      notificationRows(state).map((row) => row.event_type).sort(),
      ['agent_reassigned', 'no_qualified_agent'],
    );
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:11:00.000Z' });
    assert.equal(notificationRows(state).length, 2, 'each routing row is notified exactly once');
  });
});

// Round 3, item 5: stale in-flight recovery never exhausts deliverability.

test('round 3, item 5: repeated stale in-flight claims never consume the delivery budget or exhaust an event that may never have reached a transport', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state, { issueNumber: 720 });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:00:00.000Z' });
    const [initial] = notificationRows(state);
    assert.equal(initial.delivery_status, 'pending');

    // Ten processes in a row claim the event and die before the transport is
    // ever invoked. maxAttempts is 2, so the round-2 "charge the attempt"
    // behaviour would have discarded this event as exhausted after two.
    for (let pass = 1; pass <= 10; pass += 1) {
      state.invoke('claimNotificationForDelivery', { dedupeKey: initial.dedupe_key, owner: `crashed-${pass}`, at: '2026-07-24T10:10:00.000Z' });
      const summary = await reconcileNotifications({
        state, args: { repo: REPO }, transport: createDisabledNotificationTransport(),
        now: () => '2026-07-24T10:20:00.000Z', staleInFlightMs: 60_000, maxAttempts: 2,
      });
      assert.equal(summary.staleRecovered, 1, `pass ${pass} must recover the abandoned claim`);
      assert.equal(summary.exhausted, 0, `pass ${pass} must never exhaust an unproven delivery`);
    }

    let [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'pending');
    assert.equal(row.attempt_count, 0, 'no ambiguous stale claim ever consumed a real delivery attempt');
    assert.equal(row.stale_recovery_count, 10, 'stale-claim recovery is tracked separately for operator visibility');

    // The event is still fully deliverable, on the same idempotency key.
    const { transport, deliveries } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T11:00:00.000Z', maxAttempts: 2 });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].idempotencyKey, initial.dedupe_key, 'the same stable idempotency key is used across every crash and resend');
    [row] = notificationRows(state);
    assert.equal(row.delivery_status, 'delivered');
  });
});

// Round 3, item 6: routing delivery status is an exact allowlist.

test('round 3, item 6: a corrupt, empty or future routing delivery status never announces a reassignment and stays revisitable', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedReassignment(state, { issueNumber: 730, dedupeKey: 'malformed-status-1', deliveryStatus: 'totally-unknown-status' });
    seedReassignment(state, { issueNumber: 731, dedupeKey: 'malformed-status-2', deliveryStatus: '' });
    seedReassignment(state, { issueNumber: 732, dedupeKey: 'malformed-status-3', deliveryStatus: 'mutation-applied-probably' });
    seedNoQualifiedAgent(state, { issueNumber: 733, dedupeKey: 'proven-resolved', deliveryStatus: 'resolved' });

    const { transport, deliveries, attempts } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z' });

    assert.deepEqual(
      notificationRows(state).map((row) => row.issue_number),
      [733],
      'only an exactly-allowlisted proven status may notify; unknown statuses fail closed',
    );
    assert.equal(attempts.length, 1);
    assert.equal(deliveries[0].eventType, 'no_qualified_agent');
    // A genuinely unrecognized status is surfaced as a bounded local
    // diagnostic drawn from the closed vocabulary -- never a raw status string.
    const unknownDiagnostics = state.taskErrors.filter((entry) => entry.stage === 'notification-source-status-unknown');
    assert.equal(unknownDiagnostics.length >= 1, true);
    for (const entry of unknownDiagnostics) assert.equal(entry.message, 'source-row-invalid');
    assert.doesNotMatch(JSON.stringify(state.taskErrors), /totally-unknown-status|mutation-applied-probably/);

    // Revisitable, not permanently skipped: once proven applied, it notifies.
    state.invoke('updateRoutingEventDeliveryStatus', { dedupeKey: 'malformed-status-1', deliveryStatus: 'resolved' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });
    assert.deepEqual(
      notificationRows(state).map((row) => row.issue_number).sort((a, b) => a - b),
      [730, 733],
      'a corrupt-status row remains revisitable and notifies once its status becomes proven',
    );
  });
});

test('round 3, item 6: a NULL routing delivery status fails closed', async () => {
  await withState(async (state, { stateDbPath }) => {
    await activateCursors(state);
    seedReassignment(state, { issueNumber: 740, dedupeKey: 'null-status', deliveryStatus: 'resolved' });
    state.close();

    // The NOT NULL column cannot be written through the state store's public
    // methods, so force the adversarial value directly in SQLite -- exactly
    // the "corrupt/legacy row" case the allowlist must survive.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(stateDbPath);
    db.exec("CREATE TABLE routing_events_rebuild AS SELECT * FROM routing_events");
    db.exec("UPDATE routing_events_rebuild SET delivery_status = NULL WHERE dedupe_key = 'null-status'");
    db.exec('DROP TABLE routing_events');
    db.exec('ALTER TABLE routing_events_rebuild RENAME TO routing_events');
    db.close();

    const reopened = createStateRecorder({ stateDbPath, outputDir: '.', repo: REPO });
    try {
      assert.equal(reopened.invoke('allRows', 'routing_events')[0].delivery_status, null);
      const { transport, attempts } = createSyntheticNotificationTransport();
      await reconcileNotifications({ state: reopened, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z' });
      assert.equal(reopened.invoke('allRows', 'notification_events').length, 0, 'a NULL delivery status must never announce a reassignment');
      assert.equal(attempts.length, 0);
    } finally {
      reopened.close();
    }
  });
});

// Round 3, item 7: bounded work is bounded in SQL, with targeted lookups.

test('round 3, item 7: a reconciliation pass never loads whole source or outbox tables, and bounds every batch in SQL', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    for (let i = 0; i < 12; i += 1) seedAttentionEvent(state, { attemptId: `bounded-attempt-${i}`, issueNumber: 800 + i });
    seedQuotaBlocked(state, { createdAt: '2026-07-24T10:00:00.000Z' });
    seedSystemicPause(state, { at: '2026-07-24T10:00:00.000Z' });

    // Record every state-store method a pass invokes, and the limits it passes.
    const invoked = [];
    const spied = {
      ...state,
      get healthy() { return state.healthy; },
      get available() { return state.available; },
      recordTaskError: (...values) => state.recordTaskError(...values),
      invoke: (method, ...values) => { invoked.push({ method, values }); return state.invoke(method, ...values); },
    };

    const { transport } = createSyntheticNotificationTransport();
    await reconcileNotifications({ state: spied, args: { repo: REPO }, transport, now: () => '2026-07-24T10:05:00.000Z', batchSize: 5 });

    const fullTableScans = invoked.filter((call) => call.method === 'allRows');
    assert.deepEqual(fullTableScans, [], 'no stage may load an entire table and filter/slice it in JavaScript');

    // Every batched read carries an explicit SQL-side bound.
    for (const method of ['attentionEventsSince', 'routingEventsSince', 'recoveryAttemptsSince', 'openHealthConditionsForTypes', 'dueNotificationEvents', 'unresolvedStatefulNotificationEvents']) {
      const calls = invoked.filter((call) => call.method === method);
      assert.equal(calls.length >= 1, true, `${method} must be used by a pass`);
      for (const call of calls) {
        assert.equal(Number.isInteger(call.values[call.values.length - 1]), true, `${method} must be called with an explicit SQL limit`);
      }
    }
    assert.equal(invoked.filter((call) => call.method === 'attentionEventsSince')[0].values[2], 5, 'the configured batch size is the SQL limit');

    // Health discovery queries only the closed condition-type set.
    const healthCalls = invoked.filter((call) => call.method === 'openHealthConditionsForTypes');
    assert.deepEqual(healthCalls[0].values[1].sort(), ['queue_inspection_degraded', 'systemic_pause']);

    // Source-truth revalidation uses targeted single-row lookups.
    const targeted = invoked.filter((call) => ['attentionEventByDedupeKey', 'recoveryAttemptByAttemptId', 'healthConditionForType', 'latestQuotaHistoryForRepo'].includes(call.method));
    assert.equal(targeted.length >= 1, true, 'source resolution must use targeted lookups');
    assert.equal(notificationRows(state).length <= 12, true);
  });
});

// Round 3, item 8: adversarial direct-store writes cannot bypass the sink bounds.

test('round 3, item 8: project, source_table and last_error are bounded by the state-store methods themselves, not only by this module', async () => {
  await withState(async (state) => {
    const rawDiagnostic = 'Bearer sk-live-deadbeef /home/gp/.claude/session.json https://provider.example/v1/messages';

    // An unrecognized source_table is rejected by the sink itself.
    state.invoke('recordNotificationEvent', {
      repo: REPO, eventType: 'failed_attention', reasonCode: 'attention-required',
      sourceTable: 'attacker_controlled_table', sourceRef: 'x', occurredAt: '2026-07-24T10:00:00.000Z',
      dedupeKey: 'adv-1', content: {},
    });
    assert.equal(notificationRows(state).length, 0, 'the rejected row must never be persisted');

    // A raw diagnostic can never become a dashboard-visible project.
    state.invoke('recordNotificationEvent', {
      repo: REPO, project: rawDiagnostic, eventType: 'failed_attention', reasonCode: 'attention-required',
      sourceTable: 'attention_events', sourceRef: 'adv-2', occurredAt: '2026-07-24T10:00:00.000Z',
      dedupeKey: 'adv-2', content: {},
    });
    assert.equal(notificationRows(state)[0].project, null);

    // A raw error string can never become last_error.
    state.invoke('claimNotificationForDelivery', { dedupeKey: 'adv-2', owner: 'p', at: '2026-07-24T10:00:01.000Z' });
    state.invoke('markNotificationDeliveryFailed', { dedupeKey: 'adv-2', attemptedAt: '2026-07-24T10:00:02.000Z', errorCode: rawDiagnostic });
    assert.equal(notificationRows(state)[0].last_error, 'invalid-error-code');

    assert.doesNotMatch(JSON.stringify(notificationRows(state)), /Bearer|sk-live|\/home\/|https:\/\//);
  });
});

test('round 3, item 8: every last_error this module can ever persist is a member of the closed DELIVERY_REASON_CODES set', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state, { issueNumber: 810 });
    // A transport returning an out-of-vocabulary reason code.
    const rogueTransport = async () => ({ ok: false, retryable: true, reasonCode: 'Bearer sk-live-leak at /home/gp/secret' });
    await reconcileNotifications({ state, args: { repo: REPO }, transport: rogueTransport, now: () => '2026-07-24T10:05:00.000Z' });
    const [row] = notificationRows(state);
    assert.equal(DELIVERY_REASON_CODES.includes(row.last_error), true, `last_error ${row.last_error} must be a closed reason code`);
    assert.doesNotMatch(JSON.stringify(row), /Bearer|sk-live|\/home\//);
  });
});

// ---------------------------------------------------------------------------
// Manager review round 4, item 1: a source-truth read failure is fail-closed.
//
// createStateRecorder().invoke() converts a store exception into `null` while
// pushing onto `errors` (which flips `healthy` false). These helpers reproduce
// that behaviour exactly for one targeted lookup, so the tests exercise the
// real failure shape rather than a hand-made one.
// ---------------------------------------------------------------------------

function withFailingLookup(state, failingMethod, { afterCalls = 0 } = {}) {
  let seen = 0;
  return {
    errors: state.errors,
    taskErrors: state.taskErrors,
    get healthy() { return state.healthy; },
    get available() { return state.available; },
    recordTaskError: (...values) => state.recordTaskError(...values),
    record: (...values) => state.record(...values),
    close: () => state.close(),
    invoke(method, ...values) {
      if (method === failingMethod) {
        seen += 1;
        if (seen > afterCalls) {
          // Exactly what createStateRecorder does when the store throws.
          state.errors.push({ stage: method, message: 'simulated sqlite read failure' });
          return null;
        }
      }
      return state.invoke(method, ...values);
    },
  };
}

test('round 4, item 1: a throwing targeted attention lookup after the claim delivers nothing and resolves nothing', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedAttentionEvent(state, { attemptId: 'failclosed-attention-attempt', issueNumber: 900 });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z' });
    assert.equal(notificationRows(state)[0].delivery_status, 'pending');

    const { transport, attempts } = createSyntheticNotificationTransport();
    const failing = withFailingLookup(state, 'attentionEventByDedupeKey');
    const summary = await reconcileNotifications({ state: failing, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });

    assert.equal(attempts.length, 0, 'no transport call may occur after a source-truth read failure');
    assert.equal(summary.delivered, 0);
    assert.equal(summary.resolved, 0);
    const [row] = notificationRows(state);
    assert.equal(row.resolved_at, null, 'a failed lookup must never resolve a notification');
    assert.equal(row.delivery_status, 'in-flight', 'the claimed row stays in-flight for the ordinary stale-claim recovery path');
    assert.equal(row.attempt_count, 0, 'no delivery attempt was made, so none may be charged');
    assert.equal(state.healthy, false, 'the store failure stays systemic');
  });
});

test('round 4, item 1: a throwing targeted recovery-attempt lookup after the claim delivers nothing and resolves nothing', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedFailedAttemptWithoutAttention(state, { attemptId: `${REPO}#901:2026-07-24T10:00:00.000Z`, issueNumber: 901 });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z' });
    const [seeded] = notificationRows(state);
    assert.equal(seeded.event_type, 'failed_attention');
    assert.equal(seeded.source_table, 'recovery_attempts');

    const { transport, attempts } = createSyntheticNotificationTransport();
    const failing = withFailingLookup(state, 'recoveryAttemptByAttemptId');
    const summary = await reconcileNotifications({ state: failing, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });

    assert.equal(attempts.length, 0);
    assert.equal(summary.resolved, 0);
    const [row] = notificationRows(state);
    assert.equal(row.resolved_at, null);
    assert.equal(row.delivery_status, 'in-flight');
    assert.equal(state.healthy, false);
  });
});

test('round 4, item 1: a throwing targeted quota lookup leaves an exhausted quota notification unresolved', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedQuotaBlocked(state, { createdAt: '2026-07-24T10:00:00.000Z' });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z' });
    const [created] = notificationRows(state);
    assert.equal(created.event_type, 'quota_blocked');

    // Walk the row to `exhausted` without any transport involvement.
    state.invoke('claimNotificationForDelivery', { dedupeKey: created.dedupe_key, owner: 'p', at: '2026-07-24T10:06:00.000Z' });
    state.invoke('markNotificationDeliveryFailed', { dedupeKey: created.dedupe_key, attemptedAt: '2026-07-24T10:06:01.000Z', errorCode: 'transport-rejected-permanent', retryable: false });
    assert.equal(notificationRows(state)[0].delivery_status, 'exhausted');

    // Quota has genuinely cleared -- but the lookup that would prove it fails.
    seedQuotaAvailable(state, { createdAt: '2026-07-24T10:07:00.000Z' });
    const { transport, attempts } = createSyntheticNotificationTransport();
    const failing = withFailingLookup(state, 'latestQuotaHistoryForRepo', { afterCalls: 1 });
    const summary = await reconcileNotifications({ state: failing, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });

    assert.equal(attempts.length, 0);
    assert.equal(summary.resolved, 0);
    assert.equal(notificationRows(state)[0].resolved_at, null, 'a failed quota lookup is not evidence the source cleared');
    assert.equal(notificationRows(state)[0].delivery_status, 'exhausted');
    assert.equal(state.healthy, false);
  });
});

test('round 4, item 1: a throwing targeted health lookup leaves a systemic_pause notification unresolved', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedSystemicPause(state, { at: '2026-07-24T10:00:00.000Z' });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z' });
    const [created] = notificationRows(state);
    assert.equal(created.event_type, 'systemic_pause');

    const { transport, attempts } = createSyntheticNotificationTransport();
    const failing = withFailingLookup(state, 'healthConditionForType');
    const summary = await reconcileNotifications({ state: failing, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z' });

    assert.equal(attempts.length, 0);
    assert.equal(summary.resolved, 0);
    assert.equal(notificationRows(state)[0].resolved_at, null);
    assert.equal(state.healthy, false);
  });
});

test('round 4, item 1: the pass returns boundedly and the source-truth store failure stays systemic, never a task-local success', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    for (let i = 0; i < 6; i += 1) seedAttentionEvent(state, { attemptId: `failclosed-bounded-${i}`, issueNumber: 910 + i });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z' });
    assert.equal(notificationRows(state).length, 6);

    const { transport, attempts } = createSyntheticNotificationTransport();
    const failing = withFailingLookup(state, 'attentionEventByDedupeKey');
    const startedAt = Date.now();
    const summary = await reconcileNotifications({
      state: failing, args: { repo: REPO }, transport, now: () => '2026-07-24T10:10:00.000Z', maxPassDurationMs: 2_000,
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(elapsed < 2_000, true, `the pass must return within its bounded duration (took ${elapsed}ms)`);
    assert.equal(attempts.length, 0, 'the pass must stop at the first failed lookup, not keep delivering the rest of the batch');
    assert.deepEqual({ delivered: summary.delivered, resolved: summary.resolved }, { delivered: 0, resolved: 0 });
    // Systemic, not downgraded: the failure is in `errors` (which gates
    // `healthy` and the caller's systemic pause), not only in `taskErrors`.
    assert.equal(state.healthy, false);
    assert.equal(state.errors.some((entry) => entry.stage === 'attentionEventByDedupeKey'), true);
    assert.equal(notificationRows(state).filter((row) => row.resolved_at !== null).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Manager review round 4, item 2: no head-of-line blocking across a backlog
// longer than one batch window. The durable cursor is a monotonic high-water
// mark; undecided rows live in their own durable deferred set.
// ---------------------------------------------------------------------------

function seedRunningAttempt(state, { attemptId = 'running-attempt-1', repo = REPO, issueNumber = 950, startedAt = '2026-07-24T10:00:00.000Z' } = {}) {
  state.invoke('recordRecoveryAttempt', {
    attemptId, repo, project: 'agent-runner', issueNumber, agent: 'claude-code-cli', model: 'claude-sonnet-5', harness: 'claude',
    startedAt, finishedAt: null, outcome: null, recoveryEligible: false, resolutionState: 'unresolved',
  });
}

function deferredRowKeys(state, sourceTable, repo = REPO) {
  return (state.invoke('deferredNotificationSourceRows', repo, sourceTable, 200) || []).map((row) => row.row_key);
}

const BATCH = 3;
const LATER_ROWS = 2 * BATCH + 1; // 7 -- strictly more than two batch windows

test('round 4, item 2: a blocked first recovery attempt never stops later rows more than two batch windows away, and is itself notified exactly once', async () => {
  await withState(async (state, { stateDbPath }) => {
    await activateCursors(state);
    // The very first post-activation row is blocked (still running).
    seedRunningAttempt(state, { attemptId: `${REPO}#950:2026-07-24T10:00:00.000Z`, issueNumber: 950 });
    for (let i = 0; i < LATER_ROWS; i += 1) {
      seedCompletedAttempt(state, {
        attemptId: `${REPO}#${960 + i}:2026-07-24T10:0${i}:00.000Z`, issueNumber: 960 + i,
        startedAt: `2026-07-24T10:0${i}:00.000Z`, finishedAt: `2026-07-24T10:0${i}:30.000Z`,
      });
    }

    const pass = async (target, at) => reconcileNotifications({ state: target, args: { repo: REPO }, now: () => at, batchSize: BATCH });

    await pass(state, '2026-07-24T11:00:00.000Z');
    assert.deepEqual(deferredRowKeys(state, 'recovery_attempts').length, 1, 'the undecided row is durably deferred, not parked in memory');
    await pass(state, '2026-07-24T11:01:00.000Z');

    // Restart/reopen mid-backlog: both frontiers must survive.
    state.close();
    const reopened = createStateRecorder({ stateDbPath, outputDir: '/tmp', repo: REPO });
    try {
      assert.equal(deferredRowKeys(reopened, 'recovery_attempts').length, 1, 'the deferred set survives a restart');
      assert.equal(/^\d+$/.test(String(reopened.invoke('getNotificationSourceCursor', REPO, 'recovery_attempts'))), true, 'the high-water frontier survives a restart');
      await pass(reopened, '2026-07-24T11:02:00.000Z');
      await pass(reopened, '2026-07-24T11:03:00.000Z');

      const completed = reopened.invoke('allRows', 'notification_events').filter((row) => row.event_type === 'completed');
      assert.equal(completed.length, LATER_ROWS, `all ${LATER_ROWS} later rows must become intents while the first stays blocked`);
      assert.equal(reopened.invoke('allRows', 'notification_events').some((row) => row.issue_number === 950), false, 'the blocked row must not be notified while undecided');

      // The blocked row finally becomes final -- in place, on the same rowid.
      seedCompletedAttempt(reopened, {
        attemptId: `${REPO}#950:2026-07-24T10:00:00.000Z`, issueNumber: 950,
        startedAt: '2026-07-24T10:00:00.000Z', finishedAt: '2026-07-24T11:30:00.000Z',
      });
      await pass(reopened, '2026-07-24T11:31:00.000Z');
      await pass(reopened, '2026-07-24T11:32:00.000Z');
      await pass(reopened, '2026-07-24T11:33:00.000Z');

      const forBlocked = reopened.invoke('allRows', 'notification_events').filter((row) => row.issue_number === 950);
      assert.equal(forBlocked.length, 1, 'the once-blocked row must be notified exactly once, however many passes run');
      assert.deepEqual(deferredRowKeys(reopened, 'recovery_attempts'), [], 'a decided row is dropped from the deferred set');
      assert.equal(reopened.invoke('allRows', 'notification_events').length, LATER_ROWS + 1);
    } finally {
      reopened.close();
    }
  });
});

test('round 4, item 2: a mutation-pending routing row never stops later routing rows more than two batch windows away, and is itself notified exactly once', async () => {
  await withState(async (state, { stateDbPath }) => {
    await activateCursors(state);
    seedReassignment(state, { issueNumber: 970, dedupeKey: 'r4-routing-blocked', deliveryStatus: 'mutation-pending' });
    for (let i = 0; i < LATER_ROWS; i += 1) {
      seedNoQualifiedAgent(state, { issueNumber: 980 + i, dedupeKey: `r4-routing-later-${i}`, deliveryStatus: 'resolved' });
    }

    const pass = async (target, at) => reconcileNotifications({ state: target, args: { repo: REPO }, now: () => at, batchSize: BATCH });

    await pass(state, '2026-07-24T11:00:00.000Z');
    assert.equal(deferredRowKeys(state, 'routing_events').length, 1);
    await pass(state, '2026-07-24T11:01:00.000Z');

    state.close();
    const reopened = createStateRecorder({ stateDbPath, outputDir: '/tmp', repo: REPO });
    try {
      assert.equal(deferredRowKeys(reopened, 'routing_events').length, 1, 'the deferred routing identity survives a restart');
      await pass(reopened, '2026-07-24T11:02:00.000Z');
      await pass(reopened, '2026-07-24T11:03:00.000Z');

      const later = reopened.invoke('allRows', 'notification_events').filter((row) => row.event_type === 'no_qualified_agent');
      assert.equal(later.length, LATER_ROWS, `all ${LATER_ROWS} later routing rows must become intents while the first stays blocked`);
      assert.equal(reopened.invoke('allRows', 'notification_events').some((row) => row.event_type === 'agent_reassigned'), false);

      // The mutation is finally proven applied, in place on the same row.
      reopened.invoke('updateRoutingEventDeliveryStatus', { dedupeKey: 'r4-routing-blocked', deliveryStatus: 'resolved' });
      await pass(reopened, '2026-07-24T11:31:00.000Z');
      await pass(reopened, '2026-07-24T11:32:00.000Z');

      const reassignments = reopened.invoke('allRows', 'notification_events').filter((row) => row.event_type === 'agent_reassigned');
      assert.equal(reassignments.length, 1, 'the once-blocked routing row must be notified exactly once');
      assert.deepEqual(deferredRowKeys(reopened, 'routing_events'), []);
    } finally {
      reopened.close();
    }
  });
});

test('round 4, item 2: first activation still skips all pre-existing history, deferring nothing', async () => {
  await withState(async (state) => {
    seedRunningAttempt(state, { attemptId: `${REPO}#990:2026-07-24T09:00:00.000Z`, issueNumber: 990 });
    seedCompletedAttempt(state, { attemptId: `${REPO}#991:2026-07-24T09:00:00.000Z`, issueNumber: 991 });
    seedReassignment(state, { issueNumber: 992, dedupeKey: 'r4-preexisting-routing', deliveryStatus: 'mutation-pending' });
    seedAttentionEvent(state, { attemptId: 'r4-preexisting-attention', issueNumber: 993 });

    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:00:00.000Z', batchSize: BATCH });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:01:00.000Z', batchSize: BATCH });

    assert.deepEqual(notificationRows(state), [], 'activation must skip every pre-existing row');
    for (const table of ['recovery_attempts', 'routing_events', 'attention_events']) {
      assert.deepEqual(deferredRowKeys(state, table), [], `activation must not defer pre-existing ${table} history`);
    }
  });
});

// ---------------------------------------------------------------------------
// Manager review round 4, item 3: the unresolved-stateful resolution sweep is
// fair -- a permanently-open older group can never starve a newer row.
// ---------------------------------------------------------------------------

test('round 4, item 3: more than one batch of permanently-open older rows cannot starve a newer exhausted quota row, and a later blocked episode is notified', async () => {
  await withState(async (state, { stateDbPath }) => {
    await activateCursors(state);
    // More than `batchSize` genuinely-open older stateful rows. These never
    // resolve: their attention_events rows stay unresolved for the whole test.
    const OLDER = BATCH + 2;
    for (let i = 0; i < OLDER; i += 1) seedAttentionEvent(state, { attemptId: `r4-fair-older-${i}`, issueNumber: 1000 + i });
    for (let pass = 0; pass < 3; pass += 1) {
      await reconcileNotifications({ state, args: { repo: REPO }, now: () => `2026-07-24T10:0${pass}:00.000Z`, batchSize: BATCH });
    }
    assert.equal(notificationRows(state).filter((row) => row.event_type === 'failed_attention').length, OLDER);

    // A NEWER quota_blocked row, walked to `exhausted` without any transport.
    seedQuotaBlocked(state, { createdAt: '2026-07-24T10:06:00.000Z' });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:07:00.000Z', batchSize: BATCH });
    const quota = notificationRows(state).find((row) => row.event_type === 'quota_blocked');
    assert.ok(quota, 'the quota episode must have been discovered');
    state.invoke('claimNotificationForDelivery', { dedupeKey: quota.dedupe_key, owner: 'p', at: '2026-07-24T10:08:00.000Z' });
    state.invoke('markNotificationDeliveryFailed', { dedupeKey: quota.dedupe_key, attemptedAt: '2026-07-24T10:08:01.000Z', errorCode: 'transport-rejected-permanent', retryable: false });
    assert.equal(notificationRows(state).find((row) => row.dedupe_key === quota.dedupe_key).delivery_status, 'exhausted');

    // Quota clears while every older attention row stays open.
    seedQuotaAvailable(state, { createdAt: '2026-07-24T10:09:00.000Z' });

    // Bounded repeated passes, with a restart in the middle: the rotating
    // resolution cursor must reach the newer row despite the older group
    // filling more than one batch.
    let store = state;
    let resolvedAt = null;
    for (let pass = 0; pass < 6 && resolvedAt === null; pass += 1) {
      if (pass === 2) {
        store.close();
        store = createStateRecorder({ stateDbPath, outputDir: '/tmp', repo: REPO });
      }
      await reconcileNotifications({ state: store, args: { repo: REPO }, now: () => `2026-07-24T10:1${pass}:00.000Z`, batchSize: BATCH });
      resolvedAt = store.invoke('allRows', 'notification_events').find((row) => row.dedupe_key === quota.dedupe_key).resolved_at;
    }
    try {
      assert.notEqual(resolvedAt, null, 'the newer cleared quota row must be reached and resolved within a bounded number of passes');
      assert.equal(
        store.invoke('allRows', 'notification_events').filter((row) => row.event_type === 'failed_attention' && row.resolved_at !== null).length,
        0,
        'the genuinely-open older rows must stay unresolved -- fairness, not indiscriminate resolution',
      );

      // The resolved episode no longer suppresses the next genuine one.
      store.record('recordQuotaHistory', { repo: REPO, quotaPreflight: { blocked: true, status: 'exhausted', reason: 'session-quota-exhausted' }, createdAt: '2026-07-24T10:20:00.000Z' });
      await reconcileNotifications({ state: store, args: { repo: REPO }, now: () => '2026-07-24T10:21:00.000Z', batchSize: BATCH });
      const quotaRows = store.invoke('allRows', 'notification_events').filter((row) => row.event_type === 'quota_blocked');
      assert.equal(quotaRows.length, 2, 'a later blocked episode must create a new notification once the earlier one resolved');
      assert.equal(quotaRows.filter((row) => row.resolved_at === null).length, 1);
    } finally {
      if (store !== state) store.close();
    }
  });
});

test('round 4, item 3: the resolution sweep rotates over every unresolved stateful event type and wraps at the tail', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    for (let i = 0; i < BATCH + 2; i += 1) seedAttentionEvent(state, { attemptId: `r4-rotate-${i}`, issueNumber: 1100 + i });
    seedSystemicPause(state, { at: '2026-07-24T10:00:00.000Z' });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z', batchSize: BATCH });

    const seen = new Set();
    const spied = {
      ...state,
      get healthy() { return state.healthy; },
      get available() { return state.available; },
      recordTaskError: (...values) => state.recordTaskError(...values),
      invoke(method, ...values) {
        const result = state.invoke(method, ...values);
        if (method === 'unresolvedStatefulNotificationEvents') for (const row of result || []) seen.add(row.id);
        return result;
      },
    };
    const cursors = [];
    for (let pass = 0; pass < 4; pass += 1) {
      await reconcileNotifications({ state: spied, args: { repo: REPO }, now: () => `2026-07-24T10:2${pass}:00.000Z`, batchSize: BATCH });
      cursors.push(state.invoke('getNotificationResolutionCursor', REPO));
    }

    const unresolvedIds = notificationRows(state).filter((row) => row.resolved_at === null).map((row) => row.id);
    for (const id of unresolvedIds) {
      assert.equal(seen.has(id), true, `unresolved row ${id} must be rechecked within a bounded number of passes`);
    }
    assert.equal(cursors.includes(0), true, 'the durable cursor must wrap back to the start once the tail is reached');
  });
});

test('round 4, item 3: one-shot event types are excluded from the rotating resolution sweep in SQL', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    seedCompletedAttempt(state, { attemptId: `${REPO}#1200:2026-07-24T10:00:00.000Z`, issueNumber: 1200 });
    seedAttentionEvent(state, { attemptId: 'r4-oneshot-attention', issueNumber: 1201 });
    await reconcileNotifications({ state, args: { repo: REPO }, now: () => '2026-07-24T10:05:00.000Z', batchSize: BATCH });

    const swept = state.invoke('unresolvedStatefulNotificationEvents', REPO, 0, 50);
    assert.deepEqual([...new Set(swept.map((row) => row.event_type))], ['failed_attention']);
    assert.equal(swept.some((row) => row.event_type === 'completed'), false, 'a one-shot row must never appear in the stateful sweep');
  });
});

// ---------------------------------------------------------------------------
// Manager review round 4, additional boundedness: stale in-flight selection.
// ---------------------------------------------------------------------------

test('round 4: stale in-flight recovery is bounded per pass in SQL and drains a larger crash backlog across passes', async () => {
  await withState(async (state) => {
    await activateCursors(state);
    const BACKLOG = 2 * BATCH + 1;
    for (let i = 0; i < BACKLOG; i += 1) seedAttentionEvent(state, { attemptId: `r4-stale-${i}`, issueNumber: 1300 + i });
    // Discover all of them, then strand every row in-flight as if the owning
    // processes all crashed mid-delivery.
    for (let pass = 0; pass < 4; pass += 1) {
      await reconcileNotifications({ state, args: { repo: REPO }, now: () => `2026-07-24T10:0${pass}:00.000Z`, batchSize: 50 });
    }
    assert.equal(notificationRows(state).length, BACKLOG);
    for (const row of notificationRows(state)) {
      state.invoke('claimNotificationForDelivery', { dedupeKey: row.dedupe_key, owner: 'crashed', at: '2026-07-24T10:00:00.000Z' });
    }
    assert.equal(notificationRows(state).filter((row) => row.delivery_status === 'in-flight').length, BACKLOG);

    const inFlightAfter = async (at) => {
      const summary = await reconcileNotifications({
        state, args: { repo: REPO }, now: () => at, batchSize: BATCH, staleInFlightMs: 1_000,
        transport: async () => ({ ok: false, paused: true, reasonCode: 'transport-disabled' }),
      });
      return summary;
    };

    const first = await inFlightAfter('2026-07-24T12:00:00.000Z');
    assert.equal(first.staleRecovered, BATCH, 'one pass may only recover a bounded batch of stale claims');
    assert.equal(notificationRows(state).filter((row) => row.stale_recovery_count > 0).length, BATCH);

    let recovered = first.staleRecovered;
    for (let pass = 1; pass < 5 && recovered < BACKLOG; pass += 1) {
      const summary = await inFlightAfter(`2026-07-24T1${2 + pass}:00:00.000Z`);
      assert.equal(summary.staleRecovered <= BATCH, true, 'every pass stays bounded');
      recovered += summary.staleRecovered;
    }
    assert.equal(recovered, BACKLOG, 'repeated bounded passes make fair progress through the whole backlog');
    assert.equal(notificationRows(state).every((row) => row.attempt_count === 0), true, 'a stale claim is never charged to the delivery budget');
  });
});
