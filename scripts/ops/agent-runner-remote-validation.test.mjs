import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  RemoteValidationReplayStore,
  acceptRemoteValidationResult,
  buildRemoteValidationRequest,
  buildRemoteValidationResult,
  executeRemoteValidationRequest,
  normalizeRemoteValidationProfiles,
  remoteValidationControlSurface,
  validateRemoteValidationRequest,
} from './agent-runner-remote-validation.mjs';
import { buildWorkerRegistry } from './agent-runner-worker-pool.mjs';

const AUTHORITY = `sha256:${'a'.repeat(64)}`;
const REQUESTED = '2026-08-25T12:00:00.000Z';
const EXPIRES = '2026-08-25T12:30:00.000Z';
const NOW = new Date('2026-08-25T12:05:00.000Z');

function registry({ toolchains = ['node22'] } = {}) {
  return buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell',
    revision: 'z790-validation-fixture-1',
    nodes: [
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
        jobClasses: ['validation'],
        capacity: { maxConcurrent: 1, available: 1 },
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
        capabilities: ['git'],
        toolchains,
        jobClasses: ['validation', 'build', 'test'],
        capacity: { maxConcurrent: 2, available: 2 },
        healthRevision: 'z790-1',
      },
    ],
    agentInstances: [],
  });
}

const profiles = Object.freeze({
  fixture: Object.freeze({
    revision: '1',
    resourceClass: 'standard',
    replayable: true,
    commands: Object.freeze([
      Object.freeze({
        argv: Object.freeze([
          'node',
          '-e',
          'process.exit(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ? 9 : 0)',
        ]),
        workingDirectory: '.',
        environment: Object.freeze(['PATH', 'HOME']),
        timeoutSeconds: 30,
        maxOutputBytes: 64 * 1024,
      }),
    ]),
  }),
});

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-remote-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const worktrees = join(root, 'worktrees');
  const replay = join(root, 'replay');
  mkdirSync(source, { recursive: true });
  mkdirSync(worktrees, { recursive: true });
  spawnSync('git', ['init', '-q', source], { encoding: 'utf8' });
  git(source, ['config', 'user.email', 'agent-runner@example.invalid']);
  git(source, ['config', 'user.name', 'Agent Runner Test']);
  writeFileSync(join(source, 'fixture.txt'), 'remote validation fixture\n');
  git(source, ['add', 'fixture.txt']);
  git(source, ['commit', '-q', '-m', 'fixture']);
  const sourceSha = git(source, ['rev-parse', 'HEAD']).toLowerCase();
  const sourceTreeSha = git(source, ['rev-parse', 'HEAD^{tree}']).toLowerCase();
  return { root, source, worktrees, replay, sourceSha, sourceTreeSha };
}

function requestFixture(sourceSha = 'b'.repeat(40), sourceTreeSha = 'c'.repeat(40), reg = registry()) {
  return buildRemoteValidationRequest({
    registry: reg,
    nodeId: 'dev-cluster-z790',
    projectId: 'agent-runner',
    repository: 'TheTekTeam/agent-runner',
    sourceSha,
    sourceTreeSha,
    profileId: 'fixture',
    profiles,
    authorityFingerprint: AUTHORITY,
    authorityRevision: 'AR199-FIXTURE-1',
    requestedAt: REQUESTED,
    expiresAt: EXPIRES,
  });
}

test('remote validation request is exact-node, exact-source and profile-contract bound', () => {
  const reg = registry();
  const request = requestFixture(undefined, undefined, reg);
  const accepted = validateRemoteValidationRequest({
    request,
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    profiles,
    now: NOW,
  });
  assert.equal(accepted.valid, true);

  assert.equal(validateRemoteValidationRequest({
    request,
    registry: reg,
    executingNodeId: 'dev-cluster-dell',
    profiles,
    now: NOW,
  }).reason, 'wrong-node');

  assert.equal(validateRemoteValidationRequest({
    request: { ...request, argv: ['sh', '-c', 'anything'] },
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    profiles,
    now: NOW,
  }).reason, 'request-field-set-invalid');

  assert.equal(validateRemoteValidationRequest({
    request: { ...request, sourceSha: 'd'.repeat(40) },
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    profiles,
    now: NOW,
  }).reason, 'job-fingerprint-mismatch');
});

test('profile commands are source-side allowlists and reject unsafe environment inheritance', () => {
  const normalized = normalizeRemoteValidationProfiles(profiles);
  assert.deepEqual(normalized.fixture.commands[0].environment, ['HOME', 'PATH']);
  assert.throws(() => normalizeRemoteValidationProfiles({
    bad: {
      revision: '1',
      commands: [{
        argv: ['node', '--version'],
        workingDirectory: '.',
        environment: ['OPENAI_API_KEY'],
        timeoutSeconds: 30,
      }],
    },
  }), /environment name is not allowed/);
  assert.throws(() => normalizeRemoteValidationProfiles({
    bad: {
      revision: '1',
      commands: [{
        argv: ['/bin/sh', '-c', 'echo unsafe'],
        workingDirectory: '.',
        environment: [],
        timeoutSeconds: 30,
      }],
    },
  }), /executable is invalid/);
});

test('worker execution uses an isolated detached exact worktree, strips provider credentials and replays exact successful jobs', (t) => {
  const fixture = sourceFixture(t);
  const reg = registry();
  const request = requestFixture(fixture.sourceSha, fixture.sourceTreeSha, reg);
  const replayStore = new RemoteValidationReplayStore(fixture.replay);
  let nodeExecutions = 0;
  const observedSpawn = (command, args, options) => {
    if (command === 'node') nodeExecutions += 1;
    return spawnSync(command, args, options);
  };
  const clock = () => new Date('2026-08-25T12:05:00.000Z');

  const first = executeRemoteValidationRequest({
    request,
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    sourceRepositoryPath: fixture.source,
    worktreeRoot: fixture.worktrees,
    replayStore,
    profiles,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENAI_API_KEY: 'must-not-cross-worker-boundary',
      ANTHROPIC_API_KEY: 'must-not-cross-worker-boundary',
    },
    spawn: observedSpawn,
    clock,
  });

  assert.equal(first.replay, false);
  assert.equal(first.result.status, 'succeeded');
  assert.equal(first.result.exitCode, 0);
  assert.equal(first.result.observedSha, fixture.sourceSha);
  assert.equal(first.result.observedTreeSha, fixture.sourceTreeSha);
  assert.equal(nodeExecutions, 1);
  assert.deepEqual(readdirSync(fixture.worktrees), []);
  assert.equal('stdout' in first.result, false);
  assert.equal('stderr' in first.result, false);
  assert.equal('diagnostic' in first.result, false);

  const controllerAcceptance = acceptRemoteValidationResult({
    request,
    result: first.result,
    registry: reg,
    profiles,
    now: NOW,
  });
  assert.equal(controllerAcceptance.accepted, true);

  const replayed = executeRemoteValidationRequest({
    request,
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    sourceRepositoryPath: fixture.source,
    worktreeRoot: fixture.worktrees,
    replayStore,
    profiles,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    spawn: observedSpawn,
    clock,
  });
  assert.equal(replayed.replay, true);
  assert.equal(replayed.result.resultFingerprint, first.result.resultFingerprint);
  assert.equal(nodeExecutions, 1);
});

test('Dell result acceptance fails closed on wrong source, node/toolchain identity and tampering', () => {
  const reg = registry();
  const request = requestFixture(undefined, undefined, reg);
  const base = buildRemoteValidationResult({
    request,
    status: 'succeeded',
    observedSha: request.sourceSha,
    observedTreeSha: request.sourceTreeSha,
    exitCode: 0,
    durationMs: 1_000,
    startedAt: '2026-08-25T12:01:00.000Z',
    completedAt: '2026-08-25T12:01:01.000Z',
    replayable: true,
  });
  assert.equal(acceptRemoteValidationResult({ request, result: base, registry: reg, profiles, now: NOW }).accepted, true);
  assert.equal(acceptRemoteValidationResult({
    request,
    result: { ...base, observedSha: 'd'.repeat(40) },
    registry: reg,
    profiles,
    now: NOW,
  }).reason, 'source-sha-mismatch');
  assert.equal(acceptRemoteValidationResult({
    request,
    result: { ...base, nodeCapabilityFingerprint: `sha256:${'e'.repeat(64)}` },
    registry: reg,
    profiles,
    now: NOW,
  }).reason, 'result-identity-mismatch:nodeCapabilityFingerprint');
  assert.equal(acceptRemoteValidationResult({
    request,
    result: { ...base, stdoutBytes: 7 },
    registry: reg,
    profiles,
    now: NOW,
  }).reason, 'result-fingerprint-mismatch');
});

test('failed, partial or expired evidence can never be converted into success', () => {
  const reg = registry();
  const request = requestFixture(undefined, undefined, reg);
  const failed = buildRemoteValidationResult({
    request,
    status: 'failed',
    observedSha: request.sourceSha,
    observedTreeSha: request.sourceTreeSha,
    exitCode: 1,
    errorCode: 'validation-command-failed',
    durationMs: 1_000,
    startedAt: '2026-08-25T12:01:00.000Z',
    completedAt: '2026-08-25T12:01:01.000Z',
    replayable: true,
  });
  assert.equal(acceptRemoteValidationResult({ request, result: failed, registry: reg, profiles, now: NOW }).reason, 'validation-failed');
  assert.equal(acceptRemoteValidationResult({
    request,
    result: { ...failed, resultFingerprint: undefined },
    registry: reg,
    profiles,
    now: NOW,
  }).reason, 'result-fingerprint-mismatch');
  assert.equal(validateRemoteValidationRequest({
    request,
    registry: reg,
    executingNodeId: 'dev-cluster-z790',
    profiles,
    now: new Date('2026-08-25T12:31:00.000Z'),
  }).reason, 'request-expired');
});

test('deterministic validation worker surface contains no scheduler, provider or GitHub authority', () => {
  const surface = remoteValidationControlSurface();
  assert.equal(surface.scheduler, false);
  assert.equal(surface.queueSelection, false);
  assert.equal(surface.issueClaim, false);
  assert.equal(surface.managerAuthority, false);
  assert.equal(surface.githubMutation, false);
  assert.equal(surface.mergeCloseDeploy, false);
  assert.equal(surface.sourceActivation, false);
  assert.equal(surface.providerInvocation, false);
  assert.equal(surface.arbitraryShell, false);
  assert.equal(surface.requestPaths, false);
});
