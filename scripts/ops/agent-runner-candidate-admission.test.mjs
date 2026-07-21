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
  labels = [status, agent],
  selectedStatus = status,
  selectedAgent = agent,
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
    issue: issue == null ? null : {
      number: issue,
      labels,
      statusLabel: selectedStatus,
      agentLabel: selectedAgent,
    },
    selection: issue == null ? null : { mode, command, preflight: mode === 'preflight-direct' ? preflight : null },
    command,
    currentPreflight: preflight,
  };
}

function command(id = 200, kind = 'proceed') {
  return {
    kind,
    sourceCommentIdentity: { databaseId: id },
    sourceCommentId: `github-comment:database-id:${id}`,
  };
}

test('stable approved preflight-direct candidate is admitted without a command identity', () => {
  const initial = candidateSnapshot(selection());
  const current = candidateSnapshot(selection());
  assert.equal(initial.commandIdentity, null);
  assert.equal(current.commandIdentity, null);
  assert.deepEqual(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }), {
    allowed: true,
    reason: 'candidate-admitted',
  });
});

test('stable approved proceed-command candidate is admitted', () => {
  const initial = candidateSnapshot(selection({ mode: 'proceed-command', command: command(200) }));
  const current = candidateSnapshot(selection({ mode: 'proceed-command', command: command(200) }));
  assert.deepEqual(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }), {
    allowed: true,
    reason: 'candidate-admitted',
  });
});

test('duplicate status labels fail closed before attempt creation', () => {
  const current = candidateSnapshot(selection({ labels: ['status:ready', 'status:blocked', 'agent:claude'] }));
  assert.equal(current.labelAuthorityAllowed, false);
  assert.equal(evaluateCandidateAdmission({ initial: current, current, approvers: ['gpcola'] }).reason, 'candidate-status-label-ambiguous');
});

test('missing agent label fails closed before attempt creation', () => {
  const current = candidateSnapshot(selection({ labels: ['status:ready'] }));
  assert.equal(evaluateCandidateAdmission({ initial: current, current, approvers: ['gpcola'] }).reason, 'candidate-agent-label-missing');
});

test('project-derived selected status cannot override the sole status label', () => {
  const current = candidateSnapshot(selection({ selectedStatus: 'status:blocked' }));
  assert.equal(current.statusLabel, 'status:ready');
  assert.equal(evaluateCandidateAdmission({ initial: current, current, approvers: ['gpcola'] }).reason, 'candidate-status-field-label-conflict');
});

test('project-derived selected agent cannot override the sole agent label', () => {
  const current = candidateSnapshot(selection({ selectedAgent: 'agent:codex' }));
  assert.equal(current.agentLabel, 'agent:claude');
  assert.equal(evaluateCandidateAdmission({ initial: current, current, approvers: ['gpcola'] }).reason, 'candidate-agent-field-label-conflict');
});

test('proceed-command revision change fails closed', () => {
  const initial = candidateSnapshot(selection({ mode: 'proceed-command', command: command(200) }));
  const current = candidateSnapshot(selection({ mode: 'proceed-command', command: command(201) }));
  assert.equal(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }).reason, 'candidate-command-revision-changed');
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
