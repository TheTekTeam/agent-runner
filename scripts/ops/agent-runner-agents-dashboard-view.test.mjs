import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMutationHeaders,
  buildPaidEnableConfirmationCopy,
  buildSecretRequestBody,
  classifyExecutionSurface,
  describeActionAvailability,
  describeContextOutputLimits,
  describeCostClass,
  describeCurrentSlot,
  describeReadiness,
  describeState,
  describeVersionPolicy,
  findLastStateChange,
  formatPercent,
  formatTimestamp,
  isSecretValueValid,
  listSupportedCapabilities,
  requiresPaidEnableConfirmation,
  secretStatusLabel,
} from '../../.agent-runner/agents-dashboard/agents-dashboard-view.mjs';

// -- execution surface / cost class / version policy (required views #2, #3, #9) --

test('classifyExecutionSurface matches the documented three-way split', () => {
  assert.equal(classifyExecutionSurface('claude'), 'Local CLI');
  assert.equal(classifyExecutionSurface('codex'), 'Local CLI');
  assert.equal(classifyExecutionSurface('ollama'), 'Local model (via OpenCode harness)');
  assert.equal(classifyExecutionSurface('gpt'), 'External / manual');
  assert.equal(classifyExecutionSurface('gemini'), 'External / manual');
  assert.equal(classifyExecutionSurface('made-up-type'), 'External / manual');
});

test('describeCostClass renders the three server-computed cost classes honestly', () => {
  assert.equal(describeCostClass('paid-metered'), 'Paid (metered)');
  assert.equal(describeCostClass('free-local-zero-spend'), 'Free (local, zero-spend)');
  assert.equal(describeCostClass('not-yet-qualified'), 'Not yet qualified');
  assert.equal(describeCostClass(undefined), 'Unknown');
});

test('describeVersionPolicy never fabricates a version number', () => {
  assert.match(describeVersionPolicy({ agentId: 'claude-code-cli', implemented: true }), /Unpinned/);
  assert.match(describeVersionPolicy({ agentId: 'ollama-agent', implemented: false }), /Not yet qualified/);
  for (const label of [
    describeVersionPolicy({ agentId: 'claude-code-cli', implemented: true }),
    describeVersionPolicy({ agentId: 'ollama-agent', implemented: false }),
  ]) {
    assert.ok(!/\d+\.\d+\.\d+/.test(label), `must not contain a fabricated semver: ${label}`);
  }
});

// -- state / readiness explanations (required views #4, #5, #6, #12) --

test('describeState covers every #40 lifecycle state plus the derived overlays', () => {
  for (const state of ['enabled', 'paused', 'draining', 'disabled', 'unavailable', 'unsupported']) {
    const text = describeState(state);
    assert.ok(text && text !== 'Unknown state.', `missing explanation for ${state}`);
  }
  assert.equal(describeState('made-up-state'), 'Unknown state.');
});

test('describeReadiness never surfaces a probe detail (which may hold a resolved filesystem path)', () => {
  assert.equal(describeReadiness(null), 'Not probed (foundation-only adapter).');
  assert.equal(describeReadiness({ ok: true }), 'Ready.');
  const text = describeReadiness({ ok: false, reason: 'command-not-on-path', probes: [{ probe: 'executable', detail: '/usr/local/bin/claude' }] });
  assert.equal(text, 'Not ready (command-not-on-path).');
  assert.ok(!text.includes('/usr/local/bin/claude'), 'must never render a probe detail / filesystem path');
});

test('describeContextOutputLimits is an honest "not modeled" label, not a fabricated limit', () => {
  const text = describeContextOutputLimits({ timeout: 60000 });
  assert.match(text, /Not modeled/);
  assert.match(text, /60s/);
});

test('describeCurrentSlot reflects the read-only load block without inventing a queue model', () => {
  assert.equal(describeCurrentSlot(null), 'Not tracked.');
  assert.equal(describeCurrentSlot({ active: 0 }), 'Slot idle — no active execution.');
  assert.equal(describeCurrentSlot({ active: 1 }), 'Slot occupied — an execution is currently active or unresolved.');
});

// -- capability classes (required view #7) --

test('listSupportedCapabilities reads only capabilities explicitly marked supported:true', () => {
  const capabilities = {
    model: { supported: true, flag: '--model' },
    effort: { supported: true, flag: '--effort' },
    worktree: { supported: false },
  };
  assert.deepEqual(listSupportedCapabilities(capabilities), ['effort', 'model']);
  assert.deepEqual(listSupportedCapabilities(null), []);
  assert.deepEqual(listSupportedCapabilities(undefined), []);
});

// -- audit-derived "last state change" (required view #11) --

test('findLastStateChange picks the most recent entry touching this agent, ignoring other agents', () => {
  const entries = [
    { at: '2026-07-24T10:00:00.000Z', changedFields: ['agents.ollama-agent.enabled'] },
    { at: '2026-07-24T09:00:00.000Z', changedFields: ['agents.claude-code-cli.enabled', 'agents.claude-code-cli.paused'] },
    { at: '2026-07-24T08:00:00.000Z', changedFields: ['agents.claude-code-cli'] },
  ];
  assert.equal(findLastStateChange(entries, 'claude-code-cli'), '2026-07-24T09:00:00.000Z');
  assert.equal(findLastStateChange(entries, 'gemini-cli'), null);
  assert.equal(findLastStateChange([], 'claude-code-cli'), null);
  assert.equal(findLastStateChange(undefined, 'claude-code-cli'), null);
});

test('findLastStateChange does not false-positive on a field-name prefix collision', () => {
  // 'agents.claude-code-cli-extra' must not match agentId 'claude-code-cli'.
  const entries = [{ at: '2026-07-24T10:00:00.000Z', changedFields: ['agents.claude-code-cli-extra.enabled'] }];
  assert.equal(findLastStateChange(entries, 'claude-code-cli'), null);
});

// -- required view #17: explicit confirmation for paid-agent enablement --

test('requiresPaidEnableConfirmation is true only for an implemented, paid (quota.paid) instance', () => {
  assert.equal(requiresPaidEnableConfirmation({ implemented: true, quota: { paid: true } }), true);
  assert.equal(requiresPaidEnableConfirmation({ implemented: false, quota: { paid: true } }), false);
  assert.equal(requiresPaidEnableConfirmation({ implemented: true, quota: { paid: false } }), false);
  assert.equal(requiresPaidEnableConfirmation({ implemented: true }), false);
});

test('buildPaidEnableConfirmationCopy names the agent and states the consequence plainly', () => {
  const copy = buildPaidEnableConfirmationCopy({ agentId: 'claude-code-cli' });
  assert.match(copy, /claude-code-cli/);
  assert.match(copy, /paid/i);
});

// -- required view #12: explanations for unavailable actions --

test('describeActionAvailability: create is blocked only once already registered', () => {
  assert.equal(describeActionAvailability('create', { created: false, implemented: true }).available, true);
  assert.equal(describeActionAvailability('create', { created: false, implemented: false }).available, true);
  assert.equal(describeActionAvailability('create', { created: true, implemented: true }).available, false);
});

test('describeActionAvailability: lifecycle actions require a created, implemented instance not already in that state', () => {
  assert.equal(describeActionAvailability('enabled', { created: false, implemented: true, state: 'disabled' }).available, false);
  assert.equal(describeActionAvailability('enabled', { created: true, implemented: false, state: 'unsupported' }).available, false);
  assert.equal(describeActionAvailability('enabled', { created: true, implemented: true, state: 'enabled' }).available, false);
  assert.equal(describeActionAvailability('enabled', { created: true, implemented: true, state: 'disabled' }).available, true);
});

test('describeActionAvailability: unknown instance fails closed', () => {
  assert.equal(describeActionAvailability('enabled', null).available, false);
});

// -- write-only credential handling: never a leak vector --

test('buildSecretRequestBody produces exactly {value} — nothing extra that could carry metadata alongside the secret', () => {
  assert.deepEqual(buildSecretRequestBody('a-value'), { value: 'a-value' });
  assert.deepEqual(Object.keys(buildSecretRequestBody('x')), ['value']);
});

test('isSecretValueValid rejects empty/non-string values', () => {
  assert.equal(isSecretValueValid('x'), true);
  assert.equal(isSecretValueValid(''), false);
  assert.equal(isSecretValueValid(null), false);
  assert.equal(isSecretValueValid(undefined), false);
  assert.equal(isSecretValueValid(123), false);
});

test('buildMutationHeaders carries the CSRF token and nothing secret-shaped', () => {
  const headers = buildMutationHeaders('a-csrf-token');
  assert.deepEqual(headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': 'a-csrf-token' });
});

test('secretStatusLabel covers the full #45 status enum', () => {
  assert.equal(secretStatusLabel('configured'), 'Configured');
  assert.equal(secretStatusLabel('missing'), 'Missing');
  assert.equal(secretStatusLabel('invalid'), 'Invalid');
  assert.equal(secretStatusLabel('rotation-required'), 'Rotation required');
  assert.equal(secretStatusLabel('made-up'), 'Unknown');
});

// -- formatting helpers --

test('formatPercent and formatTimestamp degrade gracefully on missing/invalid data', () => {
  assert.equal(formatPercent(12.34), '12.3%');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatPercent(undefined), '—');
  assert.equal(formatPercent(Number.NaN), '—');
  assert.equal(formatTimestamp(null), '—');
  assert.equal(formatTimestamp('not-a-date'), '—');
  assert.ok(formatTimestamp('2026-07-24T00:00:00.000Z').length > 0);
});
