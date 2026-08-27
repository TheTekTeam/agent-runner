import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkerRegistry, selectWorkerRoute } from './agent-runner-worker-pool.mjs';
import {
  acceptCodexWorkerQualificationResult,
  buildCodexWorkerQualificationRequest,
  buildCodexWorkerQualificationResult,
  CODEX_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT,
  CODEX_WORKER_QUALIFICATION_MODEL,
  CODEX_WORKER_QUALIFICATION_PROFILE,
  CODEX_WORKER_QUALIFICATION_TARGET_NODE,
  codexWorkerQualificationControlSurface,
  validateCodexWorkerQualificationRequest,
} from './agent-runner-codex-worker-qualification.mjs';

const AUTHORITY = `sha256:${'a'.repeat(64)}`;
const BASE = 'b'.repeat(40);

function registry({ authenticated = true } = {}) {
  return buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell',
    revision: authenticated ? 'qualification-ready' : 'qualification-no-auth',
    nodes: [
      {
        nodeId: 'dev-cluster-dell',
        state: 'enabled',
        readiness: 'ready',
        controller: true,
        workerOnly: false,
        os: 'linux',
        arch: 'x64',
        capabilities: ['git', 'node'],
        toolchains: ['node22'],
        jobClasses: ['implementation'],
        capacity: { maxConcurrent: 2, available: 2 },
        healthRevision: 'dell-1',
      },
      {
        nodeId: 'dev-cluster-z790',
        state: 'enabled',
        readiness: 'ready',
        controller: false,
        workerOnly: true,
        os: 'linux',
        arch: 'x64',
        capabilities: ['git', 'node'],
        toolchains: ['node22'],
        jobClasses: ['implementation'],
        capacity: { maxConcurrent: 2, available: 2 },
        healthRevision: 'z790-1',
      },
    ],
    agentInstances: [
      {
        nodeId: 'dev-cluster-z790',
        adapterId: 'codex-cli',
        lifecycle: 'enabled',
        readiness: 'ready',
        authenticated,
        qualified: false,
        qualificationRevision: 'unqualified',
        providerAccountClass: 'chatgpt-subscription-a',
        models: ['gpt-5.6-terra'],
        profiles: ['codex-canary-v1'],
        jobClasses: ['implementation'],
        maxConcurrent: 1,
        active: 0,
      },
    ],
  });
}

function request(registryValue = registry()) {
  return buildCodexWorkerQualificationRequest({
    registry: registryValue,
    authorityFingerprint: AUTHORITY,
    baseSha: BASE,
    branch: 'canary-codex-389-z790',
    worktree: 'canary-codex-389-z790',
    requestedAt: '2026-08-27T06:00:00.000Z',
    expiresAt: '2026-08-27T07:00:00.000Z',
  });
}

function successEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    codexVersion: 'codex-cli 0.150.1',
    authMode: 'chatgpt',
    primaryRemainingPercent: 99,
    secondaryRemainingPercent: 100,
    model: CODEX_WORKER_QUALIFICATION_MODEL,
    profile: CODEX_WORKER_QUALIFICATION_PROFILE,
    effort: 'low',
    sandboxMode: 'workspace-write',
    approvalMode: 'never',
    networkAccess: false,
    ephemeral: true,
    ignoreUserConfig: true,
    headUnchanged: true,
    exactExpectedDiff: true,
    exactExpectedContent: true,
    parserMutationAgrees: true,
    branchCleaned: true,
    worktreeCleaned: true,
    rawPromptPersisted: false,
    providerOutputPersisted: false,
    credentialMaterialPersisted: false,
    creditFieldsUsedForAdmission: false,
    normalCatalogueImplemented: false,
    ...overrides,
  };
}

test('Dell builds one exact qualification request for the unqualified Z790 Codex instance', () => {
  const reg = registry();
  const built = request(reg);

  assert.equal(built.schemaVersion, 1);
  assert.equal(built.contractFingerprint, CODEX_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT);
  assert.equal(built.lease.controllerNodeId, 'dev-cluster-dell');
  assert.equal(built.lease.nodeId, 'dev-cluster-z790');
  assert.equal(built.lease.agentInstanceId, 'codex-cli@dev-cluster-z790');
  assert.equal(built.lease.qualificationOnly, true);
  assert.equal(built.lease.baseSha, BASE);
  assert.equal(built.lease.model, 'gpt-5.6-terra');
  assert.equal(built.lease.profile, 'codex-canary-v1');

  const normal = selectWorkerRoute(reg, {
    adapterId: 'codex-cli',
    model: 'gpt-5.6-terra',
    profile: 'codex-canary-v1',
    jobClass: 'implementation',
    preferredNodeIds: ['dev-cluster-z790'],
  });
  assert.equal(normal.selected, null);
});

test('worker request validation is exact-node and rejects controller/tampered contract identity', () => {
  const reg = registry();
  const built = request(reg);

  assert.equal(validateCodexWorkerQualificationRequest({
    request: built,
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    now: new Date('2026-08-27T06:30:00Z'),
  }).valid, true);

  assert.equal(validateCodexWorkerQualificationRequest({
    request: built,
    registry: reg,
    executingNodeId: 'dev-cluster-dell',
    now: new Date('2026-08-27T06:30:00Z'),
  }).reason, 'worker-job:lease:wrong-node');

  assert.equal(validateCodexWorkerQualificationRequest({
    request: { ...built, contractFingerprint: `sha256:${'f'.repeat(64)}` },
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    now: new Date('2026-08-27T06:30:00Z'),
  }).reason, 'qualification-contract-mismatch');

  const tamperedJob = { ...built.job, taskFingerprint: `sha256:${'e'.repeat(64)}` };
  assert.equal(validateCodexWorkerQualificationRequest({
    request: { ...built, job: tamperedJob },
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    now: new Date('2026-08-27T06:30:00Z'),
  }).reason, 'task-fingerprint-mismatch');
});

test('unauthenticated Z790 instance cannot receive a qualification request', () => {
  assert.throws(
    () => request(registry({ authenticated: false })),
    /qualification route unavailable:agent-auth-unavailable/,
  );
});

test('controller accepts only bounded successful qualification evidence', () => {
  const reg = registry();
  const built = request(reg);
  const result = buildCodexWorkerQualificationResult({
    request: built,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 1234,
    evidence: successEvidence(),
    completedAt: '2026-08-27T06:45:00.000Z',
  });

  const accepted = acceptCodexWorkerQualificationResult({
    request: built,
    result,
    registry: reg,
    now: new Date('2026-08-27T06:46:00Z'),
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.qualified, true);
  assert.equal(accepted.nodeId, CODEX_WORKER_QUALIFICATION_TARGET_NODE);
  assert.equal(accepted.agentInstanceId, 'codex-cli@dev-cluster-z790');
  assert.equal(accepted.evidence.providerOutputPersisted, false);
  assert.equal(accepted.evidence.normalCatalogueImplemented, false);
  assert.match(accepted.qualificationRevision, /^codex-z790-[a-f0-9]{16}$/);

  assert.equal(selectWorkerRoute(reg, {
    adapterId: 'codex-cli',
    model: 'gpt-5.6-terra',
    profile: 'codex-canary-v1',
    jobClass: 'implementation',
    preferredNodeIds: ['dev-cluster-z790'],
  }).selected, null);
});

test('qualification request rejects an invalid authority window', () => {
  const reg = registry();
  assert.throws(() => buildCodexWorkerQualificationRequest({
    registry: reg,
    authorityFingerprint: AUTHORITY,
    baseSha: BASE,
    branch: 'canary-codex-389-z790',
    worktree: 'canary-codex-389-z790',
    requestedAt: '2026-08-27T07:00:00.000Z',
    expiresAt: '2026-08-27T06:00:00.000Z',
  }), /qualification authority window is invalid/);
});

test('qualification evidence refuses quota below the accepted 90-percent-used threshold', () => {
  const reg = registry();
  const built = request(reg);
  assert.throws(() => buildCodexWorkerQualificationResult({
    request: built,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 1234,
    evidence: successEvidence({ primaryRemainingPercent: 9 }),
    completedAt: '2026-08-27T06:45:00.000Z',
  }), /quota headroom is below the accepted threshold/);
});

test('controller refuses a successful-looking result completed outside the lease window', () => {
  const reg = registry();
  const built = request(reg);
  const result = buildCodexWorkerQualificationResult({
    request: built,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 1234,
    evidence: successEvidence(),
    completedAt: '2026-08-27T07:05:00.000Z',
  });
  const refused = acceptCodexWorkerQualificationResult({
    request: built,
    result,
    registry: reg,
    now: new Date('2026-08-27T06:50:00Z'),
  });
  assert.equal(refused.accepted, false);
  assert.equal(refused.reason, 'result-outside-authority-window');
});

test('unsafe or incomplete success evidence is refused before qualification', () => {
  const reg = registry();
  const built = request(reg);

  assert.throws(() => buildCodexWorkerQualificationResult({
    request: built,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 1234,
    evidence: successEvidence({ providerOutputPersisted: true }),
    completedAt: '2026-08-27T06:45:00.000Z',
  }), /providerOutputPersisted must be false/);

  const failed = buildCodexWorkerQualificationResult({
    request: built,
    status: 'failed',
    sourceSha: BASE,
    exitCode: 1,
    durationMs: 100,
    failureReason: 'codex-canary-failed',
    completedAt: '2026-08-27T06:40:00.000Z',
  });
  const refused = acceptCodexWorkerQualificationResult({
    request: built,
    result: failed,
    registry: reg,
    now: new Date('2026-08-27T06:41:00Z'),
  });
  assert.equal(refused.accepted, false);
  assert.equal(refused.qualified, false);
  assert.equal(refused.reason, 'qualification-failed');
});

test('qualification protocol grants no worker control-plane or general routing authority', () => {
  assert.deepEqual(codexWorkerQualificationControlSurface(), {
    schemaVersion: 1,
    controllerNodeId: 'dev-cluster-dell',
    targetNodeId: 'dev-cluster-z790',
    workerScheduler: false,
    workerQueueSelection: false,
    workerManagerAuthority: false,
    workerGithubManagementMutation: false,
    workerMergeCloseDeploy: false,
    workerSourceActivation: false,
    workerArbitraryShell: false,
    normalRoutingEnabled: false,
    acceptedInput: 'validated-qualification-worker-job',
    acceptedOutput: 'bounded-qualification-result-evidence',
  });
});
