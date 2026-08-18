import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadManagerProfileRegistry,
  MANAGER_PROFILE_REGISTRY,
  resolveRegisteredManagerProfile,
} from './agent-runner-manager-profile-registry.mjs';
import { resolveManagerContext } from './agent-runner-manager-context.mjs';

test('the registry lists exactly the explicitly approved fixture projects', () => {
  assert.deepEqual(
    MANAGER_PROFILE_REGISTRY.map((entry) => entry.projectId).sort(),
    ['agent-runner', 'fixture-third-project', 'modelspend'],
  );
});

test('loads all registered profiles and validates them against the schema', () => {
  const registry = loadManagerProfileRegistry();
  assert.ok(registry.projectsById['agent-runner']);
  assert.ok(registry.projectsById.modelspend);
  assert.ok(registry.projectsById['fixture-third-project']);
  assert.equal(registry.projectsByRepository['thetekteam/agent-runner'].projectId, 'agent-runner');
});

test('resolves a registered project by id and matching repository', () => {
  const registry = loadManagerProfileRegistry();
  const profile = resolveRegisteredManagerProfile({ projectId: 'agent-runner', repository: 'TheTekTeam/agent-runner', registry });
  assert.equal(profile.projectId, 'agent-runner');
});

test('fails closed for an unregistered project', () => {
  const registry = loadManagerProfileRegistry();
  assert.throws(
    () => resolveRegisteredManagerProfile({ projectId: 'never-registered', registry }),
    /Unregistered agent runner manager project/,
  );
});

test('fails closed on a repository/profile mismatch before any mutation could occur', () => {
  const registry = loadManagerProfileRegistry();
  assert.throws(
    () => resolveRegisteredManagerProfile({ projectId: 'agent-runner', repository: 'SomeoneElse/agent-runner', registry }),
    /Repository mismatch/,
  );
});

test('agent-runner and modelspend resolve to behaviourally equivalent normalized contexts', () => {
  const registry = loadManagerProfileRegistry();
  const agentRunnerContext = resolveManagerContext(registry.projectsById['agent-runner']);
  const modelspendContext = resolveManagerContext(registry.projectsById.modelspend);

  assert.equal(agentRunnerContext.enabled, true);
  assert.equal(modelspendContext.enabled, true);
  assert.deepEqual(agentRunnerContext.mutationAuthority, modelspendContext.mutationAuthority);
  assert.deepEqual(agentRunnerContext.labels, modelspendContext.labels);
  assert.equal(agentRunnerContext.mutationAuthority.merge, false);
  assert.equal(agentRunnerContext.mutationAuthority.close, false);
  assert.equal(agentRunnerContext.mutationAuthority.deploy, false);
  assert.equal(agentRunnerContext.mutationAuthority.sourceActivation, false);
  assert.equal(agentRunnerContext.mutationAuthority.authorityIssuance, true);
  assert.equal(agentRunnerContext.mutationAuthority.issueMutation, true);

  for (const context of [agentRunnerContext, modelspendContext]) {
    for (const key of Object.keys(context)) {
      assert.notEqual(key.toLowerCase(), 'accountcredit');
      assert.notEqual(key.toLowerCase(), 'balance');
    }
  }
});

test('a disabled profile resolves to a context with zero mutation authority and zero mutation bounds', () => {
  const registry = loadManagerProfileRegistry();
  const context = resolveManagerContext(registry.projectsById['fixture-third-project']);
  assert.equal(context.enabled, false);
  assert.deepEqual(context.mutationAuthority, {
    issueMutation: false,
    authorityIssuance: false,
    merge: false,
    close: false,
    deploy: false,
    sourceActivation: false,
  });
  assert.deepEqual(context.mutationBounds, { maxIssueMutationsPerRecurrence: 0, maxCommentsPerRecurrence: 0 });
});

test('the third fixture loads through the same resolver with no source-code special casing', () => {
  const registry = loadManagerProfileRegistry();
  const profile = resolveRegisteredManagerProfile({ projectId: 'fixture-third-project', registry });
  assert.equal(profile.repository.full, 'TheTekTeam/example-docs-site');
  assert.equal(profile.controlIssue.mode, 'fixedIssue');
  assert.equal(profile.branches.default, 'release');
  const context = resolveManagerContext(profile);
  assert.equal(context.projectId, 'fixture-third-project');
});

test('resolution is deterministic and idempotent across repeated calls', () => {
  const registryA = loadManagerProfileRegistry();
  const registryB = loadManagerProfileRegistry();
  const contextA = resolveManagerContext(registryA.projectsById.modelspend);
  const contextB = resolveManagerContext(registryB.projectsById.modelspend);
  assert.deepEqual(contextA, contextB);
});

test('duplicate projectId entries in a registry are rejected', () => {
  assert.throws(
    () => loadManagerProfileRegistry({
      entries: [
        { projectId: 'agent-runner', configPath: '../../config/manager-profiles/agent-runner.json' },
        { projectId: 'agent-runner', configPath: '../../config/manager-profiles/agent-runner.json' },
      ],
    }),
    /duplicate projectId/,
  );
});

test('a registry entry whose file declares a different projectId is rejected', () => {
  assert.throws(
    () => loadManagerProfileRegistry({
      entries: [
        { projectId: 'wrong-id', configPath: '../../config/manager-profiles/agent-runner.json' },
      ],
    }),
    /does not match profile\.projectId/,
  );
});
