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
  buildClaudeWorkerQualificationRequest,
  CLAUDE_WORKER_QUALIFICATION_COMPLETION_SENTINEL,
  CLAUDE_WORKER_QUALIFICATION_EXPECTED_CONTENT,
  CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE,
} from './agent-runner-claude-worker-qualification.mjs';
import {
  acceptClaudeWorkerQualificationResult,
} from './agent-runner-claude-worker-qualification.mjs';
import {
  buildClaudeWorkerCanaryArgs,
  claudeWorkerQualificationStatePath,
  executeClaudeWorkerQualificationRequest,
  inspectClaudeWorkerFirstPartyAuth,
  runClaudeWorkerQuotaPreflight,
  validateClaudeWorkerCanaryWorkspace,
} from './agent-runner-claude-worker-qualification-executor.mjs';

const AUTHORITY = `sha256:${'a'.repeat(64)}`;

function git(cwd, args) {
  return String(execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }) || '').trim();
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-claude-worker-source-'));
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
        adapterId: 'claude-code-cli',
        lifecycle: 'enabled',
        readiness: 'ready',
        authenticated: true,
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

function request(registryValue, baseSha) {
  return buildClaudeWorkerQualificationRequest({
    registry: registryValue,
    authorityFingerprint: AUTHORITY,
    baseSha,
    branch: 'canary/claude-398-z790-test',
    worktree: 'canary-claude-398-z790-test',
    requestedAt: '2026-08-27T06:00:00.000Z',
    expiresAt: '2026-08-27T07:00:00.000Z',
  });
}

function clockSequence(...values) {
  const queue = [...values];
  return () => new Date(queue.length > 1 ? queue.shift() : queue[0]);
}

const baseGates = {
  cliProbeFn: () => ({ ok: true, version: '2.1.231', minimumVersion: '2.1.208' }),
  authProbeFn: () => ({ ok: true, authMethod: 'claude.ai', providerClass: 'first-party' }),
  quotaPreflightFn: async () => ({ allowed: true, reason: null, sessionUsedPercent: 0, weeklyUsedPercent: 16, threshold: 75 }),
  cachePolicyFn: () => ({ enabled: true, state: 'enabled' }),
  acquireSlotFn: () => ({ held: true, release() {} }),
};

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

test('canary argv pins dontAsk / sonnet / low / empty setting sources without resume', () => {
  const args = buildClaudeWorkerCanaryArgs({ branch: 'canary/claude-398-z790-test', env: { HOME: '/h', PATH: '/usr/bin' } });
  assert.ok(args.includes('-p'));
  assert.equal(args.includes('--resume'), false);
  const pmIndex = args.indexOf('--permission-mode');
  assert.equal(args[pmIndex + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  const ssIndex = args.indexOf('--setting-sources');
  assert.ok(ssIndex > 0);
  assert.equal(args[ssIndex + 1], '');
  assert.ok(args.includes('--exclude-dynamic-system-prompt-sections'));
  assert.ok(args.includes('--strict-mcp-config'));
});

test('first-party auth inspector proves login via bounded claude auth status --json', () => {
  const statusFn = (payload) => () => JSON.stringify(payload);

  // Inherited provider API key.
  assert.equal(inspectClaudeWorkerFirstPartyAuth({
    env: { HOME: '/home/worker', ANTHROPIC_API_KEY: 'nope' },
    execFileSyncFn: statusFn({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
  }).reason, 'claude-provider-auth-inheritance-forbidden');

  // Inherited first-party OAuth token.
  assert.equal(inspectClaudeWorkerFirstPartyAuth({
    env: { HOME: '/home/worker', CLAUDE_CODE_OAUTH_TOKEN: 'inherited' },
    execFileSyncFn: statusFn({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
  }).reason, 'claude-provider-auth-inheritance-forbidden');

  // Logged out.
  assert.equal(inspectClaudeWorkerFirstPartyAuth({
    env: { HOME: '/home/worker' },
    execFileSyncFn: statusFn({ loggedIn: false }),
  }).reason, 'claude-worker-logged-out');

  // Malformed JSON.
  assert.equal(inspectClaudeWorkerFirstPartyAuth({
    env: { HOME: '/home/worker' },
    execFileSyncFn: () => 'not json',
  }).reason, 'claude-auth-status-unparsed');

  // Wrong auth method.
  assert.equal(inspectClaudeWorkerFirstPartyAuth({
    env: { HOME: '/home/worker' },
    execFileSyncFn: statusFn({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' }),
  }).reason, 'claude-worker-auth-method-unexpected');

  // Wrong provider.
  assert.equal(inspectClaudeWorkerFirstPartyAuth({
    env: { HOME: '/home/worker' },
    execFileSyncFn: statusFn({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }),
  }).reason, 'claude-worker-auth-provider-unexpected');

  // Successful first-party status; token is stripped from the status subprocess env.
  let seenEnv = null;
  const ok = inspectClaudeWorkerFirstPartyAuth({
    env: { HOME: '/home/worker' },
    childEnv: { HOME: '/stale', CLAUDE_CODE_OAUTH_TOKEN: 'leak', PATH: '/usr/bin' },
    execFileSyncFn: (_bin, _args, opts) => {
      seenEnv = opts.env;
      return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.authMethod, 'claude.ai');
  assert.equal(ok.providerClass, 'first-party');
  assert.equal(Object.prototype.hasOwnProperty.call(seenEnv, 'CLAUDE_CODE_OAUTH_TOKEN'), false);
});

test('quota preflight parses fresh usage and admits narrow below 75 percent', () => {
  const usage = [
    'Current session: 12% used · resets 3pm',
    'Current week (all models): 16% used · resets Monday',
  ].join('\n');
  const result = runClaudeWorkerQuotaPreflight({
    claudePath: '/usr/bin/claude',
    childEnv: {},
    env: {},
    execFileSyncFn: () => usage,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.sessionUsedPercent, 12);
  assert.equal(result.weeklyUsedPercent, 16);

  const over = runClaudeWorkerQuotaPreflight({
    claudePath: '/usr/bin/claude',
    childEnv: {},
    env: {},
    execFileSyncFn: () => 'Current session: 80% used · resets 3pm',
  });
  assert.equal(over.allowed, false);
});

test('workspace validator accepts only the exact one-file mutation with unchanged HEAD', () => {
  const { root, baseSha } = createRepository();
  try {
    writeFileSync(join(root, CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE), CLAUDE_WORKER_QUALIFICATION_EXPECTED_CONTENT);
    assert.equal(validateClaudeWorkerCanaryWorkspace({ cwd: root, baseSha }).ok, true);
    writeFileSync(join(root, 'README.md'), 'unexpected\n');
    assert.equal(validateClaudeWorkerCanaryWorkspace({ cwd: root, baseSha }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executor completes one bounded canary, strips provider auth env, cleans workspace, and replays without a second provider call', async () => {
  const source = createRepository();
  const reg = registry();
  const built = request(reg, source.baseSha);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-claude-worker-root-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-runner-claude-worker-state-'));
  const captured = {};
  let invocations = 0;

  try {
    const execution = await executeClaudeWorkerQualificationRequest({
      request: built,
      registry: reg,
      executingNodeId: 'dev-cluster-z790',
      sourceRepositoryPath: source.root,
      worktreeRoot,
      stateRoot,
      claudePath: '/usr/bin/claude',
      env: {
        HOME: '/home/test',
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: 'must-not-cross',
        ANTHROPIC_AUTH_TOKEN: 'must-not-cross',
        CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross',
      },
      clock: clockSequence('2026-08-27T06:30:00.000Z', '2026-08-27T06:31:00.000Z'),
      ...baseGates,
      acquireSlotFn: ({ env: slotEnv }) => {
        captured.lane = slotEnv.AGENT_RUNNER_IMPLEMENTATION_LANE;
        return { held: true, release() { captured.slotReleases = (captured.slotReleases || 0) + 1; } };
      },
      invokeCanaryFn: ({ cwd, childEnv }) => {
        invocations += 1;
        captured.childEnv = childEnv;
        writeFileSync(join(cwd, CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE), CLAUDE_WORKER_QUALIFICATION_EXPECTED_CONTENT);
        return { ok: true, reason: null, sentinelObserved: true, hasSessionId: false };
      },
    });

    assert.equal(execution.replay, false);
    assert.equal(execution.providerInvoked, true);
    assert.equal(invocations, 1);
    assert.equal(captured.childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(captured.childEnv.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(captured.childEnv, 'CLAUDE_CODE_OAUTH_TOKEN'), false);
    assert.equal(captured.lane, built.lease.laneId);
    assert.equal(captured.slotReleases, 1);
    assert.equal(execution.result.status, 'succeeded');

    const acceptance = acceptClaudeWorkerQualificationResult({
      request: built,
      result: execution.result,
      registry: reg,
      now: new Date('2026-08-27T06:32:00.000Z'),
    });
    assert.equal(acceptance.accepted, true);
    assert.equal(acceptance.qualified, true);
    assert.equal(acceptance.evidence.permissionMode, 'dontAsk');
    assert.equal(acceptance.evidence.settingSourcesEmpty, true);
    assert.equal(acceptance.evidence.parserFilesystemAgree, true);

    assert.equal(git(source.root, ['status', '--porcelain']), '');
    assert.equal(git(source.root, ['branch', '--list', built.lease.branch]), '');

    const statePath = claudeWorkerQualificationStatePath({ stateRoot, jobFingerprint: built.job.jobFingerprint });
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).status, 'completed');

    const replay = await executeClaudeWorkerQualificationRequest({
      request: built,
      registry: reg,
      executingNodeId: 'dev-cluster-z790',
      sourceRepositoryPath: source.root,
      worktreeRoot,
      stateRoot,
      clock: () => new Date('2026-08-27T06:33:00.000Z'),
      cliProbeFn: () => { throw new Error('replay must not reprobe provider'); },
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

for (const scenario of [
  { name: 'unauthenticated', gate: { authProbeFn: () => ({ ok: false, reason: 'claude-worker-logged-out' }) }, match: /claude-worker-logged-out/ },
  { name: 'quota over threshold', gate: { quotaPreflightFn: async () => ({ allowed: false, reason: 'profile-session-usage-threshold-exceeded' }) }, match: /profile-session-usage-threshold-exceeded/ },
  { name: 'cache disabled', gate: { cachePolicyFn: () => ({ enabled: false }) }, match: /claude-prompt-cache-disabled/ },
  { name: 'cli version', gate: { cliProbeFn: () => ({ ok: false, reason: 'claude-version-too-old' }) }, match: /claude-version-too-old/ },
  { name: 'lane', gate: { acquireSlotFn: () => ({ held: false, failureReason: 'implementation-slot-unavailable', release() {} }) }, match: /implementation-slot-unavailable/ },
]) {
  test(`${scenario.name} refusal happens before worktree/state/provider invocation`, async () => {
    const source = createRepository();
    const reg = registry();
    const built = request(reg, source.baseSha);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-claude-worker-root-'));
    const stateRoot = mkdtempSync(join(tmpdir(), 'agent-runner-claude-worker-state-'));
    let invoked = false;
    try {
      await assert.rejects(() => executeClaudeWorkerQualificationRequest({
        request: built,
        registry: reg,
        executingNodeId: 'dev-cluster-z790',
        sourceRepositoryPath: source.root,
        worktreeRoot,
        stateRoot,
        clock: () => new Date('2026-08-27T06:30:00.000Z'),
        ...baseGates,
        ...scenario.gate,
        invokeCanaryFn: () => { invoked = true; return { ok: true, sentinelObserved: true }; },
      }), scenario.match);
      assert.equal(invoked, false);
      assert.equal(git(source.root, ['branch', '--list', built.lease.branch]), '');
      assert.equal(existsSync(claudeWorkerQualificationStatePath({ stateRoot, jobFingerprint: built.job.jobFingerprint })), false);
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(source.root, { recursive: true, force: true });
    }
  });
}

test('parser/filesystem disagreement is refused and consumes the one-use authority once', async () => {
  const source = createRepository();
  const reg = registry();
  const built = request(reg, source.baseSha);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-claude-worker-root-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-runner-claude-worker-state-'));
  try {
    const execution = await executeClaudeWorkerQualificationRequest({
      request: built,
      registry: reg,
      executingNodeId: 'dev-cluster-z790',
      sourceRepositoryPath: source.root,
      worktreeRoot,
      stateRoot,
      clock: clockSequence('2026-08-27T06:30:00.000Z', '2026-08-27T06:31:00.000Z'),
      ...baseGates,
      invokeCanaryFn: () => ({ ok: true, reason: null, sentinelObserved: true, hasSessionId: false }),
    });
    assert.equal(execution.providerInvoked, true);
    assert.equal(execution.result.status, 'failed');
    const state = JSON.parse(readFileSync(claudeWorkerQualificationStatePath({ stateRoot, jobFingerprint: built.job.jobFingerprint }), 'utf8'));
    assert.equal(state.status, 'failed');
    assert.equal(state.reason, 'claude-parser-filesystem-disagreement');
    assert.notEqual(git(source.root, ['branch', '--list', built.lease.branch]), '');
  } finally {
    cleanupPreservedWorktree(source.root, built.lease.branch);
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(source.root, { recursive: true, force: true });
  }
});

test('provider failure consumes authority once and preserves clean forensic worktree/branch', async () => {
  const source = createRepository();
  const reg = registry();
  const built = request(reg, source.baseSha);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agent-runner-claude-worker-root-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'agent-runner-claude-worker-state-'));
  try {
    const execution = await executeClaudeWorkerQualificationRequest({
      request: built,
      registry: reg,
      executingNodeId: 'dev-cluster-z790',
      sourceRepositoryPath: source.root,
      worktreeRoot,
      stateRoot,
      clock: clockSequence('2026-08-27T06:30:00.000Z', '2026-08-27T06:31:00.000Z'),
      ...baseGates,
      invokeCanaryFn: () => ({ ok: false, reason: 'claude-canary-sentinel-absent', sentinelObserved: false }),
    });
    assert.equal(execution.providerInvoked, true);
    assert.equal(execution.result.status, 'failed');
    const state = JSON.parse(readFileSync(claudeWorkerQualificationStatePath({ stateRoot, jobFingerprint: built.job.jobFingerprint }), 'utf8'));
    assert.equal(state.status, 'failed');
    assert.equal(state.providerInvoked, true);
    assert.match(git(source.root, ['worktree', 'list', '--porcelain']), new RegExp(`branch refs/heads/${built.lease.branch}`));
  } finally {
    cleanupPreservedWorktree(source.root, built.lease.branch);
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(source.root, { recursive: true, force: true });
  }
});
