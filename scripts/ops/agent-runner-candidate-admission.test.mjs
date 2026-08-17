import assert from 'node:assert/strict';
import test from 'node:test';

import {
  admitCurrentCandidate,
  candidatePausePayload,
  candidateSnapshot,
  evaluateCandidateAdmission,
  evaluateCandidateMachineProfileAdmission,
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
  approvedAgent = 'claude-code-cli',
  packetNote = '',
} = {}) {
  const preflight = preflightId == null ? null : {
    id: preflightId,
    databaseId: preflightId,
    createdAt: `2026-07-23T19:${String(preflightId).slice(-2).padStart(2, '0')}:00Z`,
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: AR-${preflightId}\nfingerprint: sha256:${String(preflightId).padStart(64, '0')}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: ${approvedAgent}\nexecution_phase: implementation\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\`\n${packetNote}`,
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

test('historical proceed-command selection cannot authorize a new claim', () => {
  const initial = candidateSnapshot(selection({ mode: 'proceed-command', command: command(200) }));
  const current = candidateSnapshot(selection({ mode: 'proceed-command', command: command(200) }));
  assert.deepEqual(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }), {
    allowed: false,
    reason: 'candidate-manager-preflight-required',
  });
});

test('a proceed comment attached to preflight-direct selection is non-authoritative', () => {
  const initial = candidateSnapshot(selection({ command: command(200) }));
  const current = candidateSnapshot(selection({ command: command(200) }));
  assert.deepEqual(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }), {
    allowed: false,
    reason: 'candidate-proceed-command-not-authoritative',
  });
});

test('mode change from proceed compatibility selection to preflight-direct fails closed', () => {
  const initial = candidateSnapshot(selection({ mode: 'proceed-command', command: command(200) }));
  const current = candidateSnapshot(selection());
  assert.equal(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }).reason, 'candidate-dispatch-mode-changed');
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

test('preflight revision change fails closed', () => {
  const initial = candidateSnapshot(selection({ preflightId: 100 }));
  const current = candidateSnapshot(selection({ preflightId: 101 }));
  assert.equal(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }).reason, 'candidate-preflight-revision-changed');
});



test('packet text edits without a new revision fail revalidation', () => {
  const initial = candidateSnapshot(selection({ packetNote: 'Original bounded scope.' }));
  const current = candidateSnapshot(selection({ packetNote: 'Expanded scope with the same revision.' }));
  assert.equal(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }).reason, 'candidate-preflight-content-changed');
});

test('manager packet approved agent must match the selected adapter', () => {
  const initial = candidateSnapshot(selection({ approvedAgent: 'codex-cli' }));
  const current = candidateSnapshot(selection({ approvedAgent: 'codex-cli' }));
  assert.equal(evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }).reason, 'candidate-preflight-agent-not-approved');
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

function preflightWithBudget(maxBudgetLine) {
  return {
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: AR-226\nfingerprint: sha256:${'0'.repeat(64)}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nprofile: narrow\nmodel: sonnet\neffort: low\n${maxBudgetLine}\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\``,
  };
}

test('quoted manager max_budget_usd normalizes and passes the machine cost gate', () => {
  const decision = evaluateCandidateMachineProfileAdmission({
    issue: { number: 5, title: 'narrow test issue', labels: [] },
    preflight: preflightWithBudget('max_budget_usd: "1.00"'),
    env: { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2' },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.scope, 'machine_profile');
  assert.equal(decision.costAdmission.requested.maxBudgetUsd, 1.0);
});

test('unquoted manager max_budget_usd is equivalent to the quoted form', () => {
  const decision = evaluateCandidateMachineProfileAdmission({
    issue: { number: 5, title: 'narrow test issue', labels: [] },
    preflight: preflightWithBudget('max_budget_usd: 1.00'),
    env: { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2' },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.costAdmission.requested.maxBudgetUsd, 1.0);
});

test('genuine over-cap manager budget fails closed with machine_profile scope', () => {
  const decision = evaluateCandidateMachineProfileAdmission({
    issue: { number: 5, title: 'narrow test issue', labels: [] },
    preflight: preflightWithBudget('max_budget_usd: "2.50"'),
    env: { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2' },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.scope, 'machine_profile');
  assert.equal(decision.reason, 'candidate-machine-profile-cost-denied');
  assert.ok(decision.violations.includes('budget-cap-exceeds-machine-policy'));
  assert.ok(decision.safeNextAction);
});

for (const malformed of ['max_budget_usd: "2.00\'', 'max_budget_usd: ""', 'max_budget_usd: not-a-number', 'max_budget_usd: 0', 'max_budget_usd: -1.00']) {
  test(`malformed/zero/negative manager budget (${malformed}) fails closed without profile-default fallback`, () => {
    const decision = evaluateCandidateMachineProfileAdmission({
      issue: { number: 5, title: 'narrow test issue', labels: [] },
      preflight: preflightWithBudget(malformed),
      env: { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2' },
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.scope, 'machine_profile');
    assert.ok(decision.violations.includes('budget-cap-exceeds-machine-policy'));
    assert.notEqual(decision.costAdmission.requested.maxBudgetUsd, 0.5);
  });
}

test('opus model requires explicit machine-local opt-in through the same cost gate', () => {
  const decision = evaluateCandidateMachineProfileAdmission({
    issue: { number: 5, title: 'narrow test issue', labels: [] },
    preflight: preflightWithBudget('max_budget_usd: "1.00"'),
    argsModel: 'opus',
    env: { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2' },
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.violations.includes('opus-requires-explicit-machine-opt-in'));

  const allowed = evaluateCandidateMachineProfileAdmission({
    issue: { number: 5, title: 'narrow test issue', labels: [] },
    preflight: preflightWithBudget('max_budget_usd: "1.00"'),
    argsModel: 'opus',
    env: { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2', CLAUDE_RUNNER_ALLOW_OPUS: 'true' },
  });
  assert.equal(allowed.allowed, true);
});

test('xhigh effort requires explicit machine-local opt-in through the same cost gate', () => {
  const decision = evaluateCandidateMachineProfileAdmission({
    issue: { number: 5, title: 'narrow test issue', labels: [] },
    preflight: preflightWithBudget('max_budget_usd: "1.00"'),
    argsEffort: 'xhigh',
    env: { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2' },
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.violations.includes('high-effort-requires-explicit-machine-opt-in'));
});

test('manager authority/agent/status/comment identity drift keeps its existing issue_not_runnable reason', () => {
  const initial = candidateSnapshot(selection({ approvedAgent: 'codex-cli' }));
  const current = candidateSnapshot(selection({ approvedAgent: 'codex-cli' }));
  const admission = evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] });
  assert.equal(admission.reason, 'candidate-preflight-agent-not-approved');
  const payload = candidatePausePayload(admission, current);
  assert.equal(payload.failureScope, 'issue_not_runnable');
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
