import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_ADAPTERS } from './agent-runner-agents.mjs';
import { evaluateAgentEligibility, PAID_AGENT_IDS } from './agent-runner-routing.mjs';

const CODEX_IMPLEMENTED = { ...AGENT_ADAPTERS['codex-cli'], implemented: true, command: 'codex' };
const CLASSIFIED = { taskClass: 'code', riskClass: 'low', model: null, harness: null };
const READY = { healthy: true, ready: true };
const SETTINGS = {
  lifecycle: { enabled: true, paused: false, draining: false, disabled: false },
  qualification: { taskClasses: ['*'], riskClasses: ['*'], models: ['*'], harness: '*' },
  // Deliberately false: once current quota/resource evidence exists, Codex
  // eligibility must not depend on paid/credit approval or account balance.
  paidUse: { paidUseApproved: false, automaticRoutingApproved: false, hasPositiveCap: false },
};

test('legacy paid-adapter compatibility does not override positively resolved Codex quota state', () => {
  assert.equal(PAID_AGENT_IDS.includes('codex-cli'), true);
  assert.equal(PAID_AGENT_IDS.includes('grok-cli'), true);

  const decision = evaluateAgentEligibility({
    agentId: 'codex-cli',
    adapter: CODEX_IMPLEMENTED,
    settingsEntry: SETTINGS,
    readiness: READY,
    classification: CLASSIFIED,
    resourceState: { blocked: false },
  });

  assert.equal(decision.status, 'eligible');
  assert.deepEqual(decision.reasons, []);
});

test('Codex CLI is excluded when its quota/resource state is blocked, without adding credit-policy reasons', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'codex-cli',
    adapter: CODEX_IMPLEMENTED,
    settingsEntry: SETTINGS,
    readiness: READY,
    classification: CLASSIFIED,
    resourceState: { blocked: true, reason: 'codex-quota-blocked' },
  });

  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('codex-quota-blocked'));
  assert.ok(!decision.reasons.includes('paid-use-not-approved'));
  assert.ok(!decision.reasons.includes('automatic-routing-not-approved'));
  assert.ok(!decision.reasons.includes('no-positive-cost-or-token-cap'));
});
