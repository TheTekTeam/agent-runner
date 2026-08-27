import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID,
  LiveWorkerRegistryStaleRevisionError,
  loadLiveWorkerRegistryDocument,
  replaceLiveWorkerRegistry,
  safeLiveWorkerRegistrySummary,
  transitionLiveWorkerInstance,
} from './agent-runner-live-worker-registry-store.mjs';
import { parseLiveWorkerRegistry, resolveLiveWorkerRoute } from './agent-runner-live-worker-routing.mjs';

const CODEX_REVISION = 'codex-z790-58e9d9edf45669ac';
const CODEX_FINGERPRINT = 'sha256:58e9d9edf45669ac354bc400c4a7bf3ccd3b3e7bce92544f7eaba76895a43dbf';
const CLAUDE_REVISION = 'claude-z790-7e13ce3be223baf8';
const CLAUDE_FINGERPRINT = 'sha256:7e13ce3be223baf8967748ca5f48c96ea27fa945f3239124360f5c1395026efe';

function tempRegistryPath() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-fleet-registry-'));
  return { root, path: join(root, 'live-worker-registry.json') };
}

function nodes() {
  return [
    {
      nodeId: 'dev-cluster-dell',
      state: 'enabled',
      readiness: 'ready',
      controller: true,
      workerOnly: false,
      os: 'linux',
      arch: 'x64',
      capabilities: ['git'],
      toolchains: ['node22'],
      jobClasses: ['implementation', 'validation'],
      capacity: { maxConcurrent: 2, available: 2 },
      healthRevision: 'dell-live-1',
    },
    {
      nodeId: 'dev-cluster-z790',
      state: 'enabled',
      readiness: 'ready',
      controller: false,
      workerOnly: true,
      os: 'linux',
      arch: 'x64',
      capabilities: ['git'],
      toolchains: ['node22'],
      jobClasses: ['implementation', 'validation'],
      capacity: { maxConcurrent: 2, available: 2 },
      healthRevision: 'z790-live-1',
    },
  ];
}

function acceptedInstances({
  codexLifecycle = 'disabled',
  claudeLifecycle = 'disabled',
  codexActive = 0,
  claudeActive = 0,
  codexCostPosture = 'included-subscription',
  codexPaid = false,
} = {}) {
  return [
    {
      nodeId: 'dev-cluster-z790',
      adapterId: 'codex-cli',
      lifecycle: codexLifecycle,
      readiness: 'ready',
      authenticated: true,
      qualified: true,
      qualificationRevision: CODEX_REVISION,
      qualificationEvidenceFingerprint: CODEX_FINGERPRINT,
      providerAccountClass: 'chatgpt',
      costPosture: codexCostPosture,
      paid: codexPaid,
      models: ['gpt-5.6-terra'],
      profiles: ['codex-canary-v1'],
      jobClasses: ['implementation'],
      maxConcurrent: 1,
      active: codexActive,
    },
    {
      nodeId: 'dev-cluster-z790',
      adapterId: 'claude-code-cli',
      lifecycle: claudeLifecycle,
      readiness: 'ready',
      authenticated: true,
      qualified: true,
      qualificationRevision: CLAUDE_REVISION,
      qualificationEvidenceFingerprint: CLAUDE_FINGERPRINT,
      providerAccountClass: 'claude-subscription',
      costPosture: 'included-subscription',
      paid: false,
      models: ['sonnet'],
      profiles: ['narrow'],
      jobClasses: ['implementation'],
      maxConcurrent: 1,
      active: claudeActive,
    },
  ];
}

function rawRegistry(options = {}) {
  return {
    controllerNodeId: LIVE_WORKER_REGISTRY_CONTROLLER_NODE_ID,
    nodes: nodes(),
    agentInstances: acceptedInstances(options),
    providerAccountCaps: {
      chatgpt: 1,
      'claude-subscription': 1,
    },
  };
}

test('replace creates a mode-0600 canonical registry and reload is deterministic', () => {
  const { root, path } = tempRegistryPath();
  try {
    const written = replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry(),
    });
    assert.equal(written.revision, 1);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    const reloaded = loadLiveWorkerRegistryDocument({ path, allowMissing: false });
    assert.equal(reloaded.registry.registryFingerprint, written.registry.registryFingerprint);
    assert.equal(reloaded.registry.revision, 'live-1');
    assert.equal(reloaded.registry.agentInstances.every((entry) => entry.lifecycle === 'disabled'), true);
    assert.equal(JSON.stringify(reloaded.document).includes('balance'), false);
    assert.equal(JSON.stringify(reloaded.document).includes('credential'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale expected revision is rejected before mutation', () => {
  const { root, path } = tempRegistryPath();
  try {
    replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry(),
    });
    assert.throws(
      () => transitionLiveWorkerInstance({
        path,
        expectedRevision: 0,
        controllerNodeId: 'dev-cluster-dell',
        instanceId: 'codex-cli@dev-cluster-z790',
        targetState: 'disabled',
      }),
      LiveWorkerRegistryStaleRevisionError,
    );
    assert.equal(loadLiveWorkerRegistryDocument({ path }).revision, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one exact agent@node can be enabled, disabled and restored without changing qualification identity or unrelated routes', () => {
  const { root, path } = tempRegistryPath();
  try {
    const initial = replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry(),
    });
    const beforeCodex = initial.registry.agentInstances.find((entry) => entry.instanceId === 'codex-cli@dev-cluster-z790');
    const beforeClaude = initial.registry.agentInstances.find((entry) => entry.instanceId === 'claude-code-cli@dev-cluster-z790');

    const enabled = transitionLiveWorkerInstance({
      path,
      expectedRevision: 1,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      authorityRevision: 'AR402-FLEET-ACTIVATION-1',
      authorityFingerprint: `sha256:${'a'.repeat(64)}`,
    });
    const enabledCodex = enabled.registry.agentInstances.find((entry) => entry.instanceId === 'codex-cli@dev-cluster-z790');
    const enabledClaude = enabled.registry.agentInstances.find((entry) => entry.instanceId === 'claude-code-cli@dev-cluster-z790');
    assert.equal(enabledCodex.lifecycle, 'enabled');
    assert.equal(enabledCodex.qualificationRevision, beforeCodex.qualificationRevision);
    assert.equal(enabledCodex.qualificationEvidenceFingerprint, beforeCodex.qualificationEvidenceFingerprint);
    assert.equal(enabledClaude.lifecycle, beforeClaude.lifecycle);
    assert.equal(enabledClaude.qualificationRevision, beforeClaude.qualificationRevision);
    assert.equal(enabledClaude.qualificationEvidenceFingerprint, beforeClaude.qualificationEvidenceFingerprint);

    const disabled = transitionLiveWorkerInstance({
      path,
      expectedRevision: 2,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'disabled',
    });
    assert.equal(disabled.registry.agentInstances.find((entry) => entry.instanceId === 'codex-cli@dev-cluster-z790').lifecycle, 'disabled');
    assert.equal(disabled.document.activationAuthority, null);

    const restored = transitionLiveWorkerInstance({
      path,
      expectedRevision: 3,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      authorityRevision: 'AR402-FLEET-ACTIVATION-2',
      authorityFingerprint: `sha256:${'b'.repeat(64)}`,
    });
    const restoredCodex = restored.registry.agentInstances.find((entry) => entry.instanceId === 'codex-cli@dev-cluster-z790');
    assert.equal(restoredCodex.qualificationRevision, CODEX_REVISION);
    assert.equal(restoredCodex.qualificationEvidenceFingerprint, CODEX_FINGERPRINT);
    assert.equal(restored.registry.agentInstances.find((entry) => entry.instanceId === 'claude-code-cli@dev-cluster-z790').lifecycle, 'disabled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical store is consumed by live routing with hard zero-paid and provider-account admission', () => {
  const { root, path } = tempRegistryPath();
  try {
    replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry(),
    });
    transitionLiveWorkerInstance({
      path,
      expectedRevision: 1,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      authorityRevision: 'AR402-FLEET-ACTIVATION-1',
      authorityFingerprint: `sha256:${'c'.repeat(64)}`,
    });
    const env = {
      HOME: root,
      AGENT_RUNNER_WORKER_REGISTRY_PATH: path,
      AGENT_RUNNER_REMOTE_WORKER_DISPATCH_ENABLED: 'true',
      AGENT_RUNNER_WORKER_NODE_PREFERENCE: 'dev-cluster-z790',
    };
    const registry = parseLiveWorkerRegistry(env, { expectedControllerNodeId: 'dev-cluster-dell' });
    assert.equal(registry.registrySource, 'canonical-store');
    const route = resolveLiveWorkerRoute({
      adapterId: 'codex-cli',
      localNodeId: 'dev-cluster-dell',
      registry,
      env,
      remoteDispatchAvailable: true,
    });
    assert.equal(route.allowed, true);
    assert.equal(route.hardAdmission, true);
    assert.equal(route.agentInstanceId, 'codex-cli@dev-cluster-z790');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-account cap blocks an otherwise qualified canonical route', () => {
  const { root, path } = tempRegistryPath();
  try {
    const saturated = rawRegistry();
    saturated.agentInstances[1] = {
      ...saturated.agentInstances[1],
      providerAccountClass: 'chatgpt',
      active: 1,
    };
    replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: saturated,
    });
    transitionLiveWorkerInstance({
      path,
      expectedRevision: 1,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      authorityRevision: 'AR402-FLEET-ACTIVATION-1',
      authorityFingerprint: `sha256:${'d'.repeat(64)}`,
    });
    const env = {
      AGENT_RUNNER_WORKER_REGISTRY_PATH: path,
      AGENT_RUNNER_REMOTE_WORKER_DISPATCH_ENABLED: 'true',
    };
    const registry = parseLiveWorkerRegistry(env, { expectedControllerNodeId: 'dev-cluster-dell' });
    const route = resolveLiveWorkerRoute({
      adapterId: 'codex-cli',
      localNodeId: 'dev-cluster-dell',
      registry,
      env,
      remoteDispatchAvailable: true,
    });
    assert.equal(route.allowed, false);
    assert.equal(route.routeEvidence.excluded[0].reasons.includes('provider-account-cap-full'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle transition refuses an instance that still reports active work', () => {
  const { root, path } = tempRegistryPath();
  try {
    replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry({ codexActive: 1 }),
    });
    assert.throws(
      () => transitionLiveWorkerInstance({
        path,
        expectedRevision: 1,
        controllerNodeId: 'dev-cluster-dell',
        instanceId: 'codex-cli@dev-cluster-z790',
        targetState: 'enabled',
        authorityRevision: 'AR402-FLEET-ACTIVATION-1',
        authorityFingerprint: `sha256:${'f'.repeat(64)}`,
      }),
      /active-work-conflict/,
    );
    assert.equal(loadLiveWorkerRegistryDocument({ path }).revision, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown or paid cost posture cannot be activated', () => {
  for (const fixture of [
    { codexCostPosture: 'unknown', codexPaid: false, expected: /cost-posture-unknown/ },
    { codexCostPosture: 'metered', codexPaid: true, expected: /paid-route-refused/ },
  ]) {
    const { root, path } = tempRegistryPath();
    try {
      replaceLiveWorkerRegistry({
        path,
        expectedRevision: 0,
        controllerNodeId: 'dev-cluster-dell',
        registry: rawRegistry(fixture),
      });
      assert.throws(
        () => transitionLiveWorkerInstance({
          path,
          expectedRevision: 1,
          controllerNodeId: 'dev-cluster-dell',
          instanceId: 'codex-cli@dev-cluster-z790',
          targetState: 'enabled',
          authorityRevision: 'AR402-FLEET-ACTIVATION-1',
          authorityFingerprint: `sha256:${'e'.repeat(64)}`,
        }),
        fixture.expected,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('stale or fabricated qualification evidence cannot enter the live registry', () => {
  const { root, path } = tempRegistryPath();
  try {
    const raw = rawRegistry();
    raw.agentInstances[0] = {
      ...raw.agentInstances[0],
      qualificationRevision: 'codex-z790-0000000000000000',
    };
    assert.throws(
      () => replaceLiveWorkerRegistry({
        path,
        expectedRevision: 0,
        controllerNodeId: 'dev-cluster-dell',
        registry: raw,
      }),
      /qualification-revision-mismatch/,
    );

    const dellGap = rawRegistry();
    dellGap.agentInstances.push({
      nodeId: 'dev-cluster-dell',
      adapterId: 'claude-code-cli',
      lifecycle: 'disabled',
      readiness: 'ready',
      authenticated: true,
      qualified: true,
      qualificationRevision: 'claude-dell-1111111111111111',
      qualificationEvidenceFingerprint: `sha256:${'1'.repeat(64)}`,
      providerAccountClass: 'claude-subscription',
      costPosture: 'included-subscription',
      paid: false,
      models: ['sonnet'],
      profiles: ['narrow'],
      jobClasses: ['implementation'],
      maxConcurrent: 1,
      active: 0,
    });
    assert.throws(
      () => replaceLiveWorkerRegistry({
        path,
        expectedRevision: 0,
        controllerNodeId: 'dev-cluster-dell',
        registry: dellGap,
      }),
      /qualification-evidence-gap/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-Dell writes and symlinked destination/path components are refused', () => {
  const { root, path } = tempRegistryPath();
  try {
    assert.throws(
      () => replaceLiveWorkerRegistry({
        path,
        expectedRevision: 0,
        controllerNodeId: 'dev-cluster-z790',
        registry: rawRegistry(),
      }),
      /controller-write-refused/,
    );

    const realDir = join(root, 'real');
    const linkDir = join(root, 'linked');
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);
    const linkedPath = join(linkDir, 'live-worker-registry.json');
    assert.throws(
      () => replaceLiveWorkerRegistry({
        path: linkedPath,
        expectedRevision: 0,
        controllerNodeId: 'dev-cluster-dell',
        registry: rawRegistry(),
      }),
      /symlink-refused/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safe summary exposes only bounded lifecycle/admission evidence', () => {
  const { root, path } = tempRegistryPath();
  try {
    const loaded = replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry(),
    });
    const summary = safeLiveWorkerRegistrySummary(loaded);
    assert.equal(summary.found, true);
    assert.equal(summary.instances.length, 2);
    assert.equal(JSON.stringify(summary).includes('session'), false);
    assert.equal(JSON.stringify(summary).includes('prompt'), false);
    assert.equal(JSON.stringify(summary).includes('balance'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
