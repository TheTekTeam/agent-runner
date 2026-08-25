import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkerRegistry } from './agent-runner-worker-pool.mjs';
import {
  LIVE_WORKER_REGISTRY_ENV,
  REMOTE_WORKER_DISPATCH_ENV,
  WORKER_NODE_PREFERENCE_ENV,
  parseLiveWorkerRegistry,
  resolveLiveWorkerRoute,
  safeWorkerRouteEvidence,
} from './agent-runner-live-worker-routing.mjs';

function registry() {
  return buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell',
    revision: 'fleet-1',
    nodes: [
      {
        nodeId: 'dev-cluster-dell', state: 'enabled', readiness: 'ready', controller: true, workerOnly: false,
        os: 'linux', arch: 'x64', capabilities: ['implementation'], toolchains: ['node-22'], jobClasses: ['implementation'],
        capacity: { maxConcurrent: 2, available: 1 }, healthRevision: 'dell-1',
      },
      {
        nodeId: 'dev-cluster-z790', state: 'enabled', readiness: 'ready', controller: false, workerOnly: true,
        os: 'linux', arch: 'x64', capabilities: ['implementation'], toolchains: ['node-22'], jobClasses: ['implementation'],
        capacity: { maxConcurrent: 4, available: 4 }, healthRevision: 'z790-1',
      },
    ],
    agentInstances: [
      {
        nodeId: 'dev-cluster-dell', adapterId: 'claude-code-cli', lifecycle: 'enabled', readiness: 'ready',
        authenticated: true, qualified: true, qualificationRevision: 'claude-dell-1', providerAccountClass: 'claude-subscription',
        models: ['sonnet'], profiles: ['normal'], jobClasses: ['implementation'], maxConcurrent: 2, active: 0,
      },
      {
        nodeId: 'dev-cluster-z790', adapterId: 'claude-code-cli', lifecycle: 'enabled', readiness: 'ready',
        authenticated: true, qualified: true, qualificationRevision: 'claude-z790-1', providerAccountClass: 'claude-subscription',
        models: ['sonnet'], profiles: ['normal'], jobClasses: ['implementation'], maxConcurrent: 2, active: 0,
      },
    ],
  });
}

function serializedRegistry(value = registry()) {
  return JSON.stringify({
    controllerNodeId: value.controllerNodeId,
    revision: value.revision,
    nodes: value.nodes,
    agentInstances: value.agentInstances,
    registryFingerprint: value.registryFingerprint,
  });
}

test('absence of a live registry preserves the exact local compatibility route', () => {
  const route = resolveLiveWorkerRoute({ adapterId: 'claude-code-cli', localNodeId: 'dev-cluster-dell', env: {} });
  assert.equal(route.allowed, true);
  assert.equal(route.reason, 'local-compatibility-route');
  assert.equal(route.agentInstanceId, 'claude-code-cli@dev-cluster-dell');
  assert.equal(route.remote, false);
});

test('live registry is fingerprint-checked and controller-bound', () => {
  const value = registry();
  const env = { [LIVE_WORKER_REGISTRY_ENV]: serializedRegistry(value) };
  const parsed = parseLiveWorkerRegistry(env, { expectedControllerNodeId: 'dev-cluster-dell' });
  assert.equal(parsed.registryFingerprint, value.registryFingerprint);

  const tampered = JSON.parse(serializedRegistry(value));
  tampered.registryFingerprint = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => parseLiveWorkerRegistry({ [LIVE_WORKER_REGISTRY_ENV]: JSON.stringify(tampered) }), /fingerprint mismatch/);
  assert.throws(() => parseLiveWorkerRegistry(env, { expectedControllerNodeId: 'dev-cluster-z790' }), /controller/);
});

test('remote dispatch disabled prefers the qualified Dell instance even when Z790 has more capacity', () => {
  const value = registry();
  const route = resolveLiveWorkerRoute({
    adapterId: 'claude-code-cli', localNodeId: 'dev-cluster-dell', registry: value, env: {}, jobClass: 'implementation',
  });
  assert.equal(route.allowed, true);
  assert.equal(route.nodeId, 'dev-cluster-dell');
  assert.equal(route.agentInstanceId, 'claude-code-cli@dev-cluster-dell');
  assert.equal(route.reason, 'qualified-local-worker-route');
});

test('remote routing is considered only after explicit transport activation and can prefer Z790', () => {
  const value = registry();
  const env = {
    [REMOTE_WORKER_DISPATCH_ENV]: 'true',
    [WORKER_NODE_PREFERENCE_ENV]: 'dev-cluster-z790,dev-cluster-dell',
  };
  const route = resolveLiveWorkerRoute({
    adapterId: 'claude-code-cli', localNodeId: 'dev-cluster-dell', registry: value, env, jobClass: 'implementation',
  });
  assert.equal(route.allowed, true);
  assert.equal(route.nodeId, 'dev-cluster-z790');
  assert.equal(route.remote, true);
  assert.equal(route.reason, 'qualified-remote-worker-route');
});

test('remote-only qualified capacity fails closed while remote dispatch is not activated', () => {
  const value = registry();
  const raw = JSON.parse(serializedRegistry(value));
  raw.agentInstances = raw.agentInstances.filter((entry) => entry.nodeId === 'dev-cluster-z790');
  delete raw.registryFingerprint;
  const remoteOnly = parseLiveWorkerRegistry({ [LIVE_WORKER_REGISTRY_ENV]: JSON.stringify(raw) }, { expectedControllerNodeId: 'dev-cluster-dell' });
  const route = resolveLiveWorkerRoute({
    adapterId: 'claude-code-cli', localNodeId: 'dev-cluster-dell', registry: remoteOnly, env: {}, jobClass: 'implementation',
  });
  assert.equal(route.allowed, false);
  assert.equal(route.reason, 'remote-worker-dispatch-not-activated');
  assert.equal(route.nodeId, 'dev-cluster-z790');
});

test('unqualified/missing adapter instance is a bounded no-route refusal', () => {
  const value = registry();
  const route = resolveLiveWorkerRoute({
    adapterId: 'codex-cli', localNodeId: 'dev-cluster-dell', registry: value, env: {}, jobClass: 'implementation',
  });
  assert.equal(route.allowed, false);
  assert.equal(route.reason, 'no-qualified-worker-route');
  const evidence = safeWorkerRouteEvidence(route);
  assert.equal(evidence.allowed, false);
  assert.deepEqual(evidence.eligible, []);
  assert.equal(JSON.stringify(evidence).includes('credential'), false);
});
