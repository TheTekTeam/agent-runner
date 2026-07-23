import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSecret, markSecretRotationRequired } from './agent-runner-secret-store.mjs';
import { buildSecretReference } from './agent-runner-secret-reference.mjs';
import { materializeSecretEnvironment } from './agent-runner-secret-environment.mjs';

const SYNTHETIC_VALUE = 'synthetic-test-value-gamma-222';

function withTempStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-secret-env-'));
  try {
    return fn(join(dir, 'secrets'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('materializeSecretEnvironment requires an explicit baseEnv and never defaults to process.env', () => withTempStore((dir) => {
  assert.throws(
    () => materializeSecretEnvironment({ dir, entries: [] }),
    (error) => error.code === 'AGENT_RUNNER_SECRET_ENV_BASE_REQUIRED',
  );
}));

test('an ambient process.env value never leaks in unless explicitly included in baseEnv', () => withTempStore((dir) => {
  process.env.AGENT_RUNNER_TEST_LEAK_PROBE = 'should-never-appear';
  try {
    const result = materializeSecretEnvironment({ dir, entries: [], baseEnv: {} });
    assert.equal(result.ok, true);
    assert.equal('AGENT_RUNNER_TEST_LEAK_PROBE' in result.env, false);
  } finally {
    delete process.env.AGENT_RUNNER_TEST_LEAK_PROBE;
  }
}));

test('an empty allowlist passes baseEnv through unchanged — Codex-style existing-session compatibility', () => withTempStore((dir) => {
  const baseEnv = { PATH: '/usr/bin', HOME: '/home/example' };
  const result = materializeSecretEnvironment({ dir, entries: [], baseEnv });
  assert.equal(result.ok, true);
  assert.deepEqual(result.env, baseEnv);
  assert.notEqual(result.env, baseEnv);
}));

test('a configured secret is materialized only into its allowlisted env var', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE);
  const result = materializeSecretEnvironment({
    dir,
    entries: [{ envVar: 'AGENT_API_TOKEN', reference: buildSecretReference('agent-token') }],
    baseEnv: { PATH: '/usr/bin' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.env.AGENT_API_TOKEN, SYNTHETIC_VALUE);
  assert.equal(result.env.PATH, '/usr/bin');
  assert.equal(Object.keys(result.env).length, 2);
}));

test('a missing required secret fails the whole materialization closed, exposing no partial env', () => withTempStore((dir) => {
  const result = materializeSecretEnvironment({
    dir,
    entries: [{ envVar: 'AGENT_API_TOKEN', reference: buildSecretReference('never-created') }],
    baseEnv: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.env, null);
  assert.deepEqual(result.missing, [{ envVar: 'AGENT_API_TOKEN', reason: 'secret-missing' }]);
}));

test('an optional missing secret is omitted but does not block the rest of the environment', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE);
  const result = materializeSecretEnvironment({
    dir,
    entries: [
      { envVar: 'AGENT_API_TOKEN', reference: buildSecretReference('agent-token') },
      { envVar: 'OPTIONAL_TOKEN', reference: buildSecretReference('never-created') },
    ],
    optionalEnvVars: ['OPTIONAL_TOKEN'],
    baseEnv: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.env.AGENT_API_TOKEN, SYNTHETIC_VALUE);
  assert.equal('OPTIONAL_TOKEN' in result.env, false);
}));

test('a malformed or path-traversal reference in the allowlist fails closed', () => withTempStore((dir) => {
  const result = materializeSecretEnvironment({
    dir,
    entries: [{ envVar: 'AGENT_API_TOKEN', reference: 'secretref:../../etc/passwd' }],
    baseEnv: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.missing[0].reason.startsWith('invalid-reference:'), true);
}));

test('a rotation-required secret is refused, not silently handed out', () => withTempStore((dir) => {
  createSecret(dir, 'agent-token', SYNTHETIC_VALUE);
  markSecretRotationRequired(dir, 'agent-token');
  const result = materializeSecretEnvironment({
    dir,
    entries: [{ envVar: 'AGENT_API_TOKEN', reference: buildSecretReference('agent-token') }],
    baseEnv: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.missing[0].reason, 'secret-rotation-required');
}));

test('the missing-entries diagnostics never carry a secret value, even serialized', () => withTempStore((dir) => {
  const result = materializeSecretEnvironment({
    dir,
    entries: [{ envVar: 'AGENT_API_TOKEN', reference: buildSecretReference('never-created') }],
    baseEnv: {},
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SYNTHETIC_VALUE), false);
}));
