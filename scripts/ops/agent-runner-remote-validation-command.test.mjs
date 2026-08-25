import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const commandPath = join(here, 'agent-runner-remote-validation-command.mjs');
const AUTHORITY = `sha256:${'a'.repeat(64)}`;
const SENSITIVE_HOME = '/sensitive-machine-home';

function rawRegistry() {
  return {
    controllerNodeId: 'dev-cluster-dell',
    revision: 'remote-validation-command-fixture-1',
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
        toolchains: ['node22'],
        jobClasses: ['validation', 'build', 'test'],
        capacity: { maxConcurrent: 2, available: 2 },
        healthRevision: 'z790-1',
      },
    ],
    agentInstances: [],
  };
}

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function run(mode, input, env) {
  return spawnSync(process.execPath, [commandPath, mode], {
    input: `${JSON.stringify(input)}\n`,
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test('build/execute/accept command path is bounded, credential/HOME-isolated and replayable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-remote-validation-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const worktrees = join(root, 'worktrees');
  const state = join(root, 'state');
  mkdirSync(source, { recursive: true });
  mkdirSync(worktrees, { recursive: true });
  mkdirSync(state, { recursive: true });

  spawnSync('git', ['init', '-q', source], { encoding: 'utf8' });
  git(source, ['config', 'user.email', 'agent-runner@example.invalid']);
  git(source, ['config', 'user.name', 'Agent Runner Test']);
  git(source, ['remote', 'add', 'origin', 'https://github.com/TheTekTeam/agent-runner.git']);
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({
    name: 'remote-validation-command-fixture',
    private: true,
    scripts: {
      validate: `node -e "process.exit(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.HOME === ${JSON.stringify(SENSITIVE_HOME).replaceAll('"', '\\"')} ? 9 : 0)"`,
    },
  }, null, 2)}\n`);
  git(source, ['add', 'package.json']);
  git(source, ['commit', '-q', '-m', 'fixture']);
  const sourceSha = git(source, ['rev-parse', 'HEAD']).toLowerCase();
  const sourceTreeSha = git(source, ['rev-parse', 'HEAD^{tree}']).toLowerCase();

  const now = Date.now();
  const requestInput = {
    nodeId: 'dev-cluster-z790',
    projectId: 'agent-runner',
    repository: 'TheTekTeam/agent-runner',
    sourceSha,
    sourceTreeSha,
    profileId: 'agent-runner-canonical',
    authorityFingerprint: AUTHORITY,
    authorityRevision: 'AR199-COMMAND-FIXTURE-1',
    requestedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 20 * 60_000).toISOString(),
  };

  const baseEnv = {
    ...process.env,
    HOME: SENSITIVE_HOME,
    AGENT_RUNNER_WORKER_REGISTRY_JSON: JSON.stringify(rawRegistry()),
    AGENT_RUNNER_CONTROLLER_NODE_ID: 'dev-cluster-dell',
  };
  const built = run('build-request', requestInput, baseEnv);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const builtOutput = JSON.parse(built.stdout);
  assert.equal(builtOutput.ok, true);
  assert.equal('argv' in builtOutput.request, false);
  assert.equal('sourceRepositoryPath' in builtOutput.request, false);

  const workerEnv = {
    ...baseEnv,
    AGENT_RUNNER_NODE_ID: 'dev-cluster-z790',
    AGENT_RUNNER_REMOTE_VALIDATION_SOURCE_REPOSITORY: source,
    AGENT_RUNNER_REMOTE_VALIDATION_WORKTREE_ROOT: worktrees,
    AGENT_RUNNER_REMOTE_VALIDATION_STATE_ROOT: state,
    OPENAI_API_KEY: 'must-not-reach-validation-child',
    ANTHROPIC_API_KEY: 'must-not-reach-validation-child',
  };
  const executed = run('execute', builtOutput.request, workerEnv);
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  const executionOutput = JSON.parse(executed.stdout);
  assert.equal(executionOutput.ok, true);
  assert.equal(executionOutput.replay, false);
  assert.equal(executionOutput.result.status, 'succeeded');
  assert.equal('stdout' in executionOutput.result, false);
  assert.equal('stderr' in executionOutput.result, false);
  assert.equal('path' in executionOutput.result, false);

  const accepted = run('accept', {
    request: builtOutput.request,
    result: executionOutput.result,
  }, baseEnv);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.equal(JSON.parse(accepted.stdout).acceptance.accepted, true);

  const replayed = run('execute', builtOutput.request, workerEnv);
  assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
  const replayOutput = JSON.parse(replayed.stdout);
  assert.equal(replayOutput.replay, true);
  assert.equal(replayOutput.result.resultFingerprint, executionOutput.result.resultFingerprint);
});

test('command rejects request-side command/path injection before execution', () => {
  const env = {
    ...process.env,
    AGENT_RUNNER_WORKER_REGISTRY_JSON: JSON.stringify(rawRegistry()),
    AGENT_RUNNER_CONTROLLER_NODE_ID: 'dev-cluster-dell',
  };
  const now = Date.now();
  const result = run('build-request', {
    nodeId: 'dev-cluster-z790',
    projectId: 'agent-runner',
    repository: 'TheTekTeam/agent-runner',
    sourceSha: 'b'.repeat(40),
    sourceTreeSha: 'c'.repeat(40),
    profileId: 'agent-runner-canonical',
    authorityFingerprint: AUTHORITY,
    authorityRevision: 'AR199-INJECTION-FIXTURE-1',
    requestedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 20 * 60_000).toISOString(),
    command: 'rm -rf /',
  }, env);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    ok: false,
    errorCode: 'input-field-set-invalid',
  });
});
