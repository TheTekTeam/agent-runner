import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWorkerRegistry,
  buildWorkerStatusProjection,
  issueWorkerLease,
  normalizeAgentInstance,
  normalizeWorkerNode,
  selectWorkerRoute,
  validateWorkerLease,
} from './agent-runner-worker-pool.mjs';

const AUTHORITY = `sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(40);

function registry(overrides = {}) {
  return buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell',
    revision: overrides.revision || '1',
    nodes: overrides.nodes || [
      {
        nodeId: 'dev-cluster-dell', state: 'enabled', readiness: 'ready', controller: true, workerOnly: false,
        os: 'linux', arch: 'x64', capabilities: ['git', 'node'], toolchains: ['node22'],
        jobClasses: ['implementation', 'validation', 'build', 'test'], capacity: { maxConcurrent: 2, available: 1 }, healthRevision: 'dell-1',
      },
      {
        nodeId: 'dev-cluster-z790', state: 'enabled', readiness: 'ready', controller: false, workerOnly: true,
        os: 'linux', arch: 'x64', capabilities: ['git', 'node', 'local-model'], toolchains: ['node22'],
        jobClasses: ['implementation', 'validation', 'build', 'test', 'local-model'], capacity: { maxConcurrent: 3, available: 2 }, healthRevision: 'z790-1',
      },
    ],
    agentInstances: overrides.agentInstances || [
      {
        nodeId: 'dev-cluster-dell', adapterId: 'claude-code-cli', lifecycle: 'enabled', readiness: 'ready', authenticated: true, qualified: true,
        qualificationRevision: 'claude-dell-1', providerAccountClass: 'claude-subscription-a', models: ['sonnet'], profiles: ['narrow', 'complex'],
        jobClasses: ['implementation'], maxConcurrent: 1, active: 0,
      },
      {
        nodeId: 'dev-cluster-z790', adapterId: 'claude-code-cli', lifecycle: 'enabled', readiness: 'ready', authenticated: true, qualified: true,
        qualificationRevision: 'claude-z790-1', providerAccountClass: 'claude-subscription-a', models: ['sonnet'], profiles: ['narrow', 'complex'],
        jobClasses: ['implementation'], maxConcurrent: 1, active: 0,
      },
      {
        nodeId: 'dev-cluster-z790', adapterId: 'codex-cli', lifecycle: 'enabled', readiness: 'ready', authenticated: true, qualified: true,
        qualificationRevision: 'codex-z790-1', providerAccountClass: 'chatgpt-subscription-a', models: ['gpt-5.6'], profiles: ['narrow', 'complex'],
        jobClasses: ['implementation'], maxConcurrent: 1, active: 0,
      },
    ],
  });
}

function leaseFor(reg, route, overrides = {}) {
  return issueWorkerLease({
    registry: reg,
    route,
    projectId: 'agent-runner',
    repository: 'TheTekTeam/agent-runner',
    issueNumber: 327,
    authorityFingerprint: AUTHORITY,
    baseSha: SHA,
    branch: 'worker-327',
    worktree: 'worker-327',
    adapterId: overrides.adapterId || 'claude-code-cli',
    model: overrides.model || 'sonnet',
    profile: overrides.profile || 'narrow',
    jobClass: 'implementation',
    laneId: overrides.laneId || 'agent-runner-327-a',
    resourcePartition: overrides.resourcePartition || 'repo-agent-runner-327',
    validationProfile: 'canonical',
    expiresAt: overrides.expiresAt || '2026-08-26T00:00:00.000Z',
  });
}

test('registry enforces one Dell-like controller and worker-only nodes cannot become controllers', () => {
  const reg = registry();
  assert.equal(reg.controllerNodeId, 'dev-cluster-dell');
  assert.equal(reg.nodes.filter((node) => node.controller).length, 1);
  assert.equal(reg.nodes.find((node) => node.nodeId === 'dev-cluster-z790').workerOnly, true);
  assert.throws(() => normalizeWorkerNode({
    nodeId: 'bad', state: 'enabled', readiness: 'ready', controller: true, workerOnly: true,
    os: 'linux', arch: 'x64', capabilities: [], toolchains: [], jobClasses: [], capacity: { maxConcurrent: 1, available: 1 }, healthRevision: '1',
  }), /worker-only node cannot be controller/);
});

test('agent identity is exact adapter@node and qualification is per node', () => {
  const instance = normalizeAgentInstance({
    nodeId: 'node-a', adapterId: 'codex-cli', lifecycle: 'enabled', readiness: 'ready', authenticated: true, qualified: false,
    qualificationRevision: 'unqualified', models: ['gpt-5.6'], profiles: ['narrow'], jobClasses: ['implementation'], maxConcurrent: 1, active: 0,
  });
  assert.equal(instance.instanceId, 'codex-cli@node-a');
  assert.equal(instance.qualified, false);
});

test('route selection chooses an eligible exact agent@node and honours preferred node without hard-coding it', () => {
  const reg = registry();
  const route = selectWorkerRoute(reg, {
    adapterId: 'claude-code-cli', model: 'sonnet', profile: 'narrow', jobClass: 'implementation',
    requiredCapabilities: ['git'], preferredNodeIds: ['dev-cluster-dell'],
  });
  assert.deepEqual(route.selected, { nodeId: 'dev-cluster-dell', instanceId: 'claude-code-cli@dev-cluster-dell' });
  assert.ok(route.eligible.includes('claude-code-cli@dev-cluster-z790'));
});

test('ordered node preference remains controller policy rather than alphabetical token order', () => {
  const reg = registry();
  const route = selectWorkerRoute(reg, {
    adapterId: 'claude-code-cli',
    model: 'sonnet',
    profile: 'narrow',
    jobClass: 'implementation',
    preferredNodeIds: ['dev-cluster-z790', 'dev-cluster-dell'],
  });
  assert.deepEqual(route.selected, {
    nodeId: 'dev-cluster-z790',
    instanceId: 'claude-code-cli@dev-cluster-z790',
  });
});

test('full or unavailable preferred node falls through to another qualified node', () => {
  const base = registry();
  const nodes = base.nodes.map((node) => node.nodeId === 'dev-cluster-dell'
    ? { ...node, capabilityFingerprint: undefined, capacity: { maxConcurrent: 2, available: 0 } }
    : { ...node, capabilityFingerprint: undefined });
  const reg = buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell', revision: '2', nodes,
    agentInstances: base.agentInstances.map(({ instanceFingerprint, ...instance }) => instance),
  });
  const route = selectWorkerRoute(reg, {
    adapterId: 'claude-code-cli', model: 'sonnet', profile: 'narrow', jobClass: 'implementation', preferredNodeIds: ['dev-cluster-dell'],
  });
  assert.deepEqual(route.selected, { nodeId: 'dev-cluster-z790', instanceId: 'claude-code-cli@dev-cluster-z790' });
  assert.ok(route.excluded.some((entry) => entry.instanceId.endsWith('@dev-cluster-dell') && entry.reasons.includes('node-capacity-full')));
});

test('unqualified or unauthenticated agent instance is never selected', () => {
  const base = registry();
  const agentInstances = base.agentInstances.map(({ instanceFingerprint, ...instance }) => instance.adapterId === 'codex-cli'
    ? { ...instance, authenticated: false, qualified: false }
    : instance);
  const reg = buildWorkerRegistry({ controllerNodeId: 'dev-cluster-dell', revision: '2', nodes: base.nodes.map(({ capabilityFingerprint, ...node }) => node), agentInstances });
  const route = selectWorkerRoute(reg, { adapterId: 'codex-cli', model: 'gpt-5.6', profile: 'narrow', jobClass: 'implementation' });
  assert.equal(route.selected, null);
  assert.deepEqual(route.excluded[0].reasons.filter((reason) => reason.startsWith('agent-')), ['agent-auth-unavailable', 'agent-unqualified']);
});

test('immutable lease binds controller, exact source, node, agent, lane and capability fingerprints', () => {
  const reg = registry();
  const route = selectWorkerRoute(reg, { adapterId: 'claude-code-cli', model: 'sonnet', profile: 'narrow', jobClass: 'implementation', preferredNodeIds: ['dev-cluster-z790'] });
  const lease = leaseFor(reg, route);
  assert.equal(lease.controllerNodeId, 'dev-cluster-dell');
  assert.equal(lease.nodeId, 'dev-cluster-z790');
  assert.equal(lease.agentInstanceId, 'claude-code-cli@dev-cluster-z790');
  assert.equal(lease.baseSha, SHA);
  assert.match(lease.leaseFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(validateWorkerLease({ lease, registry: reg, executingNodeId: 'dev-cluster-z790', now: new Date('2026-08-25T00:00:00Z') }).valid, true);
});

test('wrong node, expired lease and tampered source/agent evidence fail closed', () => {
  const reg = registry();
  const route = selectWorkerRoute(reg, { adapterId: 'claude-code-cli', model: 'sonnet', profile: 'narrow', jobClass: 'implementation', preferredNodeIds: ['dev-cluster-z790'] });
  const lease = leaseFor(reg, route);
  assert.equal(validateWorkerLease({ lease, registry: reg, executingNodeId: 'dev-cluster-dell', now: new Date('2026-08-25T00:00:00Z') }).reason, 'wrong-node');
  assert.equal(validateWorkerLease({ lease, registry: reg, executingNodeId: 'dev-cluster-z790', now: new Date('2026-08-27T00:00:00Z') }).reason, 'lease-expired');
  assert.equal(validateWorkerLease({ lease: { ...lease, baseSha: 'c'.repeat(40) }, registry: reg, executingNodeId: 'dev-cluster-z790', now: new Date('2026-08-25T00:00:00Z') }).reason, 'lease-fingerprint-mismatch');
  assert.equal(validateWorkerLease({ lease: { ...lease, adapterId: 'codex-cli' }, registry: reg, executingNodeId: 'dev-cluster-z790', now: new Date('2026-08-25T00:00:00Z') }).reason, 'wrong-agent');
});

test('capability or qualification change after lease issuance invalidates it', () => {
  const reg = registry();
  const route = selectWorkerRoute(reg, { adapterId: 'claude-code-cli', model: 'sonnet', profile: 'narrow', jobClass: 'implementation', preferredNodeIds: ['dev-cluster-z790'] });
  const lease = leaseFor(reg, route);
  const changed = buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell', revision: '2',
    nodes: reg.nodes.map(({ capabilityFingerprint, ...node }) => node.nodeId === 'dev-cluster-z790' ? { ...node, healthRevision: 'z790-2' } : node),
    agentInstances: reg.agentInstances.map(({ instanceFingerprint, ...instance }) => instance),
  });
  assert.equal(validateWorkerLease({ lease, registry: changed, executingNodeId: 'dev-cluster-z790', now: new Date('2026-08-25T00:00:00Z') }).reason, 'registry-revision-mismatch');
});

test('status projection is bounded and contains no credentials or transport secrets', () => {
  const projection = buildWorkerStatusProjection(registry());
  const serialized = JSON.stringify(projection);
  assert.match(serialized, /dev-cluster-z790/);
  assert.match(serialized, /codex-cli@dev-cluster-z790/);
  assert.doesNotMatch(serialized, /credential|token|secret|password|privateKey/i);
  assert.equal(projection.nodes.find((node) => node.nodeId === 'dev-cluster-z790').controller, false);
});

test('future worker addition is registry data and route selection requires no hostname special-case', () => {
  const base = registry();
  const reg = buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell', revision: '3',
    nodes: [
      ...base.nodes.map(({ capabilityFingerprint, ...node }) => ({ ...node, capacity: node.nodeId === 'dev-cluster-z790' ? { ...node.capacity, available: 0 } : node.capacity })),
      { nodeId: 'future-worker-1', state: 'enabled', readiness: 'ready', controller: false, workerOnly: true, os: 'linux', arch: 'arm64', capabilities: ['git'], toolchains: ['node22'], jobClasses: ['implementation'], capacity: { maxConcurrent: 1, available: 1 }, healthRevision: 'future-1' },
    ],
    agentInstances: [
      ...base.agentInstances.map(({ instanceFingerprint, ...instance }) => instance),
      { nodeId: 'future-worker-1', adapterId: 'codex-cli', lifecycle: 'enabled', readiness: 'ready', authenticated: true, qualified: true, qualificationRevision: 'codex-future-1', providerAccountClass: 'chatgpt-subscription-b', models: ['gpt-5.6'], profiles: ['narrow'], jobClasses: ['implementation'], maxConcurrent: 1, active: 0 },
    ],
  });
  const route = selectWorkerRoute(reg, { adapterId: 'codex-cli', model: 'gpt-5.6', profile: 'narrow', jobClass: 'implementation', preferredNodeIds: ['future-worker-1'] });
  assert.deepEqual(route.selected, { nodeId: 'future-worker-1', instanceId: 'codex-cli@future-worker-1' });
});
