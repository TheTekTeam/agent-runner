import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGithubAuthEnv } from './claude-runner-cron.mjs';

test('resolveGithubAuthEnv preserves an explicit GH_TOKEN', () => {
  const env = { GH_TOKEN: 'already-set', PATH: '/usr/bin' };
  const resolved = resolveGithubAuthEnv(env, () => {
    throw new Error('should not call gh auth token');
  });

  assert.equal(resolved.GH_TOKEN, 'already-set');
  assert.equal(resolved.PATH, '/usr/bin');
});

test('resolveGithubAuthEnv preserves an explicit GITHUB_TOKEN', () => {
  const env = { GITHUB_TOKEN: 'github-token', PATH: '/usr/bin' };
  const resolved = resolveGithubAuthEnv(env, () => 'unused-gh-token');

  assert.equal(resolved.GITHUB_TOKEN, 'github-token');
  assert.equal(resolved.GH_TOKEN, undefined);
});

test('resolveGithubAuthEnv derives GH_TOKEN from gh auth token when env token is absent', () => {
  const resolved = resolveGithubAuthEnv({ PATH: '/usr/bin' }, () => '  derived-token\n');

  assert.equal(resolved.GH_TOKEN, 'derived-token');
  assert.equal(resolved.PATH, '/usr/bin');
});

test('resolveGithubAuthEnv returns null when no env token exists and gh auth token is unavailable', () => {
  const resolved = resolveGithubAuthEnv({ PATH: '/usr/bin' }, () => {
    throw new Error('not logged in');
  });

  assert.equal(resolved, null);
});


test('claude-runner-cron invokes main when executed directly', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/ops/claude-runner-cron.mjs', '--help'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Claude runner scheduled wrapper/);
});
