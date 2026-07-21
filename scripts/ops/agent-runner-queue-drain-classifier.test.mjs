import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyQueueDrainAttempt,
  classifyQueueDrainRows,
} from './agent-runner-queue-drain-classifier.mjs';

function fixture(overrides = {}) {
  const startedAt = '2026-07-20T17:00:00.000Z';
  return {
    run: {
      id: 1,
      repo: 'TheTekTeam/modelspend',
      issue_number: 300,
      started_at: startedAt,
      created_at: '2026-07-20T17:00:05.000Z',
      payload_json: JSON.stringify({
        reason: 'execution-authorization-blocked',
        childLaunched: false,
        executionStatus: 'not_executed',
        exitCode: 1,
      }),
    },
    attempt: {
      attempt_id: 'attempt-1',
      repo: 'TheTekTeam/modelspend',
      issue_number: 300,
      started_at: startedAt,
      outcome: 'unknown_failure',
    },
    queueEvents: [{
      repo: 'TheTekTeam/modelspend',
      issue_number: 300,
      created_at: '2026-07-20T17:00:04.000Z',
      event_type: 'quarantine',
    }],
    ...overrides,
  };
}

test('proves a pre-launch machine-profile false block', () => {
  const result = classifyQueueDrainAttempt(fixture());
  assert.equal(result.classification, 'machine_profile_false_block');
  assert.equal(result.restorableCandidate, true);
  assert.equal(result.evidence.childLaunched, false);
});

test('fails closed when execution evidence accompanies a machine-profile reason', () => {
  const value = fixture();
  value.run.payload_json = JSON.stringify({
    reason: 'execution-authorization-blocked',
    childLaunched: true,
    executionStatus: 'executed',
    implementationEvidence: { changedFiles: 1 },
  });
  const result = classifyQueueDrainAttempt(value);
  assert.equal(result.classification, 'ambiguous');
  assert.equal(result.restorableCandidate, false);
});

test('classifies a real launched child as a task attempt', () => {
  const value = fixture();
  value.run.payload_json = JSON.stringify({
    reason: 'validation-failed',
    childLaunched: true,
    executionStatus: 'executed',
  });
  const result = classifyQueueDrainAttempt(value);
  assert.equal(result.classification, 'task_attempt');
  assert.equal(result.restorableCandidate, false);
});

test('reports unmatched durable rows as ambiguous', () => {
  const value = fixture();
  const report = classifyQueueDrainRows({ runs: [value.run], attempts: [], queueEvents: value.queueEvents });
  assert.equal(report.total, 1);
  assert.equal(report.ambiguous, 1);
  assert.equal(report.classifications[0].reason, 'missing-durable-row');
});

test('produces complete deterministic counts for all inspected rows', () => {
  const first = fixture();
  const second = fixture();
  second.run = { ...second.run, id: 2, issue_number: 301, started_at: '2026-07-20T17:01:00.000Z', created_at: '2026-07-20T17:01:05.000Z', payload_json: JSON.stringify({ reason: 'idle', childLaunched: false, executionStatus: 'not_executed' }) };
  second.attempt = { ...second.attempt, attempt_id: 'attempt-2', issue_number: 301, started_at: second.run.started_at };
  second.queueEvents = [];
  const report = classifyQueueDrainRows({
    runs: [first.run, second.run],
    attempts: [first.attempt, second.attempt],
    queueEvents: first.queueEvents,
  });
  assert.deepEqual({ total: report.total, falseBlocks: report.machineProfileFalseBlocks, notIncident: report.notIncident }, {
    total: 2,
    falseBlocks: 1,
    notIncident: 1,
  });
});
