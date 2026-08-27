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
  planLiveWorkerRegistryPromotion,
  replaceLiveWorkerRegistry,
  safeLiveWorkerRegistrySummary,
  transitionLiveWorkerInstance,
} from './agent-runner-live-worker-registry-store.mjs';
import { parseLiveWorkerRegistry, resolveLiveWorkerRoute } from './agent-runner-live-worker-routing.mjs';
import { canonicalAcceptedQualificationResults } from './agent-runner-fleet-accepted-qualification-evidence.mjs';
import { publishFleetQualification } from './agent-runner-fleet-qualification-publication.mjs';
import {
  FLEET_ACTIVATION_AUTHORITY_MARKER,
  FLEET_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
  fleetActivationAuthorityFingerprint,
  resolveFleetActivationAuthority,
} from './agent-runner-fleet-activation-authority.mjs';

const PUBLICATION = publishFleetQualification({ acceptedResults: canonicalAcceptedQualificationResults() });
const CODEX_PUBLISHED = PUBLICATION.instances.find((entry) => entry.instanceId === 'codex-cli@dev-cluster-z790');
const CLAUDE_PUBLISHED = PUBLICATION.instances.find((entry) => entry.instanceId === 'claude-code-cli@dev-cluster-z790');
const CODEX_REVISION = CODEX_PUBLISHED.qualificationRevision;
const CODEX_FINGERPRINT = CODEX_PUBLISHED.acceptedResultFingerprint;
const CLAUDE_REVISION = CLAUDE_PUBLISHED.qualificationRevision;
const CLAUDE_FINGERPRINT = CLAUDE_PUBLISHED.acceptedResultFingerprint;

const SOURCE_SHA = '1'.repeat(40);
const CONTROL_ISSUE = 402;
const AUTH_ENV = { CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola' };

function lifecycleAuthority({
  loaded,
  instanceId,
  targetState,
  id,
  revision,
  priorComments = [],
}) {
  const material = {
    schema_version: FLEET_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
    revision,
    target_repository: 'TheTekTeam/agent-runner',
    target_issue: CONTROL_ISSUE,
    target_source_commit: SOURCE_SHA,
    target_registry_revision: loaded.revision,
    target_registry_fingerprint: loaded.registry.registryFingerprint,
    target_instance: instanceId,
    target_state: targetState,
    producer_type: 'normal_chatgpt_manager_session',
    reason: 'supervised-fleet-lifecycle-test',
  };
  const fingerprint = fleetActivationAuthorityFingerprint(material);
  const comment = {
    id,
    user: { login: 'gpcola' },
    body: `${FLEET_ACTIVATION_AUTHORITY_MARKER}
\`\`\`yaml
schema_version: ${material.schema_version}
revision: ${material.revision}
target_repository: ${material.target_repository}
target_issue: ${material.target_issue}
target_source_commit: ${material.target_source_commit}
target_registry_revision: ${material.target_registry_revision}
target_registry_fingerprint: ${material.target_registry_fingerprint}
target_instance: ${material.target_instance}
target_state: ${material.target_state}
producer_type: ${material.producer_type}
reason: ${material.reason}
fingerprint: ${fingerprint}
\`\`\`
`,
  };
  const comments = [...priorComments, comment];
  const activationAuthority = resolveFleetActivationAuthority({
    comments,
    env: AUTH_ENV,
    controlIssue: CONTROL_ISSUE,
    requestedCommentId: id,
    currentSourceCommit: SOURCE_SHA,
    registry: Object.freeze({ ...loaded.registry, documentRevision: loaded.revision }),
    instanceId,
    targetState,
    previousTransition: loaded.document?.lastTransition || null,
  });
  return { activationAuthority, comments };
}

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
      installedVersion: CODEX_PUBLISHED.installedVersion,
      qualificationContractFingerprint: CODEX_PUBLISHED.qualificationContractFingerprint,
      qualificationCapabilityFingerprint: CODEX_PUBLISHED.capabilityFingerprint,
      providerAccountClass: CODEX_PUBLISHED.providerAccountClass,
      costPosture: codexCostPosture,
      paid: codexPaid,
      models: [CODEX_PUBLISHED.model],
      profiles: [CODEX_PUBLISHED.profile],
      jobClasses: CODEX_PUBLISHED.jobClasses,
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
      installedVersion: CLAUDE_PUBLISHED.installedVersion,
      qualificationContractFingerprint: CLAUDE_PUBLISHED.qualificationContractFingerprint,
      qualificationCapabilityFingerprint: CLAUDE_PUBLISHED.capabilityFingerprint,
      providerAccountClass: CLAUDE_PUBLISHED.providerAccountClass,
      costPosture: 'included-subscription',
      paid: false,
      models: [CLAUDE_PUBLISHED.model],
      profiles: [CLAUDE_PUBLISHED.profile],
      jobClasses: CLAUDE_PUBLISHED.jobClasses,
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
      [CLAUDE_PUBLISHED.providerAccountClass]: 1,
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
    const current = replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry(),
    });
    const auth = lifecycleAuthority({
      loaded: current,
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'disabled',
      id: 100,
      revision: 'AR402-FLEET-DISABLE-STALE-1',
    });
    assert.throws(
      () => transitionLiveWorkerInstance({
        path,
        expectedRevision: 0,
        controllerNodeId: 'dev-cluster-dell',
        instanceId: 'codex-cli@dev-cluster-z790',
        targetState: 'disabled',
        activationAuthority: auth.activationAuthority,
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

    const enableAuth = lifecycleAuthority({
      loaded: initial,
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      id: 100,
      revision: 'AR402-FLEET-ACTIVATION-1',
    });
    const enabled = transitionLiveWorkerInstance({
      path,
      expectedRevision: 1,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      activationAuthority: enableAuth.activationAuthority,
    });
    const enabledCodex = enabled.registry.agentInstances.find((entry) => entry.instanceId === 'codex-cli@dev-cluster-z790');
    const enabledClaude = enabled.registry.agentInstances.find((entry) => entry.instanceId === 'claude-code-cli@dev-cluster-z790');
    assert.equal(enabledCodex.lifecycle, 'enabled');
    assert.equal(enabledCodex.qualificationRevision, beforeCodex.qualificationRevision);
    assert.equal(enabledCodex.qualificationEvidenceFingerprint, beforeCodex.qualificationEvidenceFingerprint);
    assert.equal(enabledClaude.lifecycle, beforeClaude.lifecycle);
    assert.equal(enabledClaude.qualificationRevision, beforeClaude.qualificationRevision);
    assert.equal(enabledClaude.qualificationEvidenceFingerprint, beforeClaude.qualificationEvidenceFingerprint);

    const disableAuth = lifecycleAuthority({
      loaded: enabled,
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'disabled',
      id: 101,
      revision: 'AR402-FLEET-DISABLE-1',
      priorComments: enableAuth.comments,
    });
    const disabled = transitionLiveWorkerInstance({
      path,
      expectedRevision: 2,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'disabled',
      activationAuthority: disableAuth.activationAuthority,
    });
    assert.equal(disabled.registry.agentInstances.find((entry) => entry.instanceId === 'codex-cli@dev-cluster-z790').lifecycle, 'disabled');
    assert.deepEqual(disabled.document.activationAuthorities, {});

    const restoreAuth = lifecycleAuthority({
      loaded: disabled,
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      id: 102,
      revision: 'AR402-FLEET-ACTIVATION-2',
      priorComments: disableAuth.comments,
    });
    const restored = transitionLiveWorkerInstance({
      path,
      expectedRevision: 3,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      activationAuthority: restoreAuth.activationAuthority,
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
    const current = replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry(),
    });
    const auth = lifecycleAuthority({
      loaded: current,
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      id: 110,
      revision: 'AR402-FLEET-ACTIVATION-ROUTING-1',
    });
    transitionLiveWorkerInstance({
      path,
      expectedRevision: 1,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      activationAuthority: auth.activationAuthority,
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
    const current = replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry(),
    });
    const auth = lifecycleAuthority({
      loaded: current,
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      id: 120,
      revision: 'AR402-FLEET-ACTIVATION-CAP-1',
    });
    transitionLiveWorkerInstance({
      path,
      expectedRevision: 1,
      controllerNodeId: 'dev-cluster-dell',
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      activationAuthority: auth.activationAuthority,
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
      providerAccountReservations: { chatgpt: 1 },
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
    const current = replaceLiveWorkerRegistry({
      path,
      expectedRevision: 0,
      controllerNodeId: 'dev-cluster-dell',
      registry: rawRegistry({ codexActive: 1 }),
    });
    const auth = lifecycleAuthority({
      loaded: current,
      instanceId: 'codex-cli@dev-cluster-z790',
      targetState: 'enabled',
      id: 130,
      revision: 'AR402-FLEET-ACTIVE-CONFLICT-1',
    });
    assert.throws(
      () => transitionLiveWorkerInstance({
        path,
        expectedRevision: 1,
        controllerNodeId: 'dev-cluster-dell',
        instanceId: 'codex-cli@dev-cluster-z790',
        targetState: 'enabled',
        activationAuthority: auth.activationAuthority,
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
      const current = replaceLiveWorkerRegistry({
        path,
        expectedRevision: 0,
        controllerNodeId: 'dev-cluster-dell',
        registry: rawRegistry(fixture),
      });
      const auth = lifecycleAuthority({
        loaded: current,
        instanceId: 'codex-cli@dev-cluster-z790',
        targetState: 'enabled',
        id: fixture.codexCostPosture === 'unknown' ? 140 : 141,
        revision: fixture.codexCostPosture === 'unknown'
          ? 'AR402-FLEET-COST-UNKNOWN-1'
          : 'AR402-FLEET-COST-PAID-1',
      });
      assert.throws(
        () => transitionLiveWorkerInstance({
          path,
          expectedRevision: 1,
          controllerNodeId: 'dev-cluster-dell',
          instanceId: 'codex-cli@dev-cluster-z790',
          targetState: 'enabled',
          activationAuthority: auth.activationAuthority,
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
      installedVersion: '2.1.231',
      qualificationContractFingerprint: `sha256:${'2'.repeat(64)}`,
      qualificationCapabilityFingerprint: `sha256:${'3'.repeat(64)}`,
      providerAccountClass: 'first-party',
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
