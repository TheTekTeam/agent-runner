import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getAgentSettings } from './agent-runner-agent-settings.mjs';
import { readControlAuditEntries } from './agent-runner-control-audit.mjs';
import {
  applyAllowlistedUpdate,
  applyLifecycleTransition,
  buildInstanceSnapshot,
  claimEligibility,
  createInstance,
  deriveInstanceState,
  evaluateClaimEligibility,
  getInstanceSnapshot,
  InstanceAdapterNotApprovedError,
  InstanceAlreadyExistsError,
  InstanceNotFoundError,
  InstanceUpdateRejectedError,
  listInstanceSnapshots,
  transitionInstanceLifecycle,
  updateInstanceSettings,
  validateEndpointValue,
  validateMaxConcurrencyValue,
  validatePolicyValue,
} from './agent-runner-control-instances.mjs';

function withTempPaths(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-control-instances-'));
  try {
    return fn({ settingsPath: join(dir, 'agent-settings.json'), auditPath: join(dir, 'audit.jsonl') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ACTOR = { actor: 'operator', source: 'test' };

test('createInstance refuses an adapter id outside the approved catalogue', () => withTempPaths(({ settingsPath, auditPath }) => {
  assert.throws(
    () => createInstance({ path: settingsPath, auditPath, agentId: 'totally-made-up-agent', ...ACTOR }),
    InstanceAdapterNotApprovedError,
  );
}));

test('createInstance seeds the safe-disabled default and is idempotent-refusing on a second create', () => withTempPaths(({ settingsPath, auditPath }) => {
  const result = createInstance({ path: settingsPath, auditPath, agentId: 'claude-code-cli', ...ACTOR });
  assert.equal(result.snapshot.lifecycle.enabled, false);
  assert.equal(result.snapshot.lifecycle.disabled, true);
  assert.equal(result.snapshot.maxConcurrency, 1);
  assert.throws(() => createInstance({ path: settingsPath, auditPath, agentId: 'claude-code-cli', ...ACTOR }), InstanceAlreadyExistsError);
}));

test('updateInstanceSettings rejects an update to a non-existent instance', () => withTempPaths(({ settingsPath, auditPath }) => {
  assert.throws(
    () => updateInstanceSettings({ path: settingsPath, auditPath, agentId: 'claude-code-cli', updates: { model: 'x' }, ...ACTOR }),
    InstanceNotFoundError,
  );
}));

test('updateInstanceSettings applies an allowlisted field and records only field names in the audit trail', () => withTempPaths(({ settingsPath, auditPath }) => {
  createInstance({ path: settingsPath, auditPath, agentId: 'claude-code-cli', ...ACTOR });
  const result = updateInstanceSettings({
    path: settingsPath,
    auditPath,
    agentId: 'claude-code-cli',
    updates: { model: 'claude-opus-4-8', timeout: 60000 },
    ...ACTOR,
  });
  assert.equal(result.snapshot.model, 'claude-opus-4-8');
  assert.equal(result.snapshot.timeout, 60000);

  const entries = readControlAuditEntries({ path: auditPath, limit: 10 });
  const updateEntry = entries.find((entry) => entry.action === 'instance.settings.update');
  assert.ok(updateEntry);
  assert.deepEqual(updateEntry.changedFields.sort(), ['agents.claude-code-cli.model', 'agents.claude-code-cli.timeout']);
  assert.ok(!JSON.stringify(entries).includes('claude-opus-4-8'));
}));

test('updateInstanceSettings rejects any field outside the positive allowlist, including executablePath', () => withTempPaths(({ settingsPath, auditPath }) => {
  createInstance({ path: settingsPath, auditPath, agentId: 'claude-code-cli', ...ACTOR });
  for (const field of ['executablePath', 'env', 'shellCommand', 'enabled', 'endpointAllowlistHosts']) {
    assert.throws(
      () => updateInstanceSettings({ path: settingsPath, auditPath, agentId: 'claude-code-cli', updates: { [field]: 'x' }, ...ACTOR }),
      InstanceUpdateRejectedError,
    );
  }
}));

test('updateInstanceSettings rejects Codex-specific credential/paid-use fields outside the positive allowlist', () => withTempPaths(({ settingsPath, auditPath }) => {
  createInstance({ path: settingsPath, auditPath, agentId: 'codex-cli', ...ACTOR });
  for (const field of ['sessionSecretRef', 'executablePath', 'paidUseApproved', 'maxCostUsdPerRun', 'maxTokensPerRun']) {
    assert.throws(
      () => updateInstanceSettings({ path: settingsPath, auditPath, agentId: 'codex-cli', updates: { [field]: 'x' }, ...ACTOR }),
      InstanceUpdateRejectedError,
    );
  }
}));

test('a codex-cli entry carrying a sessionSecretRef never surfaces it in a built or listed snapshot', () => {
  const adapter = { agentId: 'codex-cli', type: 'codex', command: null, implemented: false, controls: {} };
  const entry = {
    enabled: false, paused: false, draining: false, disabled: true,
    executablePath: '/usr/local/bin/codex',
    sessionSecretRef: 'secretref:codex-session-token',
    paidUseApproved: false,
  };
  const snapshot = buildInstanceSnapshot({ agentId: 'codex-cli', adapter, entry });
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('secretref:'), false);
  assert.equal(serialized.includes('codex-session-token'), false);
  assert.equal(serialized.includes('/usr/local/bin/codex'), false);
});

test('listInstanceSnapshots never surfaces a sessionSecretRef present in the on-disk settings file', () => withTempPaths(({ settingsPath, auditPath }) => {
  createInstance({ path: settingsPath, auditPath, agentId: 'codex-cli', ...ACTOR });
  // Simulate a hand-edited machine-local settings file carrying adapter-specific
  // fields the control API's positive allowlist can never write (proven above).
  const doc = JSON.parse(readFileSync(settingsPath, 'utf8'));
  doc.agents['codex-cli'].sessionSecretRef = 'secretref:codex-session-token';
  doc.agents['codex-cli'].executablePath = '/usr/local/bin/codex';
  writeFileSync(settingsPath, JSON.stringify(doc, null, 2));

  const snapshots = listInstanceSnapshots({ path: settingsPath });
  const serialized = JSON.stringify(snapshots);
  assert.equal(serialized.includes('secretref:'), false);
  assert.equal(serialized.includes('codex-session-token'), false);
  assert.equal(serialized.includes('/usr/local/bin/codex'), false);
}));

test('validateMaxConcurrencyValue only ever accepts 1 — no multi-worker concurrency has a writable path', () => {
  assert.equal(validateMaxConcurrencyValue(1).ok, true);
  assert.equal(validateMaxConcurrencyValue(null).ok, true);
  for (const value of [0, 2, 5, -1, 'serial', true]) {
    assert.equal(validateMaxConcurrencyValue(value).ok, false, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('validateEndpointValue accepts only loopback http(s) endpoints', () => {
  assert.equal(validateEndpointValue('http://127.0.0.1:11434').ok, true);
  assert.equal(validateEndpointValue('http://localhost:11434').ok, true);
  assert.equal(validateEndpointValue(null).ok, true);
  assert.equal(validateEndpointValue('http://192.168.1.50:11434').ok, false);
  assert.equal(validateEndpointValue('ftp://127.0.0.1').ok, false);
  assert.equal(validateEndpointValue('not a url').ok, false);
});

test('validatePolicyValue is a closed allowlist — there is no field that can enable paid fallback', () => {
  assert.equal(validatePolicyValue({ requireHumanApproval: true }).ok, true);
  assert.equal(validatePolicyValue(null).value.requireHumanApproval, true);
  const rejected = validatePolicyValue({ paidFallbackEnabled: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'policy-field-not-allowed');
  assert.equal(validatePolicyValue({ requireHumanApproval: false }).value.requireHumanApproval, false);
});

test('applyAllowlistedUpdate rejects the whole update, not partially, on one bad field', () => {
  const result = applyAllowlistedUpdate({}, { model: 'ok-model', maxConcurrency: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.field, 'maxConcurrency');
});

test('applyLifecycleTransition only accepts the four #40 lifecycle states', () => {
  for (const state of ['enabled', 'paused', 'draining', 'disabled']) {
    assert.equal(applyLifecycleTransition({}, state).ok, true);
  }
  for (const state of ['unavailable', 'unsupported', 'running', '']) {
    assert.equal(applyLifecycleTransition({}, state).ok, false);
  }
});

test('transitionInstanceLifecycle to disabled/draining is reflected by getAgentSettings as not routable', () => withTempPaths(({ settingsPath, auditPath }) => {
  createInstance({ path: settingsPath, auditPath, agentId: 'claude-code-cli', ...ACTOR });
  transitionInstanceLifecycle({ path: settingsPath, auditPath, agentId: 'claude-code-cli', targetState: 'enabled', ...ACTOR });
  assert.equal(getAgentSettings({ agentId: 'claude-code-cli', settingsPath }).routable, true);

  transitionInstanceLifecycle({ path: settingsPath, auditPath, agentId: 'claude-code-cli', targetState: 'draining', ...ACTOR });
  assert.equal(getAgentSettings({ agentId: 'claude-code-cli', settingsPath }).routable, false);

  transitionInstanceLifecycle({ path: settingsPath, auditPath, agentId: 'claude-code-cli', targetState: 'disabled', ...ACTOR });
  assert.equal(getAgentSettings({ agentId: 'claude-code-cli', settingsPath }).routable, false);
}));

test('deriveInstanceState forces unsupported for a not-implemented catalogue adapter regardless of stored lifecycle', () => {
  const adapter = { agentId: 'ollama-agent', implemented: false };
  const lifecycle = { enabled: true, paused: false, draining: false, disabled: false };
  assert.equal(deriveInstanceState({ adapter, lifecycle }), 'unsupported');
});

test('deriveInstanceState reports unavailable only for a routable, implemented adapter whose readiness probe fails', () => {
  const adapter = { agentId: 'claude-code-cli', implemented: true };
  const lifecycle = { enabled: true, paused: false, draining: false, disabled: false };
  assert.equal(deriveInstanceState({ adapter, lifecycle, readiness: { ok: false } }), 'unavailable');
  assert.equal(deriveInstanceState({ adapter, lifecycle, readiness: { ok: true } }), 'enabled');
});

test('listInstanceSnapshots exposes the whole approved catalogue, created or not', () => withTempPaths(({ settingsPath }) => {
  const snapshots = listInstanceSnapshots({ path: settingsPath });
  const ids = snapshots.map((snapshot) => snapshot.agentId).sort();
  assert.deepEqual(ids, ['claude-code-cli', 'codex-cli', 'gemini-cli', 'gpt-agent', 'ollama-agent']);
  assert.ok(snapshots.every((snapshot) => snapshot.created === false));
}));

test('buildInstanceSnapshot surfaces the real, static adapter.controls map as capabilities (issue #47 "capability classes"), never a probe filesystem path', () => {
  const adapter = {
    agentId: 'claude-code-cli',
    type: 'claude',
    command: 'claude',
    implemented: true,
    controls: { model: { supported: true, flag: '--model' }, worktree: { supported: false } },
  };
  const snapshot = buildInstanceSnapshot({
    agentId: 'claude-code-cli',
    adapter,
    entry: null,
    readiness: { ok: false, reason: 'command-not-on-path', probes: [{ probe: 'executable', detail: '/usr/local/bin/claude' }] },
  });
  assert.equal(snapshot.command, 'claude');
  assert.deepEqual(snapshot.capabilities, adapter.controls);
  // The snapshot's readiness must never carry a probe's resolved filesystem path.
  assert.deepEqual(snapshot.readiness, { ok: false, reason: 'command-not-on-path' });
  assert.ok(!JSON.stringify(snapshot).includes('/usr/local/bin/claude'));
});

test('getInstanceSnapshot reflects a created, updated instance', () => withTempPaths(({ settingsPath, auditPath }) => {
  createInstance({ path: settingsPath, auditPath, agentId: 'claude-code-cli', ...ACTOR });
  updateInstanceSettings({ path: settingsPath, auditPath, agentId: 'claude-code-cli', updates: { profile: 'default' }, ...ACTOR });
  const snapshot = getInstanceSnapshot({ path: settingsPath, agentId: 'claude-code-cli' });
  assert.equal(snapshot.created, true);
  assert.equal(snapshot.profile, 'default');
}));

// -- claim-eligibility gate (required_validation: disabled/draining ineligible before any claim or GitHub mutation) --

test('claimEligibility is ineligible for the fully-disabled safe default', () => {
  const settings = { routable: false, reason: 'agent-disabled' };
  assert.deepEqual(claimEligibility(settings), { eligible: false, reason: 'agent-disabled' });
});

test('claimEligibility is eligible only when routable', () => {
  assert.deepEqual(claimEligibility({ routable: true }), { eligible: true, reason: 'agent-routable' });
});

test('evaluateClaimEligibility never invokes the claim/GitHub-mutation callback when the agent is disabled', () => withTempPaths(({ settingsPath, auditPath }) => {
  createInstance({ path: settingsPath, auditPath, agentId: 'claude-code-cli', ...ACTOR });
  // freshly created instance is disabled by the safe default
  let claimCalls = 0;
  let ineligibleCalls = 0;
  const decision = evaluateClaimEligibility({
    agentId: 'claude-code-cli',
    settingsPath,
    onEligible: () => { claimCalls += 1; },
    onIneligible: () => { ineligibleCalls += 1; },
  });
  assert.equal(decision.eligible, false);
  assert.equal(claimCalls, 0);
  assert.equal(ineligibleCalls, 1);
}));

test('evaluateClaimEligibility never invokes the claim callback while draining', () => withTempPaths(({ settingsPath, auditPath }) => {
  createInstance({ path: settingsPath, auditPath, agentId: 'claude-code-cli', ...ACTOR });
  transitionInstanceLifecycle({ path: settingsPath, auditPath, agentId: 'claude-code-cli', targetState: 'enabled', ...ACTOR });
  transitionInstanceLifecycle({ path: settingsPath, auditPath, agentId: 'claude-code-cli', targetState: 'draining', ...ACTOR });
  let claimCalls = 0;
  const decision = evaluateClaimEligibility({ agentId: 'claude-code-cli', settingsPath, onEligible: () => { claimCalls += 1; } });
  assert.equal(decision.eligible, false);
  assert.equal(claimCalls, 0);
}));

test('evaluateClaimEligibility invokes onEligible once fully enabled', () => withTempPaths(({ settingsPath, auditPath }) => {
  createInstance({ path: settingsPath, auditPath, agentId: 'claude-code-cli', ...ACTOR });
  transitionInstanceLifecycle({ path: settingsPath, auditPath, agentId: 'claude-code-cli', targetState: 'enabled', ...ACTOR });
  let claimCalls = 0;
  const decision = evaluateClaimEligibility({ agentId: 'claude-code-cli', settingsPath, onEligible: () => { claimCalls += 1; } });
  assert.equal(decision.eligible, true);
  assert.equal(claimCalls, 1);
}));
