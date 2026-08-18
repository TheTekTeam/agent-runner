import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeManagerProfileShadow,
  computeManagerProfileShadowForProject,
  MANAGER_PROFILE_SHADOW_SCHEMA_VERSION,
} from './agent-runner-manager-profile-shadow.mjs';
import { loadManagerProfileRegistry } from './agent-runner-manager-profile-registry.mjs';
import { MANAGER_PROFILE_SCHEMA_VERSION, validateManagerProfile } from './agent-runner-manager-profile-schema.mjs';

function agentRunnerConfig(overrides = {}) {
  return { projectId: 'agent-runner', githubRepo: 'TheTekTeam/agent-runner', ...overrides };
}

function customProfile(overrides = {}) {
  return validateManagerProfile({
    schemaVersion: MANAGER_PROFILE_SCHEMA_VERSION,
    projectId: 'agent-runner',
    enabled: true,
    repository: { owner: 'TheTekTeam', name: 'agent-runner' },
    branches: { allowed: ['main'], default: 'main' },
    objective: 'Sample objective.',
    nonGoals: ['No autonomous merge'],
    instructionPaths: ['CLAUDE.md'],
    controlIssue: { mode: 'fixedIssue', issueNumber: 258 },
    labels: { ready: 'status:ready', done: 'status:done' },
    capabilities: { allowlist: ['claude-code-cli'] },
    validation: { profile: 'complex', requiredChecks: ['npm test'] },
    quotaPolicyRef: 'scripts/ops/agent-runner-routing.mjs#quota-only-admission',
    mutationBounds: { maxIssueMutationsPerRecurrence: 1, maxCommentsPerRecurrence: 1 },
    escalation: { rules: ['Stop on ambiguous evidence'] },
    mutationAuthority: {
      issueMutation: true, authorityIssuance: true, merge: false, close: false, deploy: false, sourceActivation: false,
    },
    ...overrides,
  });
}

function registryOf(projectId, profile) {
  return { projectsById: { [projectId]: profile } };
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
  const ok = computeManagerProfileShadow([
    { config: agentRunnerConfig() },
    { config: { projectId: 'modelspend', githubRepo: 'TheTekTeam/modelspend' } },
  ]);
  assert.ok(Object.isFrozen(ok));
  assert.ok(Object.isFrozen(ok.projects));
  assert.ok(Object.isFrozen(ok.projects[0]));
  assert.ok(Object.isFrozen(ok.projects[0].mismatches));
  assert.ok(Object.isFrozen(ok.projects[0].nonComparable));
});

test('branches and instructionPaths are recorded as non-comparable evidence when the canonical config does not carry them', () => {
  const profileRegistry = loadManagerProfileRegistry();
  const result = computeManagerProfileShadowForProject({ config: agentRunnerConfig(), profileRegistry });
  assert.deepEqual(result.nonComparable, ['branches', 'instructionPaths']);
  assert.equal(result.matches, true);
});

test('an injected projectId mismatch between a profile and the canonical config it is bound under is recorded, not thrown', () => {
  const profileRegistry = registryOf('agent-runner', customProfile({ projectId: 'a-different-project' }));
  const result = computeManagerProfileShadowForProject({ config: agentRunnerConfig(), profileRegistry });
  assert.equal(result.available, true);
  assert.equal(result.matches, false);
  assert.ok(result.mismatches.includes('projectId'));
});

test('an injected enabled mismatch (disabled profile bound to an admitted canonical project) is recorded, not thrown', () => {
  const profileRegistry = registryOf('agent-runner', customProfile({ enabled: false }));
  const result = computeManagerProfileShadowForProject({ config: agentRunnerConfig(), profileRegistry });
  assert.equal(result.available, true);
  assert.equal(result.matches, false);
  assert.ok(result.mismatches.includes('enabled'));
});

test('an injected branches mismatch is recorded once the canonical config actually carries branch data', () => {
  const profileRegistry = registryOf('agent-runner', customProfile());
  const config = agentRunnerConfig({ branches: { allowed: ['develop'], default: 'develop' } });
  const result = computeManagerProfileShadowForProject({ config, profileRegistry });
  assert.equal(result.matches, false);
  assert.ok(result.mismatches.includes('branches'));
  assert.ok(!result.nonComparable.includes('branches'));
});

test('a matching branches field is recorded as a match once the canonical config carries branch data', () => {
  const profileRegistry = registryOf('agent-runner', customProfile());
  const config = agentRunnerConfig({ branches: { allowed: ['main'], default: 'main' } });
  const result = computeManagerProfileShadowForProject({ config, profileRegistry });
  assert.ok(!result.mismatches.includes('branches'));
  assert.ok(!result.nonComparable.includes('branches'));
});

test('an injected instructionPaths mismatch is recorded once the canonical config actually carries instruction paths', () => {
  const profileRegistry = registryOf('agent-runner', customProfile());
  const config = agentRunnerConfig({ instructionPaths: ['OTHER.md'] });
  const result = computeManagerProfileShadowForProject({ config, profileRegistry });
  assert.equal(result.matches, false);
  assert.ok(result.mismatches.includes('instructionPaths'));
  assert.ok(!result.nonComparable.includes('instructionPaths'));
});

test('a matching instructionPaths field is recorded as a match once the canonical config carries instruction paths', () => {
  const profileRegistry = registryOf('agent-runner', customProfile());
  const config = agentRunnerConfig({ instructionPaths: ['CLAUDE.md'] });
  const result = computeManagerProfileShadowForProject({ config, profileRegistry });
  assert.ok(!result.mismatches.includes('instructionPaths'));
  assert.ok(!result.nonComparable.includes('instructionPaths'));
});

test('computeManagerProfileShadow binds the manager-profile registry against the whole set of canonical projects passed to it', () => {
  const result = computeManagerProfileShadow([
    { config: agentRunnerConfig() },
    { config: { projectId: 'modelspend', githubRepo: 'TheTekTeam/modelspend' } },
  ]);
  assert.equal(result.available, true);
  assert.deepEqual(result.projects.map((entry) => entry.projectId).sort(), ['agent-runner', 'modelspend']);
});

test('computeManagerProfileShadow fails closed (as an unavailable top-level result) when an enabled profile is unregistered against the bound canonical set', () => {
  // agent-runner is enabled in MANAGER_PROFILE_REGISTRY but omitted here, so
  // the whole-registry bind cannot find it against the canonical set passed in.
  const result = computeManagerProfileShadow([
    { config: { projectId: 'modelspend', githubRepo: 'TheTekTeam/modelspend' } },
  ]);
  assert.equal(result.available, false);
  assert.match(result.reason, /manager-profile-registry-error:.*Unregistered agent runner manager project: 'agent-runner'/);
});
