import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  WorkerRegistryError,
  loadWorkerCapabilitySnapshot,
  parseWorkerCapabilitySnapshot,
  parseWorkerRegistry,
  resolveWorkerRoutes,
  selectWorkerRoute,
  workerCapabilitySnapshotPath,
} from './agent-runner-worker-registry.mjs';

function registry(overrides = {}) {
  return {
    schemaVersion: 1,
    controllerNodeId: 'dell',
    workers: [
      {
        nodeId: 'dell',
        hostname: 'dev-cluster-dell',
        state: 'enabled',
        transport: { type: 'local' },
        concurrencyCap: 2,
        placementWeight: 0,
        qualifications: {
          'claude-code-cli': { state: 'qualified', revision: 'AR-CLAUDE-DELL.1' },
          'codex-cli': { state: 'unqualified' },
        },
      },
      {
        nodeId: 'z790',
        hostname: 'dev-cluster-z790',
        state: 'enabled',
        transport: {
          type: 'restricted-ssh',
          host: 'dev-cluster-z790',
          entrypoint: '/usr/local/lib/agent-runner/worker-entrypoint',
        },
        concurrencyCap: 3,
        placementWeight: 0,
        qualifications: {
          'claude-code-cli': { state: 'qualified', revision: 'AR-CLAUDE-Z790.1' },
          'codex-cli': { state: 'qualified', revision: 'AR-CODEX-Z790.1' },
        },
      },
    ],
    ...overrides,
  };
}

function capability(hostname, adapters = {}) {
  const defaults = {
    'claude-code-cli': { installed: true, path: '/home/gp/.local/bin/claude', version: '1.2.3', auth_posture: 'authenticated', qualified: false },
    'codex-cli': { installed: true, path: '/home/gp/.local/bin/codex', version: '2.3.4', auth_posture: 'authenticated', qualified: false },
  };
  return {
    schema_version: 1,
    recorded_at: '2026-08-24T20:00:00Z',
    node: hostname,
    preset: hostname.endsWith('dell') ? 'dell' : 'z790',
    scheduler_capable: hostname.endsWith('dell'),
    scheduler_enabled_by_agent_fleet: false,
    agents: Object.entries({ ...defaults, ...adapters }).map(([adapter, value]) => ({ adapter, ...value })),
    ollama_models: 'not-managed-by-agent-fleet',
  };
}

function loaded(worker, value) {
  return {
    available: true,
    path: `/state/${worker.nodeId}/agent-capabilities.json`,
    capability: parseWorkerCapabilitySnapshot(value, worker),
  };
}

test('registry requires exactly one local controller and accepts remote workers', () => {
  const parsed = parseWorkerRegistry(registry());
  assert.equal(parsed.controllerNodeId, 'dell');
  assert.equal(parsed.workers.length, 2);
  assert.equal(parsed.workers[1].transport.type, 'restricted-ssh');
});

test('controller identity mismatch fails closed', () => {
  assert.throws(
    () => parseWorkerRegistry(registry(), { env: { AGENT_RUNNER_CONTROLLER_NODE_ID: 'z790' } }),
    (error) => error instanceof WorkerRegistryError && error.reason === 'worker-controller-mismatch',
  );
});

test('second local worker is refused so no second scheduler/control identity can appear implicitly', () => {
  const value = registry();
  value.workers[1].transport = { type: 'local' };
  assert.throws(
    () => parseWorkerRegistry(value),
    (error) => error instanceof WorkerRegistryError && error.reason === 'worker-controller-topology-invalid',
  );
});

test('restricted ssh transport refuses command injection and traversal', () => {
  for (const entrypoint of ['/bin/sh -c evil', '/usr/local/../bin/worker']) {
    const value = registry();
    value.workers[1].transport.entrypoint = entrypoint;
    assert.throws(() => parseWorkerRegistry(value), /entrypoint/);
  }
});

test('capability snapshot cannot grant qualification authority and must match exact node', () => {
  const parsed = parseWorkerRegistry(registry());
  const dell = parsed.workers[0];
  const value = capability('dev-cluster-dell', {
    'claude-code-cli': { installed: true, path: '/bin/claude', version: 'x', auth_posture: 'authenticated', qualified: true },
  });
  const snapshot = parseWorkerCapabilitySnapshot(value, dell);
  assert.equal(snapshot.agents.get('claude-code-cli').reportedQualified, true);
  assert.equal(dell.qualifications['claude-code-cli'].state, 'qualified', 'manager-side qualification remains independent');

  assert.throws(
    () => parseWorkerCapabilitySnapshot({ ...value, node: 'dev-cluster-z790' }, dell),
    (error) => error instanceof WorkerRegistryError && error.reason === 'worker-capability-node-mismatch',
  );
});

test('worker capability snapshot path is derived from bounded node id only', () => {
  assert.equal(
    workerCapabilitySnapshotPath('z790', { AGENT_RUNNER_WORKER_STATE_ROOT: '/state/workers' }),
    '/state/workers/z790/agent-capabilities.json',
  );
  assert.throws(() => workerCapabilitySnapshotPath('../secret', {}), /node id/i);
});

test('missing capability snapshot is a route-local refusal, not a scheduler failure', () => {
  const parsed = parseWorkerRegistry(registry());
  const result = loadWorkerCapabilitySnapshot(parsed.workers[0], {
    env: { AGENT_RUNNER_WORKER_STATE_ROOT: '/does/not/exist' },
    readFile: () => { throw new Error('missing'); },
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'worker-capability-read-failed');
});

test('route selection requires enabled node, manager qualification, installed runtime and ready auth', () => {
  const parsed = parseWorkerRegistry(registry());
  const snapshots = {
    dell: capability('dev-cluster-dell'),
    z790: capability('dev-cluster-z790'),
  };
  const result = resolveWorkerRoutes({
    registry: parsed,
    agentId: 'claude-code-cli',
    capabilityLoader: (worker) => loaded(worker, snapshots[worker.nodeId]),
  });
  assert.deepEqual(result.routes.map((route) => route.routeId), [
    'claude-code-cli@dell',
    'claude-code-cli@z790',
  ]);
  assert.equal(result.routes[0].placementWeight, 0);
  assert.equal(result.routes[1].placementWeight, 0);
});

test('neutral placement uses active capacity then stable node id, not hard-coded Dell/Z790 preference', () => {
  const parsed = parseWorkerRegistry(registry());
  const result = selectWorkerRoute({
    registry: parsed,
    agentId: 'claude-code-cli',
    activeLeasesByNode: { dell: 1, z790: 0 },
    capabilityLoader: (worker) => loaded(worker, capability(worker.hostname)),
  });
  assert.equal(result.route.nodeId, 'z790', 'lower active load wins when placement weights are equal');

  const tie = selectWorkerRoute({
    registry: parsed,
    agentId: 'claude-code-cli',
    activeLeasesByNode: { dell: 0, z790: 0 },
    capabilityLoader: (worker) => loaded(worker, capability(worker.hostname)),
  });
  assert.equal(tie.route.nodeId, 'dell', 'equal routes use stable node id ordering only');
});

test('explicit placement weight is the only machine preference input', () => {
  const value = registry();
  value.workers[1].placementWeight = 10;
  const parsed = parseWorkerRegistry(value);
  const result = selectWorkerRoute({
    registry: parsed,
    agentId: 'claude-code-cli',
    capabilityLoader: (worker) => loaded(worker, capability(worker.hostname)),
  });
  assert.equal(result.route.nodeId, 'z790');
});

test('capacity full, auth unavailable and unqualified routes are rejected independently', () => {
  const parsed = parseWorkerRegistry(registry());
  const result = resolveWorkerRoutes({
    registry: parsed,
    agentId: 'codex-cli',
    activeLeasesByNode: { z790: 3 },
    capabilityLoader: (worker) => loaded(worker, capability(worker.hostname, {
      'codex-cli': { installed: true, path: '/bin/codex', version: 'x', auth_posture: 'auth-required-or-unknown', qualified: false },
    })),
  });
  assert.equal(result.routes.length, 0);
  assert.ok(result.rejected.some((entry) => entry.nodeId === 'dell' && entry.reason === 'worker-agent-unqualified'));
  assert.ok(result.rejected.some((entry) => entry.nodeId === 'z790' && entry.reason === 'worker-capacity-full'));
});

test('adapter implementation state is exposed without being confused with node qualification', () => {
  const parsed = parseWorkerRegistry(registry());
  const result = selectWorkerRoute({
    registry: parsed,
    agentId: 'codex-cli',
    capabilityLoader: (worker) => loaded(worker, capability(worker.hostname)),
  });
  assert.equal(result.route.nodeId, 'z790');
  assert.equal(result.route.adapterImplemented, false, 'node readiness cannot make an unfinished adapter executable');
});
