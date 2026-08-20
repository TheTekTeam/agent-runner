import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReadOnlyControlSummary,
  computeInstanceLoad,
  computeInstanceQuota,
  computeInstanceReadiness,
  probeCommandOnPath,
} from './agent-runner-control-readiness.mjs';

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

test('buildReadOnlyControlSummary uses the private snapshot reader and bounded dashboard derivations', () => {
  let calledWith = null;
  const summary = buildReadOnlyControlSummary('/tmp/runner.sqlite', {
    historyLimit: 3,
    snapshotReader: (dbPath, options) => {
      calledWith = { dbPath, options };
      return {
        ok: true,
        latest: {
          claims: [{ id: 1, created_at: '2026-08-20T00:00:00.000Z', repo: 'TheTekTeam/modelspend', issue_number: 174, action: 'claimed', status_label: 'status:in-progress', selection_mode: 'issue-run' }],
          runResults: [],
          selections: [],
          queueEvents: [],
          quota: [{ id: 1, created_at: '2026-08-20T00:00:00.000Z', blocked: 0, session_usage_percent: 25, weekly_usage_percent: 10 }],
        },
      };
    },
  });
  assert.deepEqual(calledWith, { dbPath: '/tmp/runner.sqlite', options: { historyLimit: 3, includeLatest: true } });
  assert.equal(summary.activity.status, 'active-or-unresolved');
  assert.deepEqual(summary.quota, { blockedCount: 0, latestSessionUsagePercent: 25, latestWeeklyUsagePercent: 10 });
});

test('buildReadOnlyControlSummary fails closed without inventing quota when the snapshot is unavailable', () => {
  const summary = buildReadOnlyControlSummary('/tmp/missing.sqlite', {
    snapshotReader: () => ({ ok: false, latest: null }),
  });
  assert.equal(summary.activity.status, 'empty');
  assert.equal(summary.quota, null);
});

test('computeInstanceLoad reports a static, honest capacity of 1 and no active load for a non-claude adapter', () => {
  const load = computeInstanceLoad({ agentId: 'ollama-agent' });
  assert.deepEqual(load, { capacity: 1, active: 0, note: 'load-tracking-not-available-for-this-adapter' });
});

test('computeInstanceLoad for claude-code-cli reads the existing bounded read-only summary, never mutates it', () => {
  let calledWith = null;
  const buildDashboard = (dbPath, options) => {
    calledWith = { dbPath, options };
    return { activity: { status: 'active-or-unresolved' } };
  };
  const load = computeInstanceLoad({ agentId: 'claude-code-cli', dbPath: '/tmp/does-not-matter.sqlite', buildDashboard });
  assert.deepEqual(load, { capacity: 1, active: 1, note: null });
  assert.equal(calledWith.dbPath, '/tmp/does-not-matter.sqlite');
  assert.deepEqual(calledWith.options, { historyLimit: 5 });
});

test('computeInstanceLoad reports idle when no active claim is evidenced', () => {
  const load = computeInstanceLoad({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/does-not-matter.sqlite',
    buildDashboard: () => ({ activity: { status: 'idle' } }),
  });
  assert.equal(load.active, 0);
});

// -- computeInstanceQuota (issue #47 required view; #184 quota-only policy) --

test('computeInstanceQuota reports a static, honest zero-spend cost class for the local Ollama adapter, no dashboard read', () => {
  let called = false;
  const quota = computeInstanceQuota({ agentId: 'ollama-agent', buildDashboard: () => { called = true; return {}; } });
  assert.deepEqual(quota, { costClass: 'free-local-zero-spend', paid: false, quota: null });
  assert.equal(called, false);
});

test('computeInstanceQuota reports not-yet-qualified for a foundation-only, non-local adapter, no dashboard read', () => {
  let called = false;
  const quota = computeInstanceQuota({ agentId: 'codex-cli', buildDashboard: () => { called = true; return {}; } });
  assert.deepEqual(quota, { costClass: 'not-yet-qualified', paid: false, quota: null });
  assert.equal(called, false);
});

test('computeInstanceQuota reports not-yet-qualified for the foundation-only grok-cli adapter, no dashboard read', () => {
  let called = false;
  const quota = computeInstanceQuota({ agentId: 'grok-cli', buildDashboard: () => { called = true; return {}; } });
  assert.deepEqual(quota, { costClass: 'not-yet-qualified', paid: false, quota: null });
  assert.equal(called, false);
});

test('computeInstanceReadiness never probes the foundation-only grok-cli adapter, since it stays implemented:false', () => {
  let probed = false;
  const readiness = computeInstanceReadiness({ adapter: { implemented: false, command: null }, accessFn: () => { probed = true; } });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, 'adapter-not-implemented');
  assert.equal(probed, false);
});

test('computeInstanceQuota for claude-code-cli reuses only the bounded read-only quota summary and reports included-subscription', () => {
  let calledWith = null;
  const buildDashboard = (dbPath, options) => {
    calledWith = { dbPath, options };
    return { quota: { blockedCount: 2, latestSessionUsagePercent: 41.5, latestWeeklyUsagePercent: 12.25 } };
  };
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/does-not-matter.sqlite',
    buildDashboard,
  });
  assert.deepEqual(quota, {
    costClass: 'included-subscription',
    paid: false,
    quota: { blockedCount: 2, latestSessionUsagePercent: 41.5, latestWeeklyUsagePercent: 12.25 },
  });
  assert.equal(calledWith.dbPath, '/tmp/does-not-matter.sqlite');
  assert.deepEqual(calledWith.options, { historyLimit: 1 });
});

test('computeInstanceQuota for claude-code-cli degrades to a null quota block when the summary has no quota yet', () => {
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/does-not-matter.sqlite',
    buildDashboard: () => ({}),
  });
  assert.deepEqual(quota, { costClass: 'included-subscription', paid: false, quota: null });
});

test('computeInstanceQuota never returns raw prompt/provider data or account-credit state', () => {
  const buildDashboard = () => ({
    quota: {
      blockedCount: 1,
      latestSessionUsagePercent: 5,
      latestWeeklyUsagePercent: 5,
      rawProviderResponse: 'must-not-leak',
      prompt: 'must-not-leak',
      creditBalance: 123,
      flexibleCreditsAvailable: true,
      autoTopUp: true,
    },
  });
  const quota = computeInstanceQuota({ agentId: 'claude-code-cli', dbPath: '/tmp/x.sqlite', buildDashboard });
  assert.deepEqual(Object.keys(quota.quota).sort(), ['blockedCount', 'latestSessionUsagePercent', 'latestWeeklyUsagePercent']);
  assert.ok(!JSON.stringify(quota).includes('must-not-leak'));
  assert.ok(!JSON.stringify(quota).includes('creditBalance'));
  assert.ok(!JSON.stringify(quota).includes('flexibleCreditsAvailable'));
  assert.ok(!JSON.stringify(quota).includes('autoTopUp'));
});

test('computeInstanceQuota has no agent-settings or billing-policy dependency', () => {
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/x.sqlite',
    buildDashboard: () => ({ quota: { latestSessionUsagePercent: 25, latestWeeklyUsagePercent: 10 } }),
  });
  assert.equal(quota.costClass, 'included-subscription');
  assert.equal(quota.paid, false);
  assert.equal('paidFallback' in quota, false);
});
