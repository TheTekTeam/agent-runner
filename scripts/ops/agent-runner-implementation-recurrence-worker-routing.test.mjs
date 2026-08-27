import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  admitRecurrenceSelections,
  laneAdmissionCandidateForSelection,
} from './agent-runner-implementation-recurrence.mjs';
import { buildWorkerRegistry } from './agent-runner-worker-pool.mjs';
import {
  replaceLiveWorkerRegistry,
  transitionLiveWorkerInstance,
} from './agent-runner-live-worker-registry-store.mjs';
import {
  LIVE_WORKER_REGISTRY_ENV,
  REMOTE_WORKER_DISPATCH_ENV,
  WORKER_NODE_PREFERENCE_ENV,
} from './agent-runner-live-worker-routing.mjs';

function selection() {
  return {
    entry: { config: { projectId: 'agent-runner', githubRepo: 'TheTekTeam/agent-runner' } },
    outcome: { runnable: true, selectedIssue: 327, selectedAgentId: 'claude-code-cli' },
  };
}

function registry({ localReady = true } = {}) {
  return buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell',
    revision: 'live-routing-1',
    nodes: [
      {
        nodeId: 'dev-cluster-dell', state: 'enabled', readiness: localReady ? 'ready' : 'unavailable', controller: true, workerOnly: false,
        os: 'linux', arch: 'x64', capabilities: [], toolchains: ['node-22'], jobClasses: ['implementation'],
        capacity: { maxConcurrent: 2, available: localReady ? 1 : 0 }, healthRevision: 'dell-1',
      },
      {
        nodeId: 'dev-cluster-z790', state: 'enabled', readiness: 'ready', controller: false, workerOnly: true,
        os: 'linux', arch: 'x64', capabilities: [], toolchains: ['node-22'], jobClasses: ['implementation'],
        capacity: { maxConcurrent: 2, available: 2 }, healthRevision: 'z790-1',
      },
    ],
    agentInstances: [
      {
        nodeId: 'dev-cluster-dell', adapterId: 'claude-code-cli', lifecycle: 'enabled', readiness: localReady ? 'ready' : 'unavailable',
        authenticated: localReady, qualified: localReady, qualificationRevision: localReady ? 'dell-q1' : 'unqualified',
        providerAccountClass: 'claude-subscription', models: [], profiles: [], jobClasses: ['implementation'], maxConcurrent: 1, active: 0,
      },
      {
        nodeId: 'dev-cluster-z790', adapterId: 'claude-code-cli', lifecycle: 'enabled', readiness: 'ready',
        authenticated: true, qualified: true, qualificationRevision: 'z790-q1', providerAccountClass: 'claude-subscription',
        models: [], profiles: [], jobClasses: ['implementation'], maxConcurrent: 1, active: 0,
      },
    ],
  });
}

function registryEnv(value, extra = {}) {
  return {
    ...extra,
    [LIVE_WORKER_REGISTRY_ENV]: JSON.stringify({
      controllerNodeId: value.controllerNodeId,
      revision: value.revision,
      nodes: value.nodes,
      agentInstances: value.agentInstances,
      registryFingerprint: value.registryFingerprint,
    }),
  };
}

test('recurrence consumes live registry but remains local-only before remote transport activation', () => {
  const value = registry();
  const result = admitRecurrenceSelections([selection()], {
    env: registryEnv(value),
    maxParallel: 2,
    remoteTransportAvailable: false,
  });
  assert.equal(result.admittedSelections.length, 1);
  assert.equal(result.admittedSelections[0].workerRoute.nodeId, 'dev-cluster-dell');
  assert.equal(result.admission.admitted[0].agentInstanceId, 'claude-code-cli@dev-cluster-dell');
  assert.equal(result.registryFingerprint, value.registryFingerprint);
  assert.equal(result.remoteRouteEnabled, false);
});

test('remote-only capacity is rejected before invocation when no bounded remote transport exists', () => {
  const value = registry({ localReady: false });
  const result = admitRecurrenceSelections([selection()], {
    env: registryEnv(value, { [REMOTE_WORKER_DISPATCH_ENV]: 'true' }),
    maxParallel: 2,
    remoteTransportAvailable: false,
  });
  assert.equal(result.admittedSelections.length, 0);
  assert.equal(result.routeRejected.length, 1);
  assert.equal(result.routeRejected[0].reasons[0], 'remote-worker-dispatch-not-activated');
  assert.equal(result.routeRejected[0].workerRoute.nodeId, 'dev-cluster-z790');
});

test('explicit route flag plus bounded transport availability can admit the qualified Z790 lane', () => {
  const value = registry();
  const result = admitRecurrenceSelections([selection()], {
    env: registryEnv(value, {
      [REMOTE_WORKER_DISPATCH_ENV]: 'true',
      [WORKER_NODE_PREFERENCE_ENV]: 'dev-cluster-z790,dev-cluster-dell',
    }),
    maxParallel: 2,
    remoteTransportAvailable: true,
  });
  assert.equal(result.remoteRouteEnabled, true);
  assert.equal(result.admittedSelections.length, 1);
  assert.equal(result.admittedSelections[0].workerRoute.nodeId, 'dev-cluster-z790');
  assert.equal(result.admittedSelections[0].workerRoute.agentInstanceId, 'claude-code-cli@dev-cluster-z790');
  assert.equal(result.admission.admitted[0].nodeId, 'dev-cluster-z790');
});

test('worker route cannot change the adapter identity selected by candidate authority', () => {
  const selected = selection();
  const candidate = laneAdmissionCandidateForSelection(selected.entry, selected.outcome, {
    workerRoute: {
      nodeId: 'dev-cluster-z790',
      agentInstanceId: 'claude-code-cli@dev-cluster-z790',
    },
  });
  assert.equal(candidate.adapterId, 'claude-code-cli');
  assert.equal(candidate.agentInstanceId, 'claude-code-cli@dev-cluster-z790');
});


test('recurrence consumes canonical durable registry with hard route admission before remote lane execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-recurrence-fleet-'));
  const path = join(root, 'live-worker-registry.json');
  try {
    replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: {
        controllerNodeId: 'dev-cluster-dell',
        nodes: [
          {
            nodeId: 'dev-cluster-dell', state: 'enabled', readiness: 'ready', controller: true, workerOnly: false,
            os: 'linux', arch: 'x64', capabilities: [], toolchains: ['node-22'], jobClasses: ['implementation'],
            capacity: { maxConcurrent: 2, available: 2 }, healthRevision: 'dell-live-1',
          },
          {
            nodeId: 'dev-cluster-z790', state: 'enabled', readiness: 'ready', controller: false, workerOnly: true,
            os: 'linux', arch: 'x64', capabilities: [], toolchains: ['node-22'], jobClasses: ['implementation'],
            capacity: { maxConcurrent: 2, available: 2 }, healthRevision: 'z790-live-1',
          },
        ],
        agentInstances: [
          {
            nodeId: 'dev-cluster-z790',
            adapterId: 'claude-code-cli',
            lifecycle: 'disabled',
            readiness: 'ready',
            authenticated: true,
            qualified: true,
            qualificationRevision: 'claude-z790-7e13ce3be223baf8',
            qualificationEvidenceFingerprint: 'sha256:7e13ce3be223baf8967748ca5f48c96ea27fa945f3239124360f5c1395026efe',
            providerAccountClass: 'claude-subscription',
            costPosture: 'included-subscription',
            paid: false,
            models: ['sonnet'],
            profiles: ['narrow'],
            jobClasses: ['implementation'],
            maxConcurrent: 1,
            active: 0,
          },
        ],
        providerAccountCaps: { 'claude-subscription': 1 },
      },
    });
    transitionLiveWorkerInstance({
      path,
      expectedRevision: 1,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'claude-code-cli@dev-cluster-z790',
      targetState: 'enabled',
      authorityRevision: 'AR402-RECURRENCE-TEST-1',
      authorityFingerprint: `sha256:${'8'.repeat(64)}`,
    });

    const result = admitRecurrenceSelections([selection()], {
      env: {
        HOME: root,
        AGENT_RUNNER_WORKER_REGISTRY_PATH: path,
        [REMOTE_WORKER_DISPATCH_ENV]: 'true',
        [WORKER_NODE_PREFERENCE_ENV]: 'dev-cluster-z790',
      },
      maxParallel: 1,
      remoteTransportAvailable: true,
    });
    assert.equal(result.registrySource, 'canonical-store');
    assert.equal(result.registryDocumentRevision, 2);
    assert.equal(result.remoteRouteEnabled, true);
    assert.equal(result.admittedSelections.length, 1);
    assert.equal(result.routes[0].workerRoute.hardAdmission, true);
    assert.equal(result.routes[0].workerRoute.agentInstanceId, 'claude-code-cli@dev-cluster-z790');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
