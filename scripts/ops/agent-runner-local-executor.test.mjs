import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  executeLocalExecutorJob,
  LocalExecutorError,
  LocalExecutorStore,
  validateLocalExecutorJob,
} from './agent-runner-local-executor.mjs';
import {
  loadLocalExecutorPolicy,
  validateLocalExecutorPolicy,
} from './agent-runner-local-executor-policy.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';

const T0 = '2026-07-29T04:00:00.000Z';
const EXPIRES = '2026-07-29T05:00:00.000Z';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || '').trim();
}

function writeProjectConfig(path, projectId, githubRepo, localRepoPath) {
  writeFileSync(path, JSON.stringify({
    projectId,
    displayName: projectId,
    githubRepo,
    localRepoPath,
    outputDir: '.var/agent-runner',
    stateDbPath: `.var/agent-runner/${projectId}.sqlite`,
    acceptedAgentLabels: ['agent:chatgpt'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: ['node --test'],
    systemd: { serviceName: `${projectId}.service`, timerName: `${projectId}.timer` },
    runner: { lockPath: `.var/agent-runner/${projectId}.lock`, candidateLimit: 10 },
  }, null, 2));
}

function createFixtureRepository(root, owner, repoName) {
  const bare = join(root, `${repoName}.git`);
  const seed = join(root, `${repoName}-seed`);
  const canonical = join(root, `${repoName}-work`);
  run('git', ['init', '--bare', bare]);
  mkdirSync(seed);
  run('git', ['init', '-b', 'main'], { cwd: seed });
  run('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: seed });
  run('git', ['config', 'user.name', 'Fixture'], { cwd: seed });
  writeFileSync(join(seed, 'README.md'), `# ${repoName}\n`);
  run('git', ['add', 'README.md'], { cwd: seed });
  run('git', ['commit', '-m', 'Initial'], { cwd: seed });
  run('git', ['remote', 'add', 'origin', bare], { cwd: seed });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: seed });
  run('git', ['clone', '--branch', 'main', bare, canonical]);
  run('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: canonical });
  run('git', ['config', 'user.name', 'Fixture'], { cwd: canonical });
  const githubRepo = `${owner}/${repoName}`;
  const githubRemote = `git@github.com:${githubRepo}.git`;
  run('git', ['remote', 'set-url', 'origin', githubRemote], { cwd: canonical });
  return { bare, seed, canonical, githubRepo, githubRemote };
}

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-local-executor-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const nodeRepo = createFixtureRepository(root, 'Owner', 'NodeProject');
    const pythonRepo = createFixtureRepository(root, 'Owner', 'PythonProject');
    writeFileSync(join(home, '.gitconfig'), [
      `[url "file://${nodeRepo.bare}"]`,
      `\tinsteadOf = ${nodeRepo.githubRemote}`,
      `[url "file://${pythonRepo.bare}"]`,
      `\tinsteadOf = ${pythonRepo.githubRemote}`,
      '',
    ].join('\n'));

    const nodeConfig = join(root, 'node.json');
    const pythonConfig = join(root, 'python.json');
    writeProjectConfig(nodeConfig, 'node-project', nodeRepo.githubRepo, nodeRepo.canonical);
    writeProjectConfig(pythonConfig, 'python-project', pythonRepo.githubRepo, pythonRepo.canonical);
    const registryPath = join(root, 'registry.json');
    writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, projects: ['node.json', 'python.json'] }));

    const policyPath = join(root, 'executor-policy.json');
    writeFileSync(policyPath, JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          projectId: 'node-project',
          defaultBranch: 'main',
          worktreeRoot: join(root, 'worktrees', 'node-project'),
          allowedOperations: [
            'project.inspect', 'repository.fetch', 'repository.sync-default',
            'worktree.create', 'worktree.inspect', 'worktree.remove', 'validation.run',
          ],
          validationProfiles: {
            default: {
              commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 30 }],
            },
          },
        },
        {
          projectId: 'python-project',
          defaultBranch: 'main',
          worktreeRoot: join(root, 'worktrees', 'python-project'),
          allowedOperations: ['project.inspect', 'worktree.create', 'worktree.remove', 'validation.run'],
          validationProfiles: {
            default: {
              commands: [{ argv: ['python3', '-c', 'raise SystemExit(0)'], timeoutSeconds: 30 }],
            },
          },
        },
      ],
    }, null, 2));

    const registry = loadProjectRegistry({ registryPath });
    const policy = loadLocalExecutorPolicy({ policyPath });
    const store = new LocalExecutorStore(join(root, 'executor.sqlite'));
    const env = { ...process.env, HOME: home, PATH: process.env.PATH };
    const wrappedSpawn = (command, args, options) => {
      if (command === 'git' && args.slice(-3).join(' ') === 'remote get-url origin') {
        const repoPath = args[1];
        const remote = repoPath === nodeRepo.canonical ? nodeRepo.githubRemote : pythonRepo.githubRemote;
        return { status: 0, stdout: `${remote}\n`, stderr: '', signal: null };
      }
      return spawnSync(command, args, options);
    };
    const context = {
      root, home, nodeRepo, pythonRepo, registry, policy, store, env, spawn: wrappedSpawn,
    };
    try {
      return await fn(context);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let sequence = 0;
function job(projectId, operation, overrides = {}) {
  sequence += 1;
  return {
    schemaVersion: 1,
    jobId: `job-${String(sequence).padStart(8, '0')}`,
    nonce: `nonce-${String(sequence).padStart(16, '0')}`,
    projectId,
    operation,
    expiresAt: EXPIRES,
    arguments: {},
    ...overrides,
  };
}

function execute(context, input, overrides = {}) {
  return executeLocalExecutorJob({
    input,
    registry: context.registry,
    policy: context.policy,
    store: context.store,
    spawn: context.spawn,
    env: context.env,
    uid: 1000,
    now: T0,
    ...overrides,
  });
}

test('policy requires argv-only validation commands and unique project ownership', () => {
  assert.throws(() => validateLocalExecutorPolicy({ schemaVersion: 1, projects: [{
    projectId: 'bad',
    defaultBranch: 'main',
    worktreeRoot: '/tmp/bad',
    allowedOperations: ['validation.run'],
    validationProfiles: { default: { commands: [{ command: 'npm test' }] } },
  }] }), /argv must contain strings/);
  assert.throws(() => validateLocalExecutorPolicy({ schemaVersion: 1, projects: [
    {
      projectId: 'one', defaultBranch: 'main', worktreeRoot: '/tmp/shared',
      allowedOperations: ['project.inspect'],
      validationProfiles: { default: { commands: [{ argv: ['true'] }] } },
    },
    {
      projectId: 'two', defaultBranch: 'main', worktreeRoot: '/tmp/shared',
      allowedOperations: ['project.inspect'],
      validationProfiles: { default: { commands: [{ argv: ['true'] }] } },
    },
  ] }), /duplicate worktreeRoot/);
});

test('inspects a configured repository without returning raw remote credentials', () => fixture(async (context) => {
  const result = execute(context, job('node-project', 'project.inspect'));
  assert.equal(result.job.state, 'succeeded');
  assert.equal(result.job.result.repository, 'Owner/NodeProject');
  assert.equal(result.job.result.clean, true);
  assert.equal(JSON.stringify(result).includes('git@github.com'), false);
}));

test('fast-forwards a clean canonical default branch only to the expected remote SHA', () => fixture(async (context) => {
  writeFileSync(join(context.nodeRepo.seed, 'next.txt'), 'next\n');
  run('git', ['add', 'next.txt'], { cwd: context.nodeRepo.seed });
  run('git', ['commit', '-m', 'Next'], { cwd: context.nodeRepo.seed });
  run('git', ['push', 'origin', 'main'], { cwd: context.nodeRepo.seed });
  const expectedSha = run('git', ['rev-parse', 'HEAD'], { cwd: context.nodeRepo.seed });
  const result = execute(context, job('node-project', 'repository.sync-default', { expectedSha }));
  assert.equal(result.job.state, 'succeeded');
  assert.equal(result.job.result.after.headSha, expectedSha);
  assert.equal(readFileSync(join(context.nodeRepo.canonical, 'next.txt'), 'utf8'), 'next\n');

  const mismatch = execute(context, job('node-project', 'repository.sync-default', {
    expectedSha: 'f'.repeat(40),
  }));
  assert.equal(mismatch.job.state, 'failed');
  assert.equal(mismatch.job.errorCode, 'expected-sha-mismatch');
}));

test('creates exact-SHA worktrees and runs Node and Python policy profiles', () => fixture(async (context) => {
  for (const [projectId, repo, worktreeName] of [
    ['node-project', context.nodeRepo, 'node-validation'],
    ['python-project', context.pythonRepo, 'python-validation'],
  ]) {
    const expectedSha = run('git', ['rev-parse', 'HEAD'], { cwd: repo.canonical });
    const created = execute(context, job(projectId, 'worktree.create', {
      expectedSha,
      arguments: { worktreeName },
    }));
    assert.equal(created.job.state, 'succeeded');
    assert.equal(created.job.result.worktree.headSha, expectedSha);
    const validated = execute(context, job(projectId, 'validation.run', {
      expectedSha,
      arguments: { profile: 'default', worktreeName },
    }));
    assert.equal(validated.job.state, 'succeeded');
    assert.equal(validated.job.result.commands.length, 1);
    assert.equal(validated.job.result.commands[0].status, 0);
    const removed = execute(context, job(projectId, 'worktree.remove', {
      expectedSha,
      arguments: { worktreeName },
    }));
    assert.equal(removed.job.state, 'succeeded');
    assert.equal(removed.job.result.removed, true);
  }
}));

test('refuses to remove a dirty worktree', () => fixture(async (context) => {
  const expectedSha = run('git', ['rev-parse', 'HEAD'], { cwd: context.nodeRepo.canonical });
  const worktreeName = 'dirty-worktree';
  const created = execute(context, job('node-project', 'worktree.create', {
    expectedSha,
    arguments: { worktreeName },
  }));
  writeFileSync(join(created.job.result.worktree.path, 'dirty.txt'), 'dirty\n');
  const removed = execute(context, job('node-project', 'worktree.remove', {
    expectedSha,
    arguments: { worktreeName },
  }));
  assert.equal(removed.job.state, 'failed');
  assert.equal(removed.job.errorCode, 'worktree-dirty');
}));

test('replays an identical completed job but rejects job and nonce collisions', () => fixture(async (context) => {
  const request = job('node-project', 'project.inspect');
  const first = execute(context, request);
  const replay = execute(context, request);
  assert.equal(first.replay, false);
  assert.equal(replay.replay, true);
  assert.equal(replay.job.state, 'succeeded');
  assert.throws(() => execute(context, { ...request, operation: 'repository.fetch' }), /different content/);
  const nonceCollision = job('node-project', 'project.inspect', { nonce: request.nonce });
  assert.throws(() => execute(context, nonceCollision), /nonce was already used/);
}));

test('project lock prevents overlapping mutation ownership', () => fixture(async (context) => {
  const running = validateLocalExecutorJob(job('node-project', 'project.inspect'), { now: T0 });
  context.store.begin(running, { now: T0, leaseMs: 60_000 });
  assert.throws(
    () => execute(context, job('node-project', 'project.inspect')),
    (error) => error instanceof LocalExecutorError && error.code === 'project-locked',
  );
  context.store.finish(running.jobId, { state: 'failed', errorCode: 'fixture-finished', now: T0 });
}));

test('rejects root execution, expired jobs, unknown operations and unsafe worktree paths', () => fixture(async (context) => {
  assert.throws(
    () => execute(context, job('node-project', 'project.inspect'), { uid: 0 }),
    (error) => error.code === 'root-execution-forbidden',
  );
  assert.throws(
    () => validateLocalExecutorJob(job('node-project', 'project.inspect', { expiresAt: T0 }), { now: T0 }),
    (error) => error.code === 'job-expired',
  );
  const operation = execute(context, job('node-project', 'unknown.operation'));
  assert.equal(operation.job.state, 'failed');
  assert.equal(operation.job.errorCode, 'operation-not-allowed');
  const unsafe = execute(context, job('node-project', 'worktree.inspect', {
    arguments: { worktreeName: '../escape' },
  }));
  assert.equal(unsafe.job.state, 'failed');
  assert.equal(unsafe.job.errorCode, 'invalid-request');
}));
