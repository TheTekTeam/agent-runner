import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkerRegistry } from './agent-runner-worker-pool.mjs';
import { parseManagerPreflightPacket } from './agent-runner-manager-authority.mjs';
import {
  buildCodexWorkerQualificationResult,
  CODEX_WORKER_QUALIFICATION_MODEL,
  CODEX_WORKER_QUALIFICATION_PROFILE,
} from './agent-runner-codex-worker-qualification.mjs';
import {
  acceptCodexWorkerQualificationCommandResult,
  buildCodexWorkerQualificationCommandRequest,
  CodexWorkerQualificationCommandError,
  executeCodexWorkerQualificationCommand,
} from './agent-runner-codex-worker-qualification-command.mjs';

const BASE = 'b'.repeat(40);
const REQUESTED_AT = '2026-08-27T08:00:00.000Z';
const EXPIRES_AT = '2026-08-27T09:00:00.000Z';

function registry() {
  return buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell',
    revision: 'qualification-command-fixture',
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
        authenticated: true,
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

function packet({
  id = 5436000001,
  revision = 'AR389-Z790-CODEX-1',
  fingerprint = `sha256:${'a'.repeat(64)}`,
  agent = 'codex-cli',
  branch = 'canary/codex-389-z790',
  bodySuffix = '',
} = {}) {
  const body = [
    '<!-- agent-runner:manager-preflight -->',
    '## Manager preflight packet',
    '```yaml',
    'schema_version: agent-runner-manager-preflight/v1',
    `revision: ${revision}`,
    `fingerprint: ${fingerprint}`,
    'producer_type: normal_chatgpt_manager_session',
    `approved_agent: ${agent}`,
    'execution_phase: implementation',
    'approved_repository_scope:',
    '  - TheTekTeam/agent-runner',
    `approved_branch: ${branch}`,
    `base_commit: ${BASE}`,
    'scope:',
    '  - qualify only codex-cli@dev-cluster-z790 for issue 389',
    'required_validation:',
    '  - exact one-file canary and bounded evidence',
    'stop_conditions:',
    '  - any node source authority quota sandbox or evidence mismatch',
    '```',
    bodySuffix,
  ].join('\n');
  const comment = {
    id,
    body,
    created_at: '2026-08-27T07:55:00.000Z',
    updated_at: '2026-08-27T07:55:00.000Z',
  };
  const parsed = parseManagerPreflightPacket(comment);
  assert.equal(parsed.valid, true);
  return { comment, parsed };
}

function buildInput(authority) {
  return {
    managerComments: [authority.comment],
    authorityKey: authority.parsed.authorityKey,
    packetDigest: authority.parsed.packetDigest,
    requestedAt: REQUESTED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function build(authority = packet()) {
  return buildCodexWorkerQualificationCommandRequest({
    input: buildInput(authority),
    registry: registry(),
    controllerRepositoryPath: '/controller/agent-runner',
    verifySourceFn: ({ baseSha }) => {
      assert.equal(baseSha, BASE);
      return { ok: true };
    },
  });
}

function successEvidence() {
  return {
    schemaVersion: 1,
    codexVersion: 'codex-cli 0.150.1',
    authMode: 'chatgpt',
    primaryRemainingPercent: 80,
    secondaryRemainingPercent: 90,
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
  };
}

test('Dell build binds the exact current immutable manager packet to the Z790 qualification request', () => {
  const authority = packet();
  const built = build(authority);
  assert.equal(built.authority.authorityKey, authority.parsed.authorityKey);
  assert.equal(built.authority.packetDigest, authority.parsed.packetDigest);
  assert.equal(built.request.lease.authorityFingerprint, authority.parsed.fingerprint);
  assert.equal(built.request.lease.controllerNodeId, 'dev-cluster-dell');
  assert.equal(built.request.lease.nodeId, 'dev-cluster-z790');
  assert.equal(built.request.lease.agentInstanceId, 'codex-cli@dev-cluster-z790');
  assert.equal(built.request.lease.baseSha, BASE);
  assert.equal(built.request.lease.branch, 'canary/codex-389-z790');
  assert.equal(built.request.lease.qualificationOnly, true);
});

test('build rejects stale authority and edited packet bodies without a fresh expected digest', () => {
  const old = packet({ id: 5436000001, fingerprint: `sha256:${'a'.repeat(64)}` });
  const newer = packet({ id: 5436000002, revision: 'AR389-Z790-CODEX-2', fingerprint: `sha256:${'c'.repeat(64)}` });
  assert.throws(() => buildCodexWorkerQualificationCommandRequest({
    input: {
      ...buildInput(old),
      managerComments: [old.comment, newer.comment],
    },
    registry: registry(),
    controllerRepositoryPath: '/controller/agent-runner',
    verifySourceFn: () => ({ ok: true }),
  }), (error) => error instanceof CodexWorkerQualificationCommandError && error.code === 'manager-authority-not-current');

  const edited = packet({ bodySuffix: '\nUpdated prose without a new immutable revision.' });
  assert.throws(() => buildCodexWorkerQualificationCommandRequest({
    input: {
      ...buildInput(old),
      managerComments: [edited.comment],
    },
    registry: registry(),
    controllerRepositoryPath: '/controller/agent-runner',
    verifySourceFn: () => ({ ok: true }),
  }), (error) => error instanceof CodexWorkerQualificationCommandError && error.code === 'manager-authority-not-current');
});

test('worker execute delegates only on exact Z790 identity with machine-local fixed paths and Codex executable', async () => {
  const built = build();
  let captured = null;
  const execution = await executeCodexWorkerQualificationCommand({
    input: built.request,
    registry: registry(),
    env: {
      AGENT_RUNNER_NODE_ID: 'dev-cluster-z790',
      AGENT_RUNNER_CONTROLLER_NODE_ID: 'dev-cluster-dell',
      AGENT_RUNNER_CODEX_QUALIFICATION_SOURCE_REPOSITORY: '/worker/source',
      AGENT_RUNNER_CODEX_QUALIFICATION_WORKTREE_ROOT: '/worker/worktrees',
      AGENT_RUNNER_CODEX_QUALIFICATION_STATE_ROOT: '/worker/state',
      CODEX_PATH: '/tmp/untrusted-codex',
    },
    executeFn: async (args) => {
      captured = args;
      return { replay: false, providerInvoked: false, result: { status: 'succeeded' } };
    },
  });
  assert.equal(execution.result.status, 'succeeded');
  assert.equal(captured.executingNodeId, 'dev-cluster-z790');
  assert.equal(captured.sourceRepositoryPath, '/worker/source');
  assert.equal(captured.worktreeRoot, '/worker/worktrees');
  assert.equal(captured.stateRoot, '/worker/state');
  assert.equal(captured.codexPath, '/usr/local/bin/codex');

  await assert.rejects(() => executeCodexWorkerQualificationCommand({
    input: built.request,
    registry: registry(),
    env: {
      AGENT_RUNNER_NODE_ID: 'dev-cluster-dell',
      AGENT_RUNNER_CONTROLLER_NODE_ID: 'dev-cluster-dell',
      AGENT_RUNNER_CODEX_QUALIFICATION_SOURCE_REPOSITORY: '/worker/source',
      AGENT_RUNNER_CODEX_QUALIFICATION_WORKTREE_ROOT: '/worker/worktrees',
      AGENT_RUNNER_CODEX_QUALIFICATION_STATE_ROOT: '/worker/state',
    },
    executeFn: async () => ({ result: { status: 'succeeded' } }),
  }), /worker-node-mismatch/);
});

test('Dell acceptance revalidates the same current manager authority before accepting bounded evidence', () => {
  const authority = packet();
  const built = build(authority);
  const result = buildCodexWorkerQualificationResult({
    request: built.request,
    status: 'succeeded',
    sourceSha: BASE,
    exitCode: 0,
    durationMs: 12_000,
    evidence: successEvidence(),
    completedAt: '2026-08-27T08:30:00.000Z',
  });
  const acceptance = acceptCodexWorkerQualificationCommandResult({
    input: {
      managerComments: [authority.comment],
      authorityKey: authority.parsed.authorityKey,
      packetDigest: authority.parsed.packetDigest,
      request: built.request,
      result,
    },
    registry: registry(),
    controllerRepositoryPath: '/controller/agent-runner',
    now: new Date('2026-08-27T08:40:00.000Z'),
    verifySourceFn: ({ baseSha }) => {
      assert.equal(baseSha, BASE);
      return { ok: true };
    },
  });
  assert.equal(acceptance.accepted, true);
  assert.equal(acceptance.qualified, true);
  assert.equal(acceptance.agentInstanceId, 'codex-cli@dev-cluster-z790');

  const newer = packet({ id: 5436000003, revision: 'AR389-Z790-CODEX-3', fingerprint: `sha256:${'d'.repeat(64)}` });
  assert.throws(() => acceptCodexWorkerQualificationCommandResult({
    input: {
      managerComments: [authority.comment, newer.comment],
      authorityKey: authority.parsed.authorityKey,
      packetDigest: authority.parsed.packetDigest,
      request: built.request,
      result,
    },
    registry: registry(),
    controllerRepositoryPath: '/controller/agent-runner',
    now: new Date('2026-08-27T08:40:00.000Z'),
    verifySourceFn: () => ({ ok: true }),
  }), (error) => error instanceof CodexWorkerQualificationCommandError && error.code === 'manager-authority-not-current');
});
