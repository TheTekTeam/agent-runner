import assert from 'node:assert/strict';
import test from 'node:test';

import { computeInstanceLoad, computeInstanceQuota, computeInstanceReadiness, probeCommandOnPath } from './agent-runner-control-readiness.mjs';

test('probeCommandOnPath never spawns a process — pure accessSync walk of PATH', () => {
  const calls = [];
  const accessFn = (candidate) => {
    calls.push(candidate);
    if (!candidate.endsWith('/usr/bin/claude') && candidate !== '/usr/bin/claude') throw new Error('ENOENT');
  };
  const probe = probeCommandOnPath({ command: 'claude', pathEnv: '/usr/local/bin:/usr/bin', accessFn });
  assert.equal(probe.ok, true);
  assert.deepEqual(calls, ['/usr/local/bin/claude', '/usr/bin/claude']);
});

test('probeCommandOnPath fails closed with a reason when the command is nowhere on PATH', () => {
  const probe = probeCommandOnPath({ command: 'claude', pathEnv: '/usr/local/bin', accessFn: () => { throw new Error('ENOENT'); } });
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, 'command-not-on-path');
});

test('probeCommandOnPath fails closed when no command is configured', () => {
  const probe = probeCommandOnPath({ command: null });
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, 'command-not-configured');
});

test('computeInstanceReadiness never probes an unimplemented catalogue adapter', () => {
  let probed = false;
  const readiness = computeInstanceReadiness({ adapter: { implemented: false, command: 'ollama' }, accessFn: () => { probed = true; } });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, 'adapter-not-implemented');
  assert.equal(probed, false);
});

test('computeInstanceReadiness runs the PATH probe for an implemented adapter', () => {
  const readiness = computeInstanceReadiness({
    adapter: { implemented: true, command: 'claude' },
    accessFn: (candidate) => { if (!candidate.endsWith('/claude')) throw new Error('ENOENT'); },
    pathEnv: '/usr/bin',
  });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.probes.length, 1);
});

test('computeInstanceLoad reports a static, honest capacity of 1 and no active load for a non-claude adapter', () => {
  const load = computeInstanceLoad({ agentId: 'ollama-agent' });
  assert.deepEqual(load, { capacity: 1, active: 0, note: 'load-tracking-not-available-for-this-adapter' });
});

test('computeInstanceLoad for claude-code-cli reads the existing read-only dashboard summary, never mutates it', () => {
  let calledWith = null;
  const buildDashboard = (dbPath, options) => {
    calledWith = { dbPath, options };
    return { activity: { status: 'active-or-unresolved' } };
  };
  const load = computeInstanceLoad({ agentId: 'claude-code-cli', dbPath: '/tmp/does-not-matter.sqlite', buildDashboard });
  assert.deepEqual(load, { capacity: 1, active: 1, note: null });
  assert.equal(calledWith.dbPath, '/tmp/does-not-matter.sqlite');
  assert.equal(calledWith.options.strict, false);
});

test('computeInstanceLoad reports idle when no active claim is evidenced', () => {
  const load = computeInstanceLoad({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/does-not-matter.sqlite',
    buildDashboard: () => ({ activity: { status: 'idle' } }),
  });
  assert.equal(load.active, 0);
});

// -- computeInstanceQuota (issue #47 required view: cost class / budget-cap / quota-resource state) --

test('computeInstanceQuota reports a static, honest zero-spend cost class for the local Ollama adapter, no dashboard read', () => {
  let called = false;
  const quota = computeInstanceQuota({ agentId: 'ollama-agent', buildDashboard: () => { called = true; return {}; } });
  assert.deepEqual(quota, { costClass: 'free-local-zero-spend', paid: false, paidFallback: 'disabled', quota: null });
  assert.equal(called, false);
});

test('computeInstanceQuota reports not-yet-qualified for a foundation-only, non-local adapter, no dashboard read', () => {
  let called = false;
  const quota = computeInstanceQuota({ agentId: 'codex-cli', buildDashboard: () => { called = true; return {}; } });
  assert.deepEqual(quota, { costClass: 'not-yet-qualified', paid: false, paidFallback: 'disabled', quota: null });
  assert.equal(called, false);
});

test('computeInstanceQuota reports not-yet-qualified for the foundation-only grok-cli adapter, no dashboard read', () => {
  let called = false;
  const quota = computeInstanceQuota({ agentId: 'grok-cli', buildDashboard: () => { called = true; return {}; } });
  assert.deepEqual(quota, { costClass: 'not-yet-qualified', paid: false, paidFallback: 'disabled', quota: null });
  assert.equal(called, false);
});

test('computeInstanceReadiness never probes the foundation-only grok-cli adapter, since it stays implemented:false', () => {
  let probed = false;
  const readiness = computeInstanceReadiness({ adapter: { implemented: false, command: null }, accessFn: () => { probed = true; } });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, 'adapter-not-implemented');
  assert.equal(probed, false);
});

// -- issue #184: claude-code-cli included-use-only posture by default, no settings entry --

test('computeInstanceQuota for claude-code-cli reuses the existing read-only dashboard quota summary, never mutates it, and reports included-subscription with no settings entry', () => {
  let calledWith = null;
  const buildDashboard = (dbPath, options) => {
    calledWith = { dbPath, options };
    return { quota: { blockedCount: 2, latestSessionUsagePercent: 41.5, latestWeeklyUsagePercent: 12.25 } };
  };
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/does-not-matter.sqlite',
    buildDashboard,
    getSettings: () => ({ entry: null }),
  });
  assert.deepEqual(quota, {
    costClass: 'included-subscription',
    paid: false,
    paidFallback: 'disabled',
    quota: { blockedCount: 2, latestSessionUsagePercent: 41.5, latestWeeklyUsagePercent: 12.25 },
  });
  assert.equal(calledWith.dbPath, '/tmp/does-not-matter.sqlite');
  assert.equal(calledWith.options.strict, false);
});

test('computeInstanceQuota for claude-code-cli degrades to a null quota block when the dashboard has no quota summary yet', () => {
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/does-not-matter.sqlite',
    buildDashboard: () => ({}),
    getSettings: () => ({ entry: null }),
  });
  assert.deepEqual(quota, { costClass: 'included-subscription', paid: false, paidFallback: 'disabled', quota: null });
});

test('computeInstanceQuota never returns a raw prompt, token count, or provider payload — only the three bounded numeric fields', () => {
  const buildDashboard = () => ({
    quota: { blockedCount: 1, latestSessionUsagePercent: 5, latestWeeklyUsagePercent: 5, rawProviderResponse: 'must-not-leak', prompt: 'must-not-leak' },
  });
  const quota = computeInstanceQuota({ agentId: 'claude-code-cli', dbPath: '/tmp/x.sqlite', buildDashboard, getSettings: () => ({ entry: null }) });
  assert.deepEqual(Object.keys(quota.quota).sort(), ['blockedCount', 'latestSessionUsagePercent', 'latestWeeklyUsagePercent']);
  assert.ok(!JSON.stringify(quota).includes('must-not-leak'));
});

// -- issue #184: claude-code-cli paid/credit fallback posture is read from the same machine-local paid-use policy seam as codex-cli/grok-cli --

test('computeInstanceQuota for claude-code-cli stays included-subscription when the paid-use policy is only partially set', () => {
  const buildDashboard = () => ({ quota: {} });
  const partiallyApproved = { entry: { paidUseApproved: true, automaticRoutingApproved: false, maxCostUsdPerRun: 5 } };
  const quota = computeInstanceQuota({ agentId: 'claude-code-cli', dbPath: '/tmp/x.sqlite', buildDashboard, getSettings: () => partiallyApproved });
  assert.equal(quota.costClass, 'included-subscription');
  assert.equal(quota.paid, false);
  assert.equal(quota.paidFallback, 'disabled');
});

test('computeInstanceQuota for claude-code-cli reports paid-metered only once paid use, automatic routing, and a positive cap are all explicitly authorised', () => {
  const buildDashboard = () => ({ quota: {} });
  const fullyApproved = { entry: { paidUseApproved: true, automaticRoutingApproved: true, maxCostUsdPerRun: 5, maxTokensPerRun: 0 } };
  const quota = computeInstanceQuota({ agentId: 'claude-code-cli', dbPath: '/tmp/x.sqlite', buildDashboard, getSettings: () => fullyApproved });
  assert.equal(quota.costClass, 'paid-metered');
  assert.equal(quota.paid, true);
  assert.equal(quota.paidFallback, 'explicitly-authorised');
});

test('computeInstanceQuota passes settingsPath and agentId through to getSettings unchanged', () => {
  let calledWith = null;
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/x.sqlite',
    buildDashboard: () => ({ quota: {} }),
    settingsPath: '/tmp/agent-settings.json',
    getSettings: (args) => { calledWith = args; return { entry: null }; },
  });
  assert.equal(calledWith.agentId, 'claude-code-cli');
  assert.equal(calledWith.settingsPath, '/tmp/agent-settings.json');
  assert.equal(quota.costClass, 'included-subscription');
});
