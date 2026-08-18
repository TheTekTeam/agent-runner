import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeManagerProfileShadow,
  computeManagerProfileShadowForProject,
  MANAGER_PROFILE_SHADOW_SCHEMA_VERSION,
} from './agent-runner-manager-profile-shadow.mjs';
import { loadManagerProfileRegistry } from './agent-runner-manager-profile-registry.mjs';

function agentRunnerConfig(overrides = {}) {
  return { projectId: 'agent-runner', githubRepo: 'TheTekTeam/agent-runner', ...overrides };
}

test('a project whose registered profile matches the canonical registry reports available and matching', () => {
  const profileRegistry = loadManagerProfileRegistry();
  const result = computeManagerProfileShadowForProject({ config: agentRunnerConfig(), profileRegistry });
  assert.equal(result.projectId, 'agent-runner');
  assert.equal(result.available, true);
  assert.equal(result.matches, true);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.profileEnabled, true);
});

test('a project with no registered manager profile is reported as unavailable, never thrown', () => {
  const profileRegistry = loadManagerProfileRegistry();
  const result = computeManagerProfileShadowForProject({
    config: { projectId: 'never-registered', githubRepo: 'TheTekTeam/never-registered' },
    profileRegistry,
  });
  assert.equal(result.available, false);
  assert.equal(result.matches, false);
  assert.equal(result.reason, 'manager-profile-unregistered');
});

test('a repository mismatch between the canonical registry and the manager profile is recorded, not thrown', () => {
  const profileRegistry = loadManagerProfileRegistry();
  const result = computeManagerProfileShadowForProject({
    config: agentRunnerConfig({ githubRepo: 'SomeoneElse/agent-runner' }),
    profileRegistry,
  });
  assert.equal(result.available, true);
  assert.equal(result.matches, false);
  assert.deepEqual(result.mismatches, ['repository']);
});

test('computeManagerProfileShadow evaluates every project and never blocks on a registry load failure', () => {
  const failing = computeManagerProfileShadow([{ config: agentRunnerConfig() }], {
    loadRegistry: () => { throw new Error('boom'); },
  });
  assert.equal(failing.available, false);
  assert.match(failing.reason, /manager-profile-registry-error:boom/);
  assert.deepEqual(failing.projects, []);

  const ok = computeManagerProfileShadow([{ config: agentRunnerConfig() }, { config: { projectId: 'modelspend', githubRepo: 'TheTekTeam/modelspend' } }]);
  assert.equal(ok.schemaVersion, MANAGER_PROFILE_SHADOW_SCHEMA_VERSION);
  assert.equal(ok.available, true);
  assert.equal(ok.projects.length, 2);
  assert.ok(ok.projects.every((entry) => entry.matches === true));
});

test('agent-runner and modelspend shadow results are behaviourally equivalent (same mutation authority, both matching)', () => {
  const profileRegistry = loadManagerProfileRegistry();
  const agentRunner = computeManagerProfileShadowForProject({ config: agentRunnerConfig(), profileRegistry });
  const modelspend = computeManagerProfileShadowForProject({
    config: { projectId: 'modelspend', githubRepo: 'TheTekTeam/modelspend' },
    profileRegistry,
  });
  assert.deepEqual(agentRunner.mutationAuthority, modelspend.mutationAuthority);
  assert.equal(agentRunner.matches, true);
  assert.equal(modelspend.matches, true);
});

test('shadow computation is deterministic and idempotent across repeated calls', () => {
  const profileRegistry = loadManagerProfileRegistry();
  const first = computeManagerProfileShadowForProject({ config: agentRunnerConfig(), profileRegistry });
  const second = computeManagerProfileShadowForProject({ config: agentRunnerConfig(), profileRegistry });
  assert.deepEqual(first, second);
});

test('the shadow result is frozen at every level relevant to mutation safety', () => {
  const ok = computeManagerProfileShadow([{ config: agentRunnerConfig() }]);
  assert.ok(Object.isFrozen(ok));
  assert.ok(Object.isFrozen(ok.projects));
  assert.ok(Object.isFrozen(ok.projects[0]));
  assert.ok(Object.isFrozen(ok.projects[0].mismatches));
});
