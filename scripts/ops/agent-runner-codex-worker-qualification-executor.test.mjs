import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildWorkerRegistry } from './agent-runner-worker-pool.mjs';
import {
  acceptCodexWorkerQualificationResult,
  buildCodexWorkerQualificationRequest,
  CODEX_WORKER_QUALIFICATION_EXPECTED_CONTENT,
  CODEX_WORKER_QUALIFICATION_EXPECTED_FILE,
} from './agent-runner-codex-worker-qualification.mjs';
import {
  buildCodexWorkerCanaryArgs,
  codexWorkerQualificationStatePath,
  executeCodexWorkerQualificationRequest,
  validateCodexWorkerCanaryWorkspace,
} from './agent-runner-codex-worker-qualification-executor.mjs';

const AUTHORITY = `sha256:${'a'.repeat(64)}`;

function git(cwd, args) {
  return String(execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }) || '').trim();
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-codex-worker-source-'));
  git(root, ['init', '--quiet', '-b', 'main']);
  git(root, ['config', 'user.email', 'runner@example.com']);
  git(root, ['config', 'user.name', 'Runner Test']);
  writeFileSync(join(root, 'README.md'), 'seed\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--quiet', '-m', 'seed']);
  git(root, ['remote', 'add', 'origin', 'git@github.com:TheTekTeam/agent-runner.git']);
  return { root, baseSha: git(root, ['rev-parse', 'HEAD']) };
}

function registry() {
  return buildWorkerRegistry({
    controllerNodeId: 'dev-cluster-dell',
    revision: 'executor-test',
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

function request(registryValue, baseSha) {
  return buildCodexWorkerQualificationRequest({
    registry: registryValue,
    authorityFingerprint: AUTHORITY,
    baseSha,
    branch: 'canary-codex-389-z790-test',
    worktree: 'canary-codex-389-z790-test',
    requestedAt: '2026-08-27T06:00:00.000Z',
    expiresAt: '2026-08-27T07:00:00.000Z',
  });
}

function quotaSuccess(captured = null) {
  return async ({ env }) => {
    if (captured) captured.env = env;
    return Object.freeze({
      allowed: true,
      reason: null,
      authMode: 'chatgpt',
      resourceState: Object.freeze({
        blocked: false,
        reason: null,
        primary: Object.freeze({ usedPercent: 1, remainingPercent: 99 }),
        secondary: Object.freeze({ usedPercent: 0, remainingPercent: 100 }),
      }),
    });
  };
}

function clockSequence(...values) {
  const queue = [...values];
  return () => new Date(queue.length > 1 ? queue.shift() : queue[0]);
}

function cleanupPreservedWorktree(sourceRoot, branch) {
  const lines = git(sourceRoot, ['worktree', 'list', '--porcelain']).split(/\r?\n/);
  let current = null;
  let target = null;
  for (const line of lines) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}`) target = current;
  }
  if (target && existsSync(target)) {
    execFileSync('git', ['worktree', 'remove', target], { cwd: sourceRoot, stdio: 'ignore' });
  }
  try {
    execFileSync('git', ['branch', '-d', branch], { cwd: sourceRoot, stdio: 'ignore' });
  } catch {
    // Branch may already be absent.
  }
}

test('canary argv pins ephemeral/config-isolated quota-only execution controls', () => {
  const args = buildCodexWorkerCanaryArgs({
    codexPath: '/usr/local/bin/codex',
    cwd: '/tmp/z790-worktree',
    prompt: 'bounded prompt',
  });
  assert.deepEqual(args.slice(0, 3), ['/usr/local/bin/codex', 'exec', '--json']);
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('workspace-write'));
  assert.ok(args.includes('approval_policy=never'));
  assert.ok(args.includes('model_reasoning_effort=low'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(args.some((value) => /dangerously-bypass/i.test(value)), false);
});

test('state path requires an explicit local root and exact job fingerprint', () => {
  assert.throws(() => codexWorkerQualificationStatePath({
    stateRoot: '',
    jobFingerprint: `sha256:${'a'.repeat(64)}`,
  }), /state identity is invalid/);
  assert.throws(() => codexWorkerQualificationStatePath({
    stateRoot: '/tmp/state',
    jobFingerprint: 'bad',
  }), /state identity is invalid/);
});

test('workspace validator accepts only the exact one-file mutation with unchanged HEAD', () => {
  const { root, baseSha } = createRepository();
  try {
    writeFileSync(join(root, CODEX_WORKER_QUALIFICATION_EXPECTED_FILE), CODEX_WORKER_QUALIFICATION_EXPECTED_CONTENT);
    assert.equal(validateCodexWorkerCanaryWorkspace({ cwd: root, baseSha }).ok, true);
    writeFileSync(join(root, 'README.md'), 'unexpected\n');
    assert.equal(validateCodexWorkerCanaryWorkspace({ cwd: root, baseSha }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executor completes one bounded canary, strips API/Git mutation env, cleans workspace and replays without a second provider call', async () => {
  const source = createRepository();
  const reg = registry();
  const built = request(reg, source.baseSha);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-codex-worker-root-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-runner-codex-worker-state-'));
  const captured = {};
  let invocations = 0;

  try {
    const execution = await executeCodexWorkerQualificationRequest({
      request: built,
      registry: reg,
      executingNodeId: 'dev-cluster-z790',
      sourceRepositoryPath: source.root,
      worktreeRoot,
      stateRoot,
      codexPath: '/usr/local/bin/codex',
      env: {
        HOME: '/home/test',
        PATH: process.env.PATH,
        OPENAI_API_KEY: 'must-not-cross',
        CODEX_API_KEY: 'must-not-cross',
        GH_TOKEN: 'must-not-cross',
        SSH_AUTH_SOCK: '/tmp/must-not-cross',
      },
      clock: clockSequence(
        '2026-08-27T06:30:00.000Z',
        '2026-08-27T06:31:00.000Z',
      ),
      versionProbeFn: () => ({ ok: true, version: 'codex-cli 0.150.1' }),
      quotaPreflightFn: quotaSuccess(captured),
      admissionFn: () => ({ allowed: true, reason: 'adapter-admitted' }),
      sandboxProbeFn: () => ({ ok: true }),
      invokeCanaryFn: ({ cwd, childEnv }) => {
        invocations += 1;
        captured.childEnv = childEnv;
        writeFileSync(join(cwd, CODEX_WORKER_QUALIFICATION_EXPECTED_FILE), CODEX_WORKER_QUALIFICATION_EXPECTED_CONTENT);
        return { ok: true, mutatedRepository: true };
      },
    });

    assert.equal(execution.replay, false);
    assert.equal(execution.providerInvoked, true);
    assert.equal(invocations, 1);
    assert.equal(captured.env.OPENAI_API_KEY, undefined);
    assert.equal(captured.env.CODEX_API_KEY, undefined);
    assert.equal(captured.env.GH_TOKEN, undefined);
    assert.equal(captured.env.SSH_AUTH_SOCK, undefined);
    assert.equal(captured.childEnv.OPENAI_API_KEY, undefined);
    assert.equal(captured.childEnv.GH_TOKEN, undefined);

    const acceptance = acceptCodexWorkerQualificationResult({
      request: built,
      result: execution.result,
      registry: reg,
      now: new Date('2026-08-27T06:32:00.000Z'),
    });
    assert.equal(acceptance.accepted, true);
    assert.equal(acceptance.qualified, true);

    assert.equal(git(source.root, ['status', '--porcelain']), '');
    assert.equal(git(source.root, ['branch', '--list', built.lease.branch]), '');

    const statePath = codexWorkerQualificationStatePath({
      stateRoot,
      jobFingerprint: built.job.jobFingerprint,
    });
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.status, 'completed');
    assert.equal(state.providerInvoked, true);

    const replay = await executeCodexWorkerQualificationRequest({
      request: built,
      registry: reg,
      executingNodeId: 'dev-cluster-z790',
      sourceRepositoryPath: source.root,
      worktreeRoot,
      stateRoot,
      clock: () => new Date('2026-08-27T06:33:00.000Z'),
      versionProbeFn: () => {
        throw new Error('replay must not reprobe provider');
      },
    });
    assert.equal(replay.replay, true);
    assert.equal(replay.providerInvoked, false);
    assert.equal(invocations, 1);
    assert.equal(replay.result.resultFingerprint, execution.result.resultFingerprint);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('quota refusal happens before worktree/state/provider invocation', async () => {
  const source = createRepository();
  const reg = registry();
  const built = request(reg, source.baseSha);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-codex-worker-root-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-runner-codex-worker-state-'));
  let invoked = false;
  try {
    await assert.rejects(() => executeCodexWorkerQualificationRequest({
      request: built,
      registry: reg,
      executingNodeId: 'dev-cluster-z790',
      sourceRepositoryPath: source.root,
      worktreeRoot,
      stateRoot,
      clock: () => new Date('2026-08-27T06:30:00.000Z'),
      versionProbeFn: () => ({ ok: true, version: 'codex-cli 0.150.1' }),
      quotaPreflightFn: async () => ({
        allowed: false,
        reason: 'codex-quota-threshold-exceeded',
        authMode: 'chatgpt',
        resourceState: { blocked: true, reason: 'codex-quota-threshold-exceeded' },
      }),
      invokeCanaryFn: () => {
        invoked = true;
      },
    }), /codex-quota-threshold-exceeded/);

    assert.equal(invoked, false);
    assert.equal(git(source.root, ['branch', '--list', built.lease.branch]), '');
    assert.equal(existsSync(codexWorkerQualificationStatePath({
      stateRoot,
      jobFingerprint: built.job.jobFingerprint,
    })), false);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('sandbox refusal cleans the temporary worktree and leaves authority unconsumed', async () => {
  const source = createRepository();
  const reg = registry();
  const built = request(reg, source.baseSha);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-codex-worker-root-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-runner-codex-worker-state-'));
  try {
    await assert.rejects(() => executeCodexWorkerQualificationRequest({
      request: built,
      registry: reg,
      executingNodeId: 'dev-cluster-z790',
      sourceRepositoryPath: source.root,
      worktreeRoot,
      stateRoot,
      clock: () => new Date('2026-08-27T06:30:00.000Z'),
      versionProbeFn: () => ({ ok: true, version: 'codex-cli 0.150.1' }),
      quotaPreflightFn: quotaSuccess(),
      admissionFn: () => ({ allowed: true }),
      sandboxProbeFn: () => ({ ok: false, reason: 'codex-sandbox-write-failed' }),
    }), /codex-sandbox-write-failed/);

    assert.equal(git(source.root, ['branch', '--list', built.lease.branch]), '');
    assert.equal(existsSync(codexWorkerQualificationStatePath({
      stateRoot,
      jobFingerprint: built.job.jobFingerprint,
    })), false);
  } finally {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('provider failure consumes authority once and preserves clean forensic worktree/branch', async () => {
  const source = createRepository();
  const reg = registry();
  const built = request(reg, source.baseSha);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-codex-worker-root-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-runner-codex-worker-state-'));
  try {
    const execution = await executeCodexWorkerQualificationRequest({
      request: built,
      registry: reg,
      executingNodeId: 'dev-cluster-z790',
      sourceRepositoryPath: source.root,
      worktreeRoot,
      stateRoot,
      clock: clockSequence(
        '2026-08-27T06:30:00.000Z',
        '2026-08-27T06:31:00.000Z',
      ),
      versionProbeFn: () => ({ ok: true, version: 'codex-cli 0.150.1' }),
      quotaPreflightFn: quotaSuccess(),
      admissionFn: () => ({ allowed: true }),
      sandboxProbeFn: () => ({ ok: true }),
      invokeCanaryFn: () => ({
        ok: false,
        reason: 'codex-file-change-failed',
        mutatedRepository: false,
      }),
    });

    assert.equal(execution.providerInvoked, true);
    assert.equal(execution.result.status, 'failed');
    const statePath = codexWorkerQualificationStatePath({
      stateRoot,
      jobFingerprint: built.job.jobFingerprint,
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.status, 'failed');
    assert.equal(state.providerInvoked, true);
    assert.equal(state.reason, 'codex-file-change-failed');
    assert.notEqual(git(source.root, ['branch', '--list', built.lease.branch]), '');

    const worktrees = git(source.root, ['worktree', 'list', '--porcelain']);
    assert.match(worktrees, new RegExp(`branch refs/heads/${built.lease.branch}`));
  } finally {
    cleanupPreservedWorktree(source.root, built.lease.branch);
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(source.root, { recursive: true, force: true });
  }
});
