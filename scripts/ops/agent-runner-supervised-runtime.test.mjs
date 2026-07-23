import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { main as supervisedCanaryMain } from './agent-runner-supervised-canary.mjs';
import {
  applySupervisedCanaryRuntime,
  parseRunnerEnvFile,
  resolveSupervisedCanaryRuntime,
} from './agent-runner-supervised-runtime.mjs';

const PREFLIGHT = 'github-comment:database:5058971273';

function config(localRepoPath, stateDbPath = '.var/claude-runner/runner-state.sqlite') {
  return {
    projectId: 'modelspend',
    displayName: 'ModelSpend',
    githubRepo: 'TheTekTeam/modelspend',
    localRepoPath,
    outputDir: '.var/claude-runner',
    stateDbPath,
    acceptedAgentLabels: ['agent:claude-code-cli'],
    statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress' },
    priorityLabelRanking: ['priority:P0'],
    safeDefaultValidationCommands: [],
    systemd: {
      serviceName: 'agent-runner-modelspend.service',
      timerName: 'agent-runner-modelspend.timer',
    },
    runner: {
      lockPath: '.var/claude-runner/cron.lock',
      candidateLimit: 100,
      requireManagerPreflight: true,
      autoProceedFromPreflight: true,
    },
  };
}

function spawnSequence(results) {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const result = results.shift();
      if (!result) throw new Error('unexpected spawn');
      return result;
    },
  };
}

test('restricted env parser never evaluates shell syntax', () => {
  const parsed = parseRunnerEnvFile([
    '# comment',
    'export CLAUDE_RUNNER_STATE_DB="/safe/state.sqlite"',
    "QUOTED='literal value'",
    'SUBSTITUTION=$(touch /tmp/must-not-run)',
    'invalid line',
  ].join('\n'));
  assert.deepEqual(parsed, {
    CLAUDE_RUNNER_STATE_DB: '/safe/state.sqlite',
    QUOTED: 'literal value',
    SUBSTITUTION: '$(touch /tmp/must-not-run)',
  });
});

test('default wrapper paths load the machine env and select its XDG state database', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-runtime-'));
  try {
    const home = join(root, 'home');
    const configDir = join(home, '.config/agent-runner');
    const projectDir = join(root, 'modelspend');
    const stateDbPath = join(home, '.local/state/agent-runner/modelspend/runner-state.sqlite');
    const outputDir = join(home, '.local/state/agent-runner/modelspend');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(configDir, 'modelspend.json'), JSON.stringify(config(projectDir)));
    writeFileSync(join(configDir, 'runner.env'), [
      `CLAUDE_RUNNER_STATE_DB=${stateDbPath}`,
      `CLAUDE_RUNNER_OUTPUT_DIR=${outputDir}`,
      'AGENT_RUNNER_CONFIG=/must/not/replace/the/selected/config.json',
    ].join('\n'));

    const runtime = resolveSupervisedCanaryRuntime({ HOME: home });
    assert.equal(runtime.configPath, join(configDir, 'modelspend.json'));
    assert.equal(runtime.envFilePath, join(configDir, 'runner.env'));
    assert.equal(runtime.envFileLoaded, true);
    assert.equal(runtime.stateDbPath, stateDbPath);
    assert.equal(runtime.outputDir, outputDir);
    assert.equal(runtime.config.stateDbPath, stateDbPath);
    assert.equal(runtime.env.AGENT_RUNNER_CONFIG, join(configDir, 'modelspend.json'));
    assert.equal(runtime.env.CLAUDE_RUNNER_CONFIG, join(configDir, 'modelspend.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('relative scheduler paths are resolved from the configured project checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-relative-runtime-'));
  try {
    const home = join(root, 'home');
    const configDir = join(home, '.config/agent-runner');
    const projectDir = join(root, 'modelspend');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(configDir, 'modelspend.json'), JSON.stringify(config(projectDir, '.state/runner.sqlite')));

    const runtime = resolveSupervisedCanaryRuntime({ HOME: home });
    assert.equal(runtime.stateDbPath, resolve(projectDir, '.state/runner.sqlite'));
    assert.equal(runtime.outputDir, resolve(projectDir, '.var/claude-runner'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolved runtime replaces a stale observer config database', () => {
  const runtime = {
    env: { AGENT_RUNNER_CONFIG: '/config/modelspend.json' },
    config: { stateDbPath: '/xdg/runner-state.sqlite', outputDir: '/xdg' },
    stateDbPath: '/xdg/runner-state.sqlite',
    outputDir: '/xdg',
  };
  const applied = applySupervisedCanaryRuntime(runtime, {
    config: { stateDbPath: '/checkout/.var/runner-state.sqlite', outputDir: '/checkout/.var' },
  });
  assert.equal(applied.config.stateDbPath, '/xdg/runner-state.sqlite');
  assert.equal(applied.config.outputDir, '/xdg');
});

test('public canary entrypoint uses one resolved runtime for probes, execution and evidence', () => {
  const runtime = {
    env: {
      HOME: '/home/gp',
      AGENT_RUNNER_CONFIG: '/home/gp/.config/agent-runner/modelspend.json',
      CLAUDE_RUNNER_CONFIG: '/home/gp/.config/agent-runner/modelspend.json',
      CLAUDE_RUNNER_STATE_DB: '/home/gp/.local/state/agent-runner/modelspend/runner-state.sqlite',
    },
    config: {
      stateDbPath: '/home/gp/.local/state/agent-runner/modelspend/runner-state.sqlite',
      outputDir: '/home/gp/.local/state/agent-runner/modelspend',
    },
    configPath: '/home/gp/.config/agent-runner/modelspend.json',
    envFilePath: '/home/gp/.config/agent-runner/runner.env',
    envFileLoaded: true,
    stateDbPath: '/home/gp/.local/state/agent-runner/modelspend/runner-state.sqlite',
    outputDir: '/home/gp/.local/state/agent-runner/modelspend',
    workingDirectory: '/home/gp/projects/modelspend',
  };
  const { spawn, calls } = spawnSequence([
    { status: 3, stdout: '', stderr: '' },
    { status: 0, stdout: JSON.stringify({ selectedIssue: 686 }), stderr: '' },
    {
      status: 0,
      stdout: JSON.stringify({
        admission: { allowed: true },
        current: { issueNumber: 686, preflightRevision: PREFLIGHT },
      }),
      stderr: '',
    },
    { status: 0, stdout: '', stderr: '' },
    { status: 3, stdout: '', stderr: '' },
  ]);
  const writes = [];
  const originalLog = console.log;
  console.log = (value) => writes.push(String(value));
  try {
    const exitCode = supervisedCanaryMain([
      '--issue', '686',
      '--source-preflight-comment', PREFLIGHT,
      '--execute',
    ], {}, {
      runtime,
      spawn,
      temporaryDir: '/tmp/fixed-supervised-runtime-test',
      readWrapperResult: () => ({ state: 'canonical_runner_invoked' }),
      inspectEvidence: () => ({
        state: 'terminal_success',
        claimPersisted: true,
        attemptPersisted: true,
        workerStarted: true,
        terminalSucceeded: true,
        terminalFailed: false,
        claimId: 1,
        attemptId: 'attempt-1',
        runResultId: 2,
      }),
    });
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }

  for (const call of calls.slice(1, 4)) {
    assert.equal(call.options.env.AGENT_RUNNER_CONFIG, runtime.configPath);
    assert.equal(call.options.env.CLAUDE_RUNNER_STATE_DB, runtime.stateDbPath);
  }
  const payload = JSON.parse(writes.at(-1));
  assert.equal(payload.state, 'terminal_success');
  assert.equal(payload.runtimeResolution.stateDbPath, runtime.stateDbPath);
  assert.equal(payload.runtimeResolution.configPath, runtime.configPath);
});
