import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCanaryProof } from './agent-runner-canary-proof.mjs';

function completeEvidence(overrides = {}) {
  const finishedAt = '2026-07-21T02:00:00.000Z';
  return {
    issueNumber: 5,
    claims: [{ id: 11, issue_number: 5, created_at: '2026-07-21T01:55:00.000Z' }],
    runResults: [{
      id: 22,
      issue_number: 5,
      created_at: finishedAt,
      finished_at: finishedAt,
      exit_code: 0,
      payload_json: JSON.stringify({
        implementationEvidence: { changedFiles: 3, commitSha: 'abcdef1234567890' },
        implementationPublication: {
          pullRequestNumber: 42,
          pullRequestUrl: 'https://github.com/TheTekTeam/agent-runner/pull/42',
          draft: true,
        },
      }),
    }],
    queueEvents: [],
    attentionEvents: [{ issue_number: 5, notification_count: 1, last_notification_at: finishedAt }],
    dashboardSnapshot: {
      refreshedAt: '2026-07-21T02:00:05.000Z',
      currentTask: { issueNumber: 5 },
    },
    ...overrides,
  };
}

test('passes only when the entire same-issue canary chain is proven', () => {
  const result = evaluateCanaryProof(completeEvidence());
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.evidence.publication.number, 42);
  assert.equal(result.evidence.implementation.changedFiles, 3);
});

test('fails closed when implementation evidence is absent', () => {
  const input = completeEvidence();
  const payload = JSON.parse(input.runResults[0].payload_json);
  delete payload.implementationEvidence;
  input.runResults[0].payload_json = JSON.stringify(payload);
  const result = evaluateCanaryProof(input);
  assert.equal(result.passed, false);
  assert.ok(result.failedChecks.includes('implementationEvidence'));
});

test('rejects a non-draft publication', () => {
  const input = completeEvidence();
  const payload = JSON.parse(input.runResults[0].payload_json);
  payload.implementationPublication.draft = false;
  payload.implementationPublication.state = 'open';
  input.runResults[0].payload_json = JSON.stringify(payload);
  const result = evaluateCanaryProof(input);
  assert.ok(result.failedChecks.includes('draftPublication'));
});

test('requires delivered notification evidence', () => {
  const result = evaluateCanaryProof(completeEvidence({ attentionEvents: [], queueEvents: [] }));
  assert.equal(result.passed, false);
  assert.ok(result.failedChecks.includes('notificationDelivered'));
});

test('requires dashboard refresh after terminal persistence for the same issue', () => {
  const result = evaluateCanaryProof(completeEvidence({
    dashboardSnapshot: { refreshedAt: '2026-07-21T01:59:59.000Z', currentTask: { issueNumber: 6 } },
  }));
  assert.equal(result.passed, false);
  assert.ok(result.failedChecks.includes('dashboardRefreshed'));
});

test('does not borrow evidence from another issue', () => {
  const input = completeEvidence();
  input.claims[0].issue_number = 6;
  input.attentionEvents[0].issue_number = 6;
  const result = evaluateCanaryProof(input);
  assert.ok(result.failedChecks.includes('claimPersisted'));
  assert.ok(result.failedChecks.includes('notificationDelivered'));
});
