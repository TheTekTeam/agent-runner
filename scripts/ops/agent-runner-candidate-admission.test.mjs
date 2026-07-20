import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitCurrentCandidate,
  candidatePausePayload,
  candidateSnapshot,
  evaluateCandidateAdmission,
} from './agent-runner-candidate-admission.mjs';

function selection({
  issue = 5,
  status = 'status:ready',
  agent = 'agent:claude',
  mode = 'preflight-direct',
  command = null,
  preflightId = 100,
  author = 'gpcola',
} = {}) {
  const preflight = preflightId == null ? null : {
    id: preflightId,
    databaseId: preflightId,
    body: '## Manager preflight packet',
    user: { login: author },
  };
  return {
    issue: issue == null ? null : { number: issue, statusLabel: status, agentLabel: agent },
    selection: issue == null ? null : { mode, command, preflight: mode === 'preflight-direct' ? preflight : null },
    command,
    currentPreflight: preflight,
  };
}

test('stable approved candidate is admitted', () => {
  const initial = candidateSnapshot(selection());
  const current = candidateSnapshot(selection());
  assert.deepEqual(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }), {
    allowed: true,
    reason: 'candidate-admitted',
  });
});

test('preflight revision change fails closed', () => {
  const initial = candidateSnapshot(selection({ preflightId: 100 }));
  const current = candidateSnapshot(selection({ preflightId: 101 }));
  assert.equal(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }).reason, 'candidate-preflight-revision-changed');
});

test('unapproved manager author fails closed', () => {
  const initial = candidateSnapshot(selection({ author: 'someone-else' }));
  const current = candidateSnapshot(selection({ author: 'someone-else' }));
  assert.equal(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }).reason, 'candidate-preflight-author-not-approved');
});

test('candidate disappearance creates a handled non-mutating pause', () => {
  const initial = candidateSnapshot(selection());
  const current = candidateSnapshot(selection({ issue: null }));
  const admission = evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] });
  const payload = candidatePausePayload(admission, current);
  assert.equal(payload.failureScope, 'issue_not_runnable');
  assert.equal(payload.attemptCreated, false);
  assert.equal(payload.childLaunched, false);
  assert.equal(payload.issueMutation, false);
  assert.equal(payload.systemdOutcome, 'handled');
});

test('admitCurrentCandidate revalidates with two independent selections', async () => {
  const values = [selection({ preflightId: 100 }), selection({ preflightId: 101 })];
  let calls = 0;
  const result = await admitCurrentCandidate({
    env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola' },
    select: async () => values[calls++],
  });
  assert.equal(calls, 2);
  assert.equal(result.admission.allowed, false);
  assert.equal(result.admission.reason, 'candidate-preflight-revision-changed');
});
