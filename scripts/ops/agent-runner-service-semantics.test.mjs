import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isHandledOutcome,
  isSystemicOutcome,
  parseStructuredOutput,
  serviceExitCode,
} from './agent-runner-service-semantics.mjs';

test('task attempt attention is handled with exit zero', () => {
  const payload = { failureScope: 'task_attempt', terminalOutcome: 'validation_failed', attentionDedupeKey: 'x' };
  assert.equal(isHandledOutcome(payload), true);
  assert.equal(serviceExitCode(1, payload), 0);
});

test('machine profile, candidate and quota pauses are handled', () => {
  for (const payload of [
    { profilePaused: true, failureScope: 'machine_profile' },
    { candidatePaused: true, failureScope: 'issue_not_runnable' },
    { quotaBlocked: true },
    { recoveryBlocked: true },
  ]) assert.equal(serviceExitCode(1, payload), 0);
});

test('systemic runner-state failure remains nonzero', () => {
  const payload = { systemicPause: true, reason: 'runner_state_unavailable' };
  assert.equal(isSystemicOutcome(payload), true);
  assert.equal(isHandledOutcome(payload), false);
  assert.equal(serviceExitCode(1, payload), 1);
});

test('unknown nonzero outcome remains nonzero', () => {
  assert.equal(serviceExitCode(2, { reason: 'unknown' }), 2);
  assert.equal(serviceExitCode(1, null), 1);
});

test('structured output parser accepts only one JSON object string', () => {
  assert.deepEqual(parseStructuredOutput(['{"terminalOutcome":"completed"}']), { terminalOutcome: 'completed' });
  assert.equal(parseStructuredOutput(['not-json']), null);
  assert.equal(parseStructuredOutput(['{}', 'extra']), null);
});
