import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkerRegistry, selectWorkerRoute } from './agent-runner-worker-pool.mjs';
import {
  acceptClaudeWorkerQualificationResult,
  buildClaudeWorkerQualificationRequest,
  buildClaudeWorkerQualificationResult,
  CLAUDE_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT,
  CLAUDE_WORKER_QUALIFICATION_MODEL,
  CLAUDE_WORKER_QUALIFICATION_PROFILE,
  CLAUDE_WORKER_QUALIFICATION_TARGET_NODE,
  claudeWorkerQualificationControlSurface,
  validateClaudeWorkerQualificationRequest,
} from './agent-runner-claude-worker-qualification.mjs';

const AUTHORITY = `sha256:${'a'.repeat(64)}`;
const BASE = 'b'.repeat(40);
const TOOL_POLICY_FINGERPRINT = `sha256:${'c'.repeat(64)}`;

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
        adapterId: 'claude-code-cli',
        lifecycle: 'enabled',
        readiness: 'ready',
        authenticated,
        qualified: false,
        qualificationRevision: 'unqualified',
        providerAccountClass: 'claude-subscription-a',
        models: ['sonnet'],
        profiles: ['narrow'],
        jobClasses: ['implementation'],
        maxConcurrent: 1,
        active: 0,
      },
    ],
  });
}

function request(registryValue = registry()) {
  return buildClaudeWorkerQualificationRequest({
    registry: registryValue,
    authorityFingerprint: AUTHORITY,
    baseSha: BASE,
    branch: 'canary/claude-398-z790',
    worktree: 'canary-claude-398-z790',
    requestedAt: '2026-08-27T06:00:00.000Z',
    expiresAt: '2026-08-27T07:00:00.000Z',
  });
}

function successEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    claudeVersion: '2.1.231',
    authMethod: 'claude.ai',
    providerClass: 'max',
    sessionUsedPercent: 0,
    weeklyUsedPercent: 16,
    model: CLAUDE_WORKER_QUALIFICATION_MODEL,
    profile: CLAUDE_WORKER_QUALIFICATION_PROFILE,
    effort: 'low',
    permissionMode: 'dontAsk',
    promptCacheEnabled: true,
    toolPolicyAllowedRuleCount: 32,
    toolPolicyDisallowedRuleCount: 13,
    toolPolicyFingerprint: TOOL_POLICY_FINGERPRINT,
    settingSourcesEmpty: true,
    headUnchanged: true,
    exactExpectedDiff: true,
    exactExpectedContent: true,
    parserCompletionSentinelObserved: true,
    parserFilesystemAgree: true,
    branchCleaned: true,
    worktreeCleaned: true,
    rawPromptPersisted: false,
    providerOutputPersisted: false,
    sessionIdPersisted: false,
    credentialMaterialPersisted: false,
    creditFieldsUsedForAdmission: false,
    normalRoutingEnabled: false,
    ...overrides,
  };
}

test('Dell builds one exact qualification request for the unqualified Z790 Claude instance', () => {
  const reg = registry();
  const built = request(reg);

  assert.equal(built.schemaVersion, 1);
  assert.equal(built.contractFingerprint, CLAUDE_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT);
  assert.equal(built.lease.controllerNodeId, 'dev-cluster-dell');
  assert.equal(built.lease.nodeId, 'dev-cluster-z790');
  assert.equal(built.lease.agentInstanceId, 'claude-code-cli@dev-cluster-z790');
  assert.equal(built.lease.qualificationOnly, true);
  assert.equal(built.lease.baseSha, BASE);
  assert.equal(built.lease.model, 'sonnet');
  assert.equal(built.lease.profile, 'narrow');

  const normal = selectWorkerRoute(reg, {
    adapterId: 'claude-code-cli',
    model: 'sonnet',
    profile: 'narrow',
    jobClass: 'implementation',
    preferredNodeIds: ['dev-cluster-z790'],
  });
  assert.equal(normal.selected, null);
});

test('worker request validation is exact-node and rejects controller/tampered contract identity', () => {
  const reg = registry();
  const built = request(reg);

  assert.equal(validateClaudeWorkerQualificationRequest({
    request: built,
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    now: new Date('2026-08-27T06:30:00Z'),
  }).valid, true);

  assert.equal(validateClaudeWorkerQualificationRequest({
    request: built,
    registry: reg,
    executingNodeId: 'dev-cluster-dell',
    now: new Date('2026-08-27T06:30:00Z'),
  }).reason, 'worker-job:lease:wrong-node');

  assert.equal(validateClaudeWorkerQualificationRequest({
    request: { ...built, contractFingerprint: `sha256:${'f'.repeat(64)}` },
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    now: new Date('2026-08-27T06:30:00Z'),
  }).reason, 'qualification-contract-mismatch');

  const tamperedJob = { ...built.job, taskFingerprint: `sha256:${'e'.repeat(64)}` };
  assert.equal(validateClaudeWorkerQualificationRequest({
    request: { ...built, job: tamperedJob },
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    now: new Date('2026-08-27T06:30:00Z'),
  }).reason, 'task-fingerprint-mismatch');
});

test('unauthenticated Z790 instance cannot receive a qualification request', () => {
  assert.throws(
    () => request(registry({ authenticated: false })),
    /qualification route unavailable/,
  );
});

test('controller accepts only bounded successful qualification evidence', () => {
  const reg = registry();
  const built = request(reg);
  const result = buildClaudeWorkerQualificationResult({
    request: built,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 1234,
    evidence: successEvidence(),
    completedAt: '2026-08-27T06:45:00.000Z',
  });

  const accepted = acceptClaudeWorkerQualificationResult({
    request: built,
    result,
    registry: reg,
    now: new Date('2026-08-27T06:46:00Z'),
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.qualified, true);
  assert.equal(accepted.nodeId, CLAUDE_WORKER_QUALIFICATION_TARGET_NODE);
  assert.equal(accepted.agentInstanceId, 'claude-code-cli@dev-cluster-z790');
  assert.equal(accepted.evidence.providerOutputPersisted, false);
  assert.equal(accepted.evidence.normalRoutingEnabled, false);
  assert.match(accepted.qualificationRevision, /^claude-z790-[a-f0-9]{16}$/);
});

test('qualification request rejects an invalid authority window', () => {
  const reg = registry();
  assert.throws(() => buildClaudeWorkerQualificationRequest({
    registry: reg,
    authorityFingerprint: AUTHORITY,
    baseSha: BASE,
    branch: 'canary/claude-398-z790',
    worktree: 'canary-claude-398-z790',
    requestedAt: '2026-08-27T07:00:00.000Z',
    expiresAt: '2026-08-27T06:00:00.000Z',
  }), /qualification authority window is invalid/);
});

test('evidence refuses narrow session usage at or above the 75-percent threshold', () => {
  const reg = registry();
  const built = request(reg);
  assert.throws(() => buildClaudeWorkerQualificationResult({
    request: built,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 1234,
    evidence: successEvidence({ sessionUsedPercent: 75 }),
    completedAt: '2026-08-27T06:45:00.000Z',
  }), /narrow session usage/);
});

test('evidence refuses a Claude version below the repository minimum', () => {
  const reg = registry();
  const built = request(reg);
  assert.throws(() => buildClaudeWorkerQualificationResult({
    request: built,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 1234,
    evidence: successEvidence({ claudeVersion: '2.0.1' }),
    completedAt: '2026-08-27T06:45:00.000Z',
  }), /claudeVersion is below the repository minimum/);
});

test('controller refuses a successful-looking result completed outside the lease window', () => {
  const reg = registry();
  const built = request(reg);
  const result = buildClaudeWorkerQualificationResult({
    request: built,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 1234,
    evidence: successEvidence(),
    completedAt: '2026-08-27T07:05:00.000Z',
  });
  const refused = acceptClaudeWorkerQualificationResult({
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

  assert.throws(() => buildClaudeWorkerQualificationResult({
    request: built,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 1234,
    evidence: successEvidence({ providerOutputPersisted: true }),
    completedAt: '2026-08-27T06:45:00.000Z',
  }), /providerOutputPersisted must be false/);

  const failed = buildClaudeWorkerQualificationResult({
    request: built,
    status: 'failed',
    sourceSha: BASE,
    exitCode: 1,
    durationMs: 100,
    failureReason: 'claude-canary-failed',
    completedAt: '2026-08-27T06:40:00.000Z',
  });
  const refused = acceptClaudeWorkerQualificationResult({
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
  assert.deepEqual(claudeWorkerQualificationControlSurface(), {
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
