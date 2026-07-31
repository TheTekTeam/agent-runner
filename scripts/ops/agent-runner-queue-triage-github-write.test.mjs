import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GhCliGitHubWriteClient,
  normalizeIssueMutation,
} from './agent-runner-queue-triage-github-write.mjs';

test('normalizes only atomic labels replacement and completed issue closure', () => {
  assert.deepEqual(
    normalizeIssueMutation('/repos/Owner/Repo/issues/17', { labels: ['status:ready', 'area:test'] }),
    { labels: ['area:test', 'status:ready'] },
  );
  assert.deepEqual(
    normalizeIssueMutation('/repos/Owner/Repo/issues/17', { state: 'closed', state_reason: 'completed' }),
    { state: 'closed', state_reason: 'completed' },
  );
});

test('rejects non-issue endpoints and payloads outside the allowlist', () => {
  assert.throws(
    () => normalizeIssueMutation('/repos/Owner/Repo/issues/17/comments', { labels: [] }),
    /endpoint is not allowlisted/,
  );
  assert.throws(
    () => normalizeIssueMutation('/repos/Owner/Repo/pulls/17', { labels: [] }),
    /endpoint is not allowlisted/,
  );
  assert.throws(
    () => normalizeIssueMutation('/repos/Owner/Repo/issues/17', { state: 'open' }),
    /outside the queue-triage allowlist/,
  );
  assert.throws(
    () => normalizeIssueMutation('/repos/Owner/Repo/issues/17', { labels: ['a', 'a'] }),
    /must not contain duplicates/,
  );
});

test('uses gh PATCH with stdin JSON and a bounded environment', () => {
  let invocation = null;
  const client = new GhCliGitHubWriteClient({
    env: { PATH: '/bin', GH_TOKEN: 'secret', UNRELATED_SECRET: 'drop-me' },
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: '{"state":"open"}', stderr: '' };
    },
  });
  const result = client.mutateIssue('/repos/Owner/Repo/issues/17', { labels: ['status:ready'] });
  assert.equal(result.state, 'open');
  assert.equal(invocation.command, 'gh');
  assert.deepEqual(invocation.args, [
    'api', '--method', 'PATCH', '/repos/Owner/Repo/issues/17', '--input', '-',
  ]);
  assert.equal(invocation.options.input, '{"labels":["status:ready"]}');
  assert.equal(invocation.options.env.GH_TOKEN, 'secret');
  assert.equal(invocation.options.env.UNRELATED_SECRET, undefined);
});

test('maps provider failures without returning provider output', () => {
  const client = new GhCliGitHubWriteClient({
    spawn: () => ({ status: 1, stdout: '', stderr: 'secondary rate limit' }),
  });
  assert.throws(
    () => client.mutateIssue('/repos/Owner/Repo/issues/17', { labels: [] }),
    (error) => error.code === 'provider-rate-limited' && !error.message.includes('secondary'),
  );
});
