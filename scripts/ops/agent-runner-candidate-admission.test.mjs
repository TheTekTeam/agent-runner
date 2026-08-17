import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  admitCurrentCandidate,
  candidatePausePayload,
  candidateSnapshot,
  evaluateCandidateAdmission,
  evaluateCandidateCostAdmission,
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
  assert.match(decision.safeNextAction, /fresh superseding immutable manager-preflight authority/);
  assert.match(decision.safeNextAction, /existing packet must not be edited/);
  assert.match(decision.safeNextAction, /separately authorised machine-local policy change/);
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

function tmpCircuitDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-candidate-admission-circuit-'));
  return join(dir, 'circuit.sqlite');
}

function selectionWithBudget({ maxBudgetLine = 'max_budget_usd: "2.50"', model = 'sonnet', effort = 'low', preflightId = 300 } = {}) {
  const preflight = {
    id: preflightId,
    databaseId: preflightId,
    createdAt: '2026-08-17T20:00:00Z',
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: AR-${preflightId}\nfingerprint: sha256:${String(preflightId).padStart(64, '0')}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nprofile: narrow\nmodel: ${model}\neffort: ${effort}\n${maxBudgetLine}\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\``,
    user: { login: 'gpcola' },
  };
  return {
    issue: { number: 9, labels: ['status:ready', 'agent:claude'], statusLabel: 'status:ready', agentLabel: 'agent:claude' },
    selection: { mode: 'preflight-direct', command: null, preflight },
    command: null,
    currentPreflight: preflight,
  };
}

test('historical #205 shape: a synthetic over-cap manager budget refuses with machine_profile scope before any attempt/claim/child side effect', async () => {
  const dbPath = tmpCircuitDbPath();
  const values = [selectionWithBudget(), selectionWithBudget()];
  let calls = 0;
  const result = await admitCurrentCandidate({
    env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola', CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2', AGENT_RUNNER_CIRCUIT_DB: dbPath },
    select: async () => values[calls++],
  });
  assert.equal(result.admission.allowed, false);
  assert.equal(result.admission.scope, 'machine_profile');
  assert.equal(result.admission.reason, 'candidate-machine-profile-cost-denied');
  assert.ok(result.admission.violations.includes('budget-cap-exceeds-machine-policy'));
  assert.match(result.admission.effectiveFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.admission.occurrenceCount, 1);

  const payload = candidatePausePayload(result.admission, result.current);
  assert.equal(payload.failureScope, 'machine_profile');
  assert.equal(payload.attemptCreated, false);
  assert.equal(payload.childLaunched, false);
  assert.equal(payload.issueMutation, false);
  assert.equal(payload.systemdOutcome, 'handled');
});

test('same candidate profile at or below the machine cap continues past the cost gate unchanged', async () => {
  const dbPath = tmpCircuitDbPath();
  const values = [selectionWithBudget({ preflightId: 310, maxBudgetLine: 'max_budget_usd: "1.00"' }), selectionWithBudget({ preflightId: 310, maxBudgetLine: 'max_budget_usd: "1.00"' })];
  let calls = 0;
  const result = await admitCurrentCandidate({
    env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola', CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2', AGENT_RUNNER_CIRCUIT_DB: dbPath },
    select: async () => values[calls++],
  });
  assert.equal(result.admission.allowed, true);
  assert.equal(result.admission.reason, 'candidate-admitted');
});

test('a repeated identical candidate-effective refusal stays deduped as one bounded circuit incident, and a fresh compliant manager authority is not blocked by the stale entry', async () => {
  const dbPath = tmpCircuitDbPath();
  const overCap = [selectionWithBudget({ preflightId: 320 }), selectionWithBudget({ preflightId: 320 })];
  let calls = 0;
  const first = await admitCurrentCandidate({
    env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola', CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2', AGENT_RUNNER_CIRCUIT_DB: dbPath },
    select: async () => overCap[calls++],
  });
  assert.equal(first.admission.scope, 'machine_profile');
  assert.equal(first.admission.occurrenceCount, 1);

  calls = 0;
  const second = await admitCurrentCandidate({
    env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola', CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2', AGENT_RUNNER_CIRCUIT_DB: dbPath },
    select: async () => overCap[calls++],
  });
  assert.equal(second.admission.effectiveFingerprint, first.admission.effectiveFingerprint);
  assert.equal(second.admission.occurrenceCount, 2, 'the same fingerprint/reason must dedupe into one incrementing incident');

  const compliant = [
    selectionWithBudget({ preflightId: 321, maxBudgetLine: 'max_budget_usd: "1.00"' }),
    selectionWithBudget({ preflightId: 321, maxBudgetLine: 'max_budget_usd: "1.00"' }),
  ];
  calls = 0;
  const third = await admitCurrentCandidate({
    env: { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola', CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2', AGENT_RUNNER_CIRCUIT_DB: dbPath },
    select: async () => compliant[calls++],
  });
  assert.equal(third.admission.allowed, true, 'a fresh superseding authority with a compliant budget must not be blocked by a stale candidate circuit entry');
});

test('evaluateCandidateCostAdmission passes through machine-admitted candidates without touching the circuit', () => {
  const dbPath = tmpCircuitDbPath();
  const result = evaluateCandidateCostAdmission({
    issue: { number: 5, title: 'narrow test issue', labels: [] },
    preflight: { body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: AR-330\nfingerprint: sha256:${'0'.repeat(64)}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nprofile: narrow\nmodel: sonnet\neffort: low\nmax_budget_usd: "1.00"\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\`` },
    env: { CLAUDE_RUNNER_MAX_BUDGET_USD_PER_ATTEMPT: '2', AGENT_RUNNER_CIRCUIT_DB: dbPath },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.decision.scope, 'machine_profile');
});
