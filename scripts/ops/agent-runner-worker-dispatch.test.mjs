import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertWorkerAuthority,
  buildWorkerJobEnvelope,
  buildWorkerResultEvidence,
  evaluateProviderAccountCapacity,
  evaluateRecoveryNodeAffinity,
  validateWorkerJobEnvelope,
  validateWorkerResultEvidence,
  workerControlSurface,
} from './agent-runner-worker-dispatch.mjs';
import { buildWorkerRegistry, issueWorkerLease, selectWorkerRoute } from './agent-runner-worker-pool.mjs';

const AUTHORITY = `sha256:${'a'.repeat(64)}`;
const SOURCE = 'b'.repeat(40);

function registry() {
  return buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell', revision: '1',
    nodes: [
      { nodeId: 'dev-cluster-dell', state: 'enabled', readiness: 'ready', controller: true, workerOnly: false, os: 'linux', arch: 'x64', capabilities: ['git'], toolchains: ['node22'], jobClasses: ['implementation', 'validation'], capacity: { maxConcurrent: 2, available: 2 }, healthRevision: 'dell-1' },
      { nodeId: 'dev-cluster-z790', state: 'enabled', readiness: 'ready', controller: false, workerOnly: true, os: 'linux', arch: 'x64', capabilities: ['git'], toolchains: ['node22'], jobClasses: ['implementation', 'validation'], capacity: { maxConcurrent: 2, available: 2 }, healthRevision: 'z790-1' },
    ],
    agentInstances: [
      { nodeId: 'dev-cluster-z790', adapterId: 'codex-cli', lifecycle: 'enabled', readiness: 'ready', authenticated: true, qualified: true, qualificationRevision: 'fixture-only', providerAccountClass: 'chatgpt-subscription-a', models: ['fixture-model'], profiles: ['narrow'], jobClasses: ['implementation', 'validation'], maxConcurrent: 1, active: 0 },
    ],
  });
}

function jobFixture() {
  const reg = registry();
  const route = selectWorkerRoute(reg, { adapterId: 'codex-cli', model: 'fixture-model', profile: 'narrow', jobClass: 'implementation', preferredNodeIds: ['dev-cluster-z790'] });
  const lease = issueWorkerLease({ registry: reg, route, projectId: 'agent-runner', repository: 'TheTekTeam/agent-runner', issueNumber: 327, authorityFingerprint: AUTHORITY, baseSha: SOURCE, branch: 'worker-327', worktree: 'worker-327', adapterId: 'codex-cli', model: 'fixture-model', profile: 'narrow', jobClass: 'implementation', laneId: 'lane-327-z790', validationProfile: 'canonical', expiresAt: '2026-08-26T00:00:00.000Z' });
  const job = buildWorkerJobEnvelope({ lease, operationProfile: 'implementation-fixture', operationRevision: '1', taskFingerprint: `sha256:${'c'.repeat(64)}`, requestedAt: '2026-08-25T00:00:00.000Z' });
  return { reg, lease, job };
}

test('Dell-issued job envelope validates only on its exact worker/node/lease identity', () => {
  const { reg, lease, job } = jobFixture();
  const result = validateWorkerJobEnvelope({ job, lease, registry: reg, executingNodeId: 'dev-cluster-z790', allowedProfiles: ['implementation-fixture'], now: new Date('2026-08-25T01:00:00Z') });
  assert.equal(result.valid, true);
  assert.equal(validateWorkerJobEnvelope({ job, lease, registry: reg, executingNodeId: 'dev-cluster-dell', allowedProfiles: ['implementation-fixture'], now: new Date('2026-08-25T01:00:00Z') }).reason, 'lease:wrong-node');
  assert.equal(validateWorkerJobEnvelope({ job, lease, registry: reg, executingNodeId: 'dev-cluster-z790', allowedProfiles: ['different-profile'], now: new Date('2026-08-25T01:00:00Z') }).reason, 'operation-profile-not-allowlisted');
});

test('tampered job envelope fails deterministic fingerprint validation', () => {
  const { reg, lease, job } = jobFixture();
  const tampered = { ...job, baseSha: 'd'.repeat(40) };
  const result = validateWorkerJobEnvelope({ job: tampered, lease, registry: reg, executingNodeId: 'dev-cluster-z790', allowedProfiles: ['implementation-fixture'], now: new Date('2026-08-25T01:00:00Z') });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'source-or-lane-mismatch');
});

test('worker result is bounded and cryptographically bound to controller job identity', () => {
  const { job } = jobFixture();
  const output = 'x'.repeat(20_000);
  const result = buildWorkerResultEvidence({ job, status: 'succeeded', sourceSha: 'e'.repeat(40), exitCode: 0, durationMs: 1234, output, completedAt: '2026-08-25T01:02:00.000Z' });
  assert.equal(result.diagnosticTruncated, true);
  assert.ok(Buffer.byteLength(result.diagnostic) <= 4096);
  assert.match(result.outputDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(validateWorkerResultEvidence({ result, job }).valid, true);
  assert.equal(validateWorkerResultEvidence({ result: { ...result, nodeId: 'other' }, job }).reason, 'result-identity-mismatch:nodeId');
});

test('provider/account concurrency is coordinated across nodes, not per host', () => {
  const active = [
    { nodeId: 'dev-cluster-dell', providerAccountClass: 'claude-subscription-a' },
    { nodeId: 'dev-cluster-z790', providerAccountClass: 'claude-subscription-a' },
  ];
  const full = evaluateProviderAccountCapacity({ providerAccountClass: 'claude-subscription-a', active, caps: { 'claude-subscription-a': 2 } });
  assert.equal(full.allowed, false);
  assert.equal(full.active, 2);
  const independent = evaluateProviderAccountCapacity({ providerAccountClass: 'chatgpt-subscription-a', active, caps: { 'chatgpt-subscription-a': 1 } });
  assert.equal(independent.allowed, true);
});

test('cross-node recovery requires portable checkpoint plus fresh authority and never steals exact sessions', () => {
  assert.deepEqual(evaluateRecoveryNodeAffinity({ previousNodeId: 'dev-cluster-z790', candidateNodeId: 'dev-cluster-z790', requiresExactSession: true }), { allowed: true, reason: 'same-node-recovery' });
  assert.deepEqual(evaluateRecoveryNodeAffinity({ previousNodeId: 'dev-cluster-z790', candidateNodeId: 'dev-cluster-dell', requiresExactSession: true }), { allowed: false, reason: 'exact-session-node-affinity' });
  assert.deepEqual(evaluateRecoveryNodeAffinity({ previousNodeId: 'dev-cluster-z790', candidateNodeId: 'dev-cluster-dell', portableCheckpoint: true, checkpointFingerprint: `sha256:${'f'.repeat(64)}`, freshAuthority: false }), { allowed: false, reason: 'cross-node-fresh-authority-required' });
  assert.deepEqual(evaluateRecoveryNodeAffinity({ previousNodeId: 'dev-cluster-z790', candidateNodeId: 'dev-cluster-dell', portableCheckpoint: true, checkpointFingerprint: `sha256:${'f'.repeat(64)}`, freshAuthority: true }), { allowed: true, reason: 'portable-checkpoint-fresh-authority' });
});

test('worker control surface cannot acquire scheduler/GitHub/manager/deploy authority', () => {
  const surface = workerControlSurface();
  assert.equal(surface.scheduler, false);
  assert.equal(surface.queueSelection, false);
  assert.equal(surface.managerAuthority, false);
  assert.equal(surface.githubManagementMutation, false);
  assert.equal(surface.sourceActivation, false);
  assert.throws(() => assertWorkerAuthority('issue-claim'), /worker-control-authority-forbidden/);
  assert.equal(assertWorkerAuthority('validated-job-envelope'), 'validated-job-envelope');
});
