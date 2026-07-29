import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  collectGitHubCheckSnapshot,
  GhCliGitHubReadClient,
} from './agent-runner-github-checks-provider.mjs';

const SHA = 'a'.repeat(40);

function responseFor(endpoint, query, pages = {}) {
  const key = `${endpoint}?page=${query.page}`;
  if (!(key in pages)) return [];
  const value = pages[key];
  if (value instanceof Error) throw value;
  return value;
}

test('collects and normalizes all GitHub CI surfaces', async () => {
  const pages = {
    [`/repos/Owner/Alpha/commits/${SHA}/check-runs?page=1`]: {
      check_runs: [{ id: 1, name: 'lint', status: 'completed', conclusion: 'success' }],
    },
    [`/repos/Owner/Alpha/commits/${SHA}/check-suites?page=1`]: {
      check_suites: [{ id: 2, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }],
    },
    ['/repos/Owner/Alpha/actions/runs?page=1']: {
      workflow_runs: [{ id: 3, name: 'Validate', status: 'in_progress', conclusion: null }],
    },
    [`/repos/Owner/Alpha/commits/${SHA}/statuses?page=1`]: [
      { id: 4, context: 'external/security', state: 'failure' },
    ],
  };
  const result = await collectGitHubCheckSnapshot({
    repository: 'Owner/Alpha',
    sha: SHA,
    perPage: 100,
    requestJson: async (endpoint, query) => responseFor(endpoint, query, pages),
    observedAt: '2026-07-29T01:00:00.000Z',
  });
  assert.equal(result.snapshot.queryComplete, true);
  assert.equal(result.snapshot.checks.length, 4);
  assert.equal(result.snapshot.checks.find((item) => item.provider === 'workflow_run').terminal, false);
  assert.equal(result.snapshot.checks.find((item) => item.provider === 'commit_status').conclusion, 'failure');
  assert.deepEqual(result.diagnostics, []);
});

test('paginates each surface and marks the snapshot incomplete at a bounded page limit', async () => {
  let calls = 0;
  const result = await collectGitHubCheckSnapshot({
    repository: 'Owner/Alpha',
    sha: SHA,
    perPage: 2,
    maxPages: 2,
    requestJson: async (endpoint, query) => {
      calls += 1;
      if (endpoint.includes('check-runs')) {
        return { check_runs: [
          { id: `${query.page}-1`, name: 'one', status: 'completed', conclusion: 'success' },
          { id: `${query.page}-2`, name: 'two', status: 'completed', conclusion: 'success' },
        ] };
      }
      if (endpoint.includes('check-suites')) return { check_suites: [] };
      if (endpoint.includes('actions/runs')) return { workflow_runs: [] };
      return [];
    },
  });
  assert.equal(calls, 5);
  assert.equal(result.snapshot.queryComplete, false);
  assert.equal(result.snapshot.checks.length, 4);
  assert.deepEqual(result.diagnostics, [{ surface: 'check-runs', reasonCode: 'pagination-limit-reached' }]);
});

test('a provider failure produces an incomplete snapshot rather than an empty success', async () => {
  const error = new Error('rate limit');
  error.code = 'provider-rate-limited';
  const result = await collectGitHubCheckSnapshot({
    repository: 'Owner/Alpha',
    sha: SHA,
    requestJson: async (endpoint) => {
      if (endpoint.includes('check-suites')) throw error;
      if (endpoint.includes('check-runs')) return { check_runs: [] };
      if (endpoint.includes('actions/runs')) return { workflow_runs: [] };
      return [];
    },
  });
  assert.equal(result.snapshot.queryComplete, false);
  assert.deepEqual(result.diagnostics, [{ surface: 'check-suites', reasonCode: 'provider-rate-limited' }]);
});

test('an empty complete response is represented as a settled no-check snapshot', async () => {
  const result = await collectGitHubCheckSnapshot({
    repository: 'Owner/Alpha',
    sha: SHA,
    requestJson: async (endpoint) => {
      if (endpoint.includes('check-runs')) return { check_runs: [] };
      if (endpoint.includes('check-suites')) return { check_suites: [] };
      if (endpoint.includes('actions/runs')) return { workflow_runs: [] };
      return [];
    },
  });
  assert.equal(result.snapshot.queryComplete, true);
  assert.deepEqual(result.snapshot.checks, []);
});

test('a later provider refresh can reveal a newly started workflow', async () => {
  let refresh = 0;
  const requestJson = async (endpoint) => {
    if (endpoint.includes('check-runs')) return { check_runs: [] };
    if (endpoint.includes('check-suites')) return { check_suites: [] };
    if (endpoint.includes('actions/runs')) {
      return { workflow_runs: refresh === 0 ? [] : [
        { id: 55, name: 'Post merge', status: 'queued', conclusion: null },
      ] };
    }
    return [];
  };
  const first = await collectGitHubCheckSnapshot({ repository: 'Owner/Alpha', sha: SHA, requestJson });
  refresh = 1;
  const second = await collectGitHubCheckSnapshot({ repository: 'Owner/Alpha', sha: SHA, requestJson });
  assert.equal(first.snapshot.checks.length, 0);
  assert.equal(second.snapshot.checks.length, 1);
  assert.equal(second.snapshot.checks[0].terminal, false);
  assert.notEqual(first.snapshot.fingerprint, second.snapshot.fingerprint);
});

test('the same provider implementation accepts another registered repository name', async () => {
  const endpoints = [];
  await collectGitHubCheckSnapshot({
    repository: 'Other/Project',
    sha: SHA,
    requestJson: async (endpoint) => {
      endpoints.push(endpoint);
      if (endpoint.includes('check-runs')) return { check_runs: [] };
      if (endpoint.includes('check-suites')) return { check_suites: [] };
      if (endpoint.includes('actions/runs')) return { workflow_runs: [] };
      return [];
    },
  });
  assert.ok(endpoints.every((endpoint) => endpoint.includes('/repos/Other/Project/')));
});

test('Gh CLI client uses a read-only bounded command and restricted environment', () => {
  const calls = [];
  const client = new GhCliGitHubReadClient({
    env: {
      PATH: '/usr/bin',
      HOME: '/home/test',
      GH_TOKEN: 'test-token',
      UNRELATED_SECRET: 'must-not-pass',
    },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: '{"check_runs":[]}', stderr: '' };
    },
  });
  const value = client.requestJson(`/repos/Owner/Alpha/commits/${SHA}/check-runs`, { per_page: 100, page: 1 });
  assert.deepEqual(value, { check_runs: [] });
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args.slice(0, 4), ['api', '--method', 'GET', `/repos/Owner/Alpha/commits/${SHA}/check-runs`]);
  assert.equal(calls[0].options.env.UNRELATED_SECRET, undefined);
  assert.equal(calls[0].options.env.GH_TOKEN, 'test-token');
});

test('Gh CLI client fails closed without returning raw stderr', () => {
  const client = new GhCliGitHubReadClient({
    spawn() {
      return { status: 1, stdout: '', stderr: 'sensitive transport detail' };
    },
  });
  assert.throws(
    () => client.requestJson(`/repos/Owner/Alpha/commits/${SHA}/statuses`, {}),
    (error) => error.code === 'provider-read-failed' && !error.message.includes('sensitive'),
  );
});

test('rejects invalid repository, SHA and non-allowlisted API paths', async () => {
  await assert.rejects(
    collectGitHubCheckSnapshot({ repository: 'invalid', sha: SHA, requestJson: async () => [] }),
    /owner\/name/,
  );
  await assert.rejects(
    collectGitHubCheckSnapshot({ repository: 'Owner/Alpha', sha: 'not-sha', requestJson: async () => [] }),
    /SHA is invalid/,
  );
  const client = new GhCliGitHubReadClient({ spawn: spawnSync });
  assert.throws(() => client.requestJson('/user', {}), /not allowlisted/);
});
