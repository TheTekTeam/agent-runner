import assert from 'node:assert/strict';
import test from 'node:test';

import { computeInstanceQuota } from './agent-runner-control-readiness.mjs';

const buildDashboard = () => ({
  quota: {
    blockedCount: 1,
    latestSessionUsagePercent: 25,
    latestWeeklyUsagePercent: 10,
  },
});

test('computeInstanceQuota projects unknown when the machine settings document is missing', () => {
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/x.sqlite',
    buildDashboard,
    getSettings: () => ({ fileFound: false, parseError: null, entry: null }),
  });

  assert.deepEqual(quota, {
    costClass: 'unknown',
    paid: false,
    paidFallback: 'unknown',
    quota: {
      blockedCount: 1,
      latestSessionUsagePercent: 25,
      latestWeeklyUsagePercent: 10,
    },
  });
});

test('computeInstanceQuota projects unknown for malformed settings without leaking parse detail', () => {
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/x.sqlite',
    buildDashboard,
    getSettings: () => ({ fileFound: true, parseError: 'agent-settings-malformed-json:secret-detail', entry: null }),
  });

  assert.equal(quota.costClass, 'unknown');
  assert.equal(quota.paid, false);
  assert.equal(quota.paidFallback, 'unknown');
  assert.ok(!JSON.stringify(quota).includes('secret-detail'));
});

test('computeInstanceQuota projects unknown for settings read failure without leaking the read error', () => {
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/x.sqlite',
    buildDashboard,
    getSettings: () => ({ fileFound: true, parseError: 'EACCES:/private/path', entry: null }),
  });

  assert.equal(quota.costClass, 'unknown');
  assert.equal(quota.paidFallback, 'unknown');
  assert.ok(!JSON.stringify(quota).includes('EACCES'));
  assert.ok(!JSON.stringify(quota).includes('/private/path'));
});

test('computeInstanceQuota keeps a valid parsed document with no Claude entry on the known included-use default', () => {
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/x.sqlite',
    buildDashboard,
    getSettings: () => ({ fileFound: true, parseError: null, entry: null }),
  });

  assert.equal(quota.costClass, 'included-subscription');
  assert.equal(quota.paid, false);
  assert.equal(quota.paidFallback, 'disabled');
});

test('computeInstanceQuota treats a missing settings result as unknown rather than guessing included use', () => {
  const quota = computeInstanceQuota({
    agentId: 'claude-code-cli',
    dbPath: '/tmp/x.sqlite',
    buildDashboard,
    getSettings: () => null,
  });

  assert.equal(quota.costClass, 'unknown');
  assert.equal(quota.paid, false);
  assert.equal(quota.paidFallback, 'unknown');
});
