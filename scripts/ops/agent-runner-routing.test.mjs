import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_ADAPTERS } from './agent-runner-agents.mjs';
import {
  evaluateAgentEligibility,
  GLOBAL_EXECUTION_SLOT_CAPACITY,
  hasGlobalSlotAvailable,
  PAID_AGENT_IDS,
  selectAgentForIssue,
} from './agent-runner-routing.mjs';
import { QUALIFICATION_WILDCARD as WILDCARD } from './agent-runner-agent-settings.mjs';

const CLAUDE_ADAPTER = AGENT_ADAPTERS['claude-code-cli'];
const CODEX_ADAPTER = AGENT_ADAPTERS['codex-cli'];
const GROK_ADAPTER = AGENT_ADAPTERS['grok-cli'];
const OLLAMA_ADAPTER = AGENT_ADAPTERS['ollama-agent'];

const UNCLASSIFIED = { taskClass: null, riskClass: null, model: null, harness: null };

function wildcardSettings(overrides = {}) {
  return {
    lifecycle: { enabled: true, paused: false, draining: false, disabled: false },
    qualification: { taskClasses: [WILDCARD], riskClasses: [WILDCARD], models: [WILDCARD], harness: WILDCARD },
    paidUse: { paidUseApproved: false, automaticRoutingApproved: false, hasPositiveCap: false },
    ...overrides,
  };
}

// -- global slot --

test('hasGlobalSlotAvailable enforces exactly capacity 1 -- this issue adds no concurrency path', () => {
  assert.equal(GLOBAL_EXECUTION_SLOT_CAPACITY, 1);
  assert.equal(hasGlobalSlotAvailable(0), true);
  assert.equal(hasGlobalSlotAvailable(1), false);
  assert.equal(hasGlobalSlotAvailable(2), false);
});

// -- explicit eligible Claude assignment retained --

test('explicit eligible Claude assignment is retained', () => {
  const result = selectAgentForIssue({
    explicitAgentId: 'claude-code-cli',
    classification: UNCLASSIFIED,
    candidates: [{ agentId: 'claude-code-cli', adapter: CLAUDE_ADAPTER, settingsEntry: wildcardSettings() }],
  });
  assert.equal(result.selectedAgentId, 'claude-code-cli');
  assert.equal(result.reassigned, false);
  assert.equal(result.reason, 'explicit-assignment-retained');
});

// -- disabled / paused / draining / unhealthy Claude --

test('disabled Claude is excluded with a bounded reason', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'claude-code-cli',
    adapter: CLAUDE_ADAPTER,
    settingsEntry: wildcardSettings({ lifecycle: { enabled: true, paused: false, draining: false, disabled: true } }),
    classification: UNCLASSIFIED,
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('agent-disabled'));
});

test('paused Claude is excluded with a bounded reason', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'claude-code-cli',
    adapter: CLAUDE_ADAPTER,
    settingsEntry: wildcardSettings({ lifecycle: { enabled: true, paused: true, draining: false, disabled: false } }),
    classification: UNCLASSIFIED,
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('agent-paused'));
});

test('draining Claude is excluded with a bounded reason', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'claude-code-cli',
    adapter: CLAUDE_ADAPTER,
    settingsEntry: wildcardSettings({ lifecycle: { enabled: true, paused: false, draining: true, disabled: false } }),
    classification: UNCLASSIFIED,
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('agent-draining'));
});

test('unhealthy Claude (readiness probe failed) is excluded with a bounded reason', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'claude-code-cli',
    adapter: CLAUDE_ADAPTER,
    settingsEntry: wildcardSettings(),
    readiness: { healthy: false, ready: false },
    classification: UNCLASSIFIED,
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('agent-unhealthy-or-not-ready'));
});

// -- Claude quota blocked while a synthetic alternative remains eligible --

test('Claude quota blocked excludes only Claude; a synthetic eligible alternative is still selected (Claude quota is agent-local)', () => {
  const syntheticAdapter = { agentId: 'future-agent', type: 'future', command: 'future-cli', implemented: true };
  const result = selectAgentForIssue({
    explicitAgentId: 'claude-code-cli',
    classification: UNCLASSIFIED,
    candidates: [
      { agentId: 'claude-code-cli', adapter: CLAUDE_ADAPTER, settingsEntry: wildcardSettings(), resourceState: { blocked: true, reason: 'claude-quota-blocked' } },
      { agentId: 'future-agent', adapter: syntheticAdapter, settingsEntry: wildcardSettings() },
    ],
  });
  assert.equal(result.selectedAgentId, 'future-agent');
  assert.equal(result.reassigned, true);
  const claudeDecision = result.decisions.find((d) => d.agentId === 'claude-code-cli');
  assert.equal(claudeDecision.status, 'excluded');
  assert.ok(claudeDecision.reasons.includes('claude-quota-blocked'));
});

test('Claude quota block still excludes Claude even when no alternative exists -- Claude keeps its own quota protection', () => {
  const result = selectAgentForIssue({
    explicitAgentId: 'claude-code-cli',
    classification: UNCLASSIFIED,
    candidates: [
      { agentId: 'claude-code-cli', adapter: CLAUDE_ADAPTER, settingsEntry: wildcardSettings(), resourceState: { blocked: true, reason: 'claude-quota-blocked' } },
    ],
  });
  assert.equal(result.selectedAgentId, null);
  assert.equal(result.reason, 'no-qualified-agent');
});

// -- unsupported adapter / implemented:false --

test('an unsupported (uncatalogued) adapter is excluded', () => {
  const decision = evaluateAgentEligibility({ agentId: 'unknown-agent', adapter: null, settingsEntry: wildcardSettings(), classification: UNCLASSIFIED });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('not-in-approved-catalogue'));
});

test('an implemented:false catalogue adapter (codex-cli) is excluded regardless of settings', () => {
  const decision = evaluateAgentEligibility({ agentId: 'codex-cli', adapter: CODEX_ADAPTER, settingsEntry: wildcardSettings(), classification: UNCLASSIFIED });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('not-implemented'));
});

// -- missing qualification / task-risk / model / harness mismatch --

test('missing qualification (empty lists, no settings entry) means unqualified', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'ollama-agent',
    adapter: { ...OLLAMA_ADAPTER, implemented: true },
    settingsEntry: null,
    classification: { taskClass: 'docs', riskClass: 'low', model: null, harness: null },
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('no-settings-entry'));
});

test('task/risk mismatch excludes a candidate qualified only for a different class', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'ollama-agent',
    adapter: { ...OLLAMA_ADAPTER, implemented: true },
    settingsEntry: {
      lifecycle: { enabled: true, paused: false, draining: false, disabled: false },
      qualification: { taskClasses: ['docs'], riskClasses: ['low'], models: [], harness: null },
      paidUse: { paidUseApproved: false, automaticRoutingApproved: false, hasPositiveCap: false },
    },
    classification: { taskClass: 'code', riskClass: 'low', model: null, harness: null },
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('task-class-not-qualified'));
});

test('model mismatch excludes an otherwise-eligible candidate', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'claude-code-cli',
    adapter: CLAUDE_ADAPTER,
    settingsEntry: wildcardSettings({ qualification: { taskClasses: [WILDCARD], riskClasses: [WILDCARD], models: ['claude-sonnet-5'], harness: WILDCARD } }),
    classification: { taskClass: null, riskClass: null, model: 'claude-opus-4-8', harness: null },
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('model-not-qualified'));
});

test('harness mismatch excludes an otherwise-eligible candidate', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'claude-code-cli',
    adapter: CLAUDE_ADAPTER,
    settingsEntry: wildcardSettings({ qualification: { taskClasses: [WILDCARD], riskClasses: [WILDCARD], models: [WILDCARD], harness: 'cli-v1' } }),
    classification: { taskClass: null, riskClass: null, model: null, harness: 'cli-v2' },
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('harness-not-qualified'));
});

test('conflicting structured metadata (already resolved to null upstream) never yields a permissive match for a narrowly qualified agent', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'ollama-agent',
    adapter: { ...OLLAMA_ADAPTER, implemented: true },
    settingsEntry: {
      lifecycle: { enabled: true, paused: false, draining: false, disabled: false },
      qualification: { taskClasses: ['docs'], riskClasses: ['low'], models: [], harness: null },
      paidUse: { paidUseApproved: false, automaticRoutingApproved: false, hasPositiveCap: false },
    },
    classification: UNCLASSIFIED,
  });
  assert.equal(decision.status, 'excluded');
});

// -- paid automatic routing --

test('paid automatic routing not approved excludes an implemented paid adapter', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'codex-cli',
    adapter: { ...CODEX_ADAPTER, implemented: true },
    settingsEntry: wildcardSettings({ paidUse: { paidUseApproved: true, automaticRoutingApproved: false, hasPositiveCap: true } }),
    classification: UNCLASSIFIED,
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('automatic-routing-not-approved'));
});

test('paid approval present but no positive cap excludes an implemented paid adapter', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'codex-cli',
    adapter: { ...CODEX_ADAPTER, implemented: true },
    settingsEntry: wildcardSettings({ paidUse: { paidUseApproved: true, automaticRoutingApproved: true, hasPositiveCap: false } }),
    classification: UNCLASSIFIED,
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('no-positive-cost-or-token-cap'));
});

test('positive cap present but paid approval missing excludes an implemented paid adapter', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'grok-cli',
    adapter: { ...GROK_ADAPTER, implemented: true },
    settingsEntry: wildcardSettings({ paidUse: { paidUseApproved: false, automaticRoutingApproved: true, hasPositiveCap: true } }),
    classification: UNCLASSIFIED,
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('paid-use-not-approved'));
});

test('an implemented paid adapter with automaticRoutingApproved, paidUseApproved and a positive cap is eligible', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'grok-cli',
    adapter: { ...GROK_ADAPTER, implemented: true },
    settingsEntry: wildcardSettings({ paidUse: { paidUseApproved: true, automaticRoutingApproved: true, hasPositiveCap: true } }),
    classification: UNCLASSIFIED,
  });
  assert.equal(decision.status, 'eligible');
  assert.equal(PAID_AGENT_IDS.includes('grok-cli'), true);
});

test('Codex/Grok explicitly assigned but not implemented remain excluded -- explicit assignment never bypasses the implemented gate', () => {
  const result = selectAgentForIssue({
    explicitAgentId: 'codex-cli',
    classification: UNCLASSIFIED,
    candidates: [{ agentId: 'codex-cli', adapter: CODEX_ADAPTER, settingsEntry: wildcardSettings({ paidUse: { paidUseApproved: true, automaticRoutingApproved: true, hasPositiveCap: true } }) }],
  });
  assert.equal(result.selectedAgentId, null);
  assert.equal(result.reason, 'no-qualified-agent');
  assert.ok(result.decisions[0].reasons.includes('not-implemented'));
});

// -- Ollama non-low-risk --

test('Ollama requested for a non-low-risk class is excluded even when its own settings claim broader risk qualification', () => {
  const decision = evaluateAgentEligibility({
    agentId: 'ollama-agent',
    adapter: { ...OLLAMA_ADAPTER, implemented: true },
    settingsEntry: {
      lifecycle: { enabled: true, paused: false, draining: false, disabled: false },
      qualification: { taskClasses: ['docs'], riskClasses: ['low', 'medium'], models: [], harness: null },
      paidUse: { paidUseApproved: false, automaticRoutingApproved: false, hasPositiveCap: false },
    },
    classification: { taskClass: 'docs', riskClass: 'medium', model: null, harness: null },
  });
  assert.equal(decision.status, 'excluded');
  assert.ok(decision.reasons.includes('ollama-low-risk-boundary'));
});

// -- no qualified alternative --

test('no qualified alternative yields selectedAgentId null and reason no-qualified-agent', () => {
  const result = selectAgentForIssue({
    explicitAgentId: 'claude-code-cli',
    classification: UNCLASSIFIED,
    candidates: [
      { agentId: 'claude-code-cli', adapter: CLAUDE_ADAPTER, settingsEntry: wildcardSettings({ lifecycle: { enabled: true, paused: false, draining: false, disabled: true } }) },
      { agentId: 'codex-cli', adapter: CODEX_ADAPTER, settingsEntry: wildcardSettings() },
      { agentId: 'ollama-agent', adapter: OLLAMA_ADAPTER, settingsEntry: wildcardSettings() },
    ],
  });
  assert.equal(result.selectedAgentId, null);
  assert.equal(result.reason, 'no-qualified-agent');
});

// -- global slot unavailable --

test('global-slot-unavailable short-circuits selection even with an eligible explicit candidate', () => {
  const result = selectAgentForIssue({
    explicitAgentId: 'claude-code-cli',
    classification: UNCLASSIFIED,
    globalSlotAvailable: false,
    candidates: [{ agentId: 'claude-code-cli', adapter: CLAUDE_ADAPTER, settingsEntry: wildcardSettings() }],
  });
  assert.equal(result.selectedAgentId, null);
  assert.equal(result.reason, 'global-slot-unavailable');
});

// -- determinism / no weighting or randomness --

test('selection is deterministic: repeated calls with identical inputs produce identical results, in candidate order', () => {
  const candidates = [
    { agentId: 'claude-code-cli', adapter: CLAUDE_ADAPTER, settingsEntry: wildcardSettings({ lifecycle: { enabled: true, paused: false, draining: false, disabled: true } }) },
    { agentId: 'ollama-agent', adapter: { ...OLLAMA_ADAPTER, implemented: true }, settingsEntry: wildcardSettings() },
    { agentId: 'codex-cli', adapter: { ...CODEX_ADAPTER, implemented: true }, settingsEntry: wildcardSettings({ paidUse: { paidUseApproved: true, automaticRoutingApproved: true, hasPositiveCap: true } }) },
  ];
  const first = selectAgentForIssue({ explicitAgentId: 'claude-code-cli', classification: UNCLASSIFIED, candidates });
  const second = selectAgentForIssue({ explicitAgentId: 'claude-code-cli', classification: UNCLASSIFIED, candidates });
  assert.deepEqual(first, second);
  // ollama-agent is structurally excluded (its low-risk boundary requires an
  // explicit "low" classification; this test uses an unclassified issue),
  // so the first eligible candidate in caller order is codex-cli -- not a
  // scored/random pick between the two remaining eligible candidates.
  assert.equal(first.selectedAgentId, 'codex-cli');
});

// -- sanitization: no raw settings/secret/credential/path/endpoint/prompt/provider text survives serialization --

test('no raw settings, secretref, credential, executable path, endpoint, prompt, or provider text survives decision serialization', () => {
  const result = selectAgentForIssue({
    explicitAgentId: 'codex-cli',
    classification: UNCLASSIFIED,
    candidates: [
      {
        agentId: 'codex-cli',
        adapter: { ...CODEX_ADAPTER, implemented: true },
        settingsEntry: {
          lifecycle: { enabled: true, paused: false, draining: false, disabled: false },
          qualification: { taskClasses: [WILDCARD], riskClasses: [WILDCARD], models: [WILDCARD], harness: WILDCARD },
          paidUse: { paidUseApproved: false, automaticRoutingApproved: false, hasPositiveCap: false },
          // A settingsEntry from the real snapshot never carries these keys
          // at all (agent-runner-agent-settings.mjs strips them) -- this
          // proves evaluateAgentEligibility/selectAgentForIssue would not
          // echo them back even if a caller passed them in by mistake.
          executablePath: '/usr/local/bin/codex-secret-path',
          sessionSecretRef: 'vault://very-secret',
          endpoint: 'https://leak.example/token=abc',
        },
      },
    ],
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /executablePath|sessionSecretRef|vault:\/\/|leak\.example|codex-secret-path/);
});
