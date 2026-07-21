import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLivenessFilteredStore,
  liveSchedulingDecision,
} from './agent-runner-live-liveness.mjs';

function row(overrides = {}) {
  return {
    attempt_id: 'attempt-1',
    resolution_state: 'unresolved',
    recovery_eligible: 1,
    next_retry_at: '2026-07-21T00:00:00.000Z',
    retry_reason: 'rate_limited',
    retry_attempt: 1,
    retry_cap: 3,
    ...overrides,
  };
}

test('actively owned attempts are preserved and never dispatched', () => {
  const decision = liveSchedulingDecision(row({ resolution_state: 'active' }), {
    liveProcess: true,
    liveProcessRaw: true,
    leaseCurrent: true,
    authorityCurrent: true,
    progressWithinStallWindow: true,
  }, '2026-07-21T00:01:00.000Z');
  assert.deepEqual(decision, {
    allowed: false,
    action: 'preserve',
    classifierState: 'actively_owned',
    reason: 'attempt-actively-owned',
  });
});

test('a confirmed-dead due bounded retry is admitted', () => {
  const decision = liveSchedulingDecision(row(), {
    liveProcess: false,
    liveProcessRaw: false,
    leaseCurrent: true,
    authorityCurrent: true,
    progressWithinStallWindow: true,
    retryDeadlineValid: false,
    boundedRetryPolicyProven: true,
  }, '2026-07-21T00:01:00.000Z');
  assert.equal(decision.allowed, true);
  assert.equal(decision.action, 'recover');
  assert.equal(decision.classifierState, 'stale_recoverable');
});

test('ambiguous process evidence is held for inspection', () => {
  const decision = liveSchedulingDecision(row(), {
    liveProcess: false,
    liveProcessRaw: null,
    leaseCurrent: true,
    authorityCurrent: true,
    retryDeadlineValid: false,
    boundedRetryPolicyProven: true,
  }, '2026-07-21T00:01:00.000Z');
  assert.equal(decision.allowed, false);
  assert.equal(decision.action, 'preserve-for-inspection');
  assert.equal(decision.classifierState, 'uncertain');
});

test('scheduler-facing store exposes only liveness-admitted due attempts', () => {
  const rows = [row(), row({ attempt_id: 'attempt-2' })];
  const store = {
    dueRecoveryAttempts: () => rows,
    activeRecoveryAttempts: () => [],
  };
  const filtered = createLivenessFilteredStore(store, [
    { attemptId: 'attempt-1', allowed: false },
    { attemptId: 'attempt-2', allowed: true },
  ]);
  assert.deepEqual(filtered.dueRecoveryAttempts('repo'), [rows[1]]);
});
