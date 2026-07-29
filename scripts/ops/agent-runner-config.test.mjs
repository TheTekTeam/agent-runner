import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG,
  loadAgentRunnerConfig,
  resolveConfigPath,
  stripConfigArgs,
  validateAgentRunnerConfig,
} from './agent-runner-config.mjs';

function withTempConfig(payload, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-config-'));
  const configPath = join(dir, 'config.json');
  try {
    writeFileSync(configPath, JSON.stringify(payload, null, 2));
    return fn(configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const validConfig = {
  projectId: 'example',
  displayName: 'Example Project',
  githubRepo: 'owner/repo',
  localRepoPath: '/srv/example',
  outputDir: '.var/agent-runner',
  stateDbPath: '.var/agent-runner/state.sqlite',
  acceptedAgentLabels: ['agent:claude'],
  statusLabels: { ready: 'status:ready', inProgress: 'status:in-progress', blocked: 'status:blocked', done: 'status:done' },
  priorityLabelRanking: ['priority:P0', 'priority:P1'],
  safeDefaultValidationCommands: ['npm test'],
  systemd: { serviceName: 'example-agent-runner.service', timerName: 'example-agent-runner.timer' },
};

test('loadAgentRunnerConfig returns default ModelSpend config without an explicit path', () => {
  const config = loadAgentRunnerConfig({ argv: [], env: {} });
  assert.equal(config.projectId, 'modelspend');
  assert.equal(config.githubRepo, 'TheTekTeam/modelspend');
  assert.equal(config.outputDir, '.var/claude-runner');
  assert.deepEqual(config.acceptedAgentLabels, ['agent:claude', 'agent:claude-code-cli']);
  assert.equal(config.queueTriage.enabled, false);
  assert.equal(config.queueTriage.maxMutations, 3);
});

test('loadAgentRunnerConfig accepts an explicit config path from CLI or env', () => withTempConfig(validConfig, (configPath) => {
  assert.equal(resolveConfigPath(['--config', configPath], {}), configPath);
  assert.equal(resolveConfigPath([], { AGENT_RUNNER_CONFIG: configPath }), configPath);
  assert.deepEqual(stripConfigArgs(['--config', configPath, '--limit', '5']), ['--limit', '5']);
  assert.equal(loadAgentRunnerConfig({ argv: ['--config', configPath], env: {} }).githubRepo, 'owner/repo');
}));

test('validateAgentRunnerConfig reports actionable invalid config errors without config contents', () => {
  assert.throws(
    () => validateAgentRunnerConfig({ projectId: 'bad' }),
    /Invalid agent runner config: .*displayName is required.*githubRepo is required as owner\/repo.*stateDbPath is required/,
  );
});

test('validateAgentRunnerConfig fills missing optional runner fields from safe defaults', () => {
  const config = validateAgentRunnerConfig(validConfig);
  assert.equal(config.runner.candidateLimit, DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.runner.candidateLimit);
  assert.equal(Object.hasOwn(config.runner, 'requireManagerPreflight'), false);
  assert.equal(Object.hasOwn(config.runner, 'autoProceedFromPreflight'), false);
  assert.equal(config.queueTriage.enabled, false);
});

test('queue triage policy may tighten but cannot widen core limits or invent labels', () => {
  const tightened = validateAgentRunnerConfig({
    ...validConfig,
    queueTriage: {
      enabled: true,
      maxChangedItems: 5,
      rotatingBacklogSlice: 1,
      maxDebuggerAnomalies: 2,
      maxMutations: 1,
      fallbackIntervalMinutes: 120,
      acceptedStatusLabels: ['status:ready', 'status:blocked'],
      priorityLabels: ['priority:P0'],
    },
  });
  assert.equal(tightened.queueTriage.enabled, true);
  assert.equal(tightened.queueTriage.maxMutations, 1);
  assert.throws(() => validateAgentRunnerConfig({ ...validConfig, queueTriage: { maxMutations: 4 } }), /maxMutations/);
  assert.throws(() => validateAgentRunnerConfig({
    ...validConfig,
    queueTriage: { acceptedStatusLabels: ['status:unknown'] },
  }), /subset of configured status labels/);
});

test('loadAgentRunnerConfig supports the existing scaffold config shape', () => withTempConfig({
  projectName: 'legacy-shape',
  repo: 'owner/legacy',
  localRepoPath: '/srv/legacy',
  runner: {
    outputDir: '.var/legacy-runner',
    stateDbPath: '.var/legacy-runner/state.sqlite',
    serviceName: 'legacy.service',
    timerName: 'legacy.timer',
  },
  github: {
    statusReadyLabel: 'ready',
    statusInProgressLabel: 'active',
    agentLabels: ['agent:legacy'],
    priorityLabels: ['P0'],
  },
  safeDefaultValidationCommands: ['npm test'],
}, (configPath) => {
  const config = loadAgentRunnerConfig({ argv: [`--config=${configPath}`], env: {} });
  assert.equal(config.projectId, 'legacy-shape');
  assert.equal(config.githubRepo, 'owner/legacy');
  assert.equal(config.statusLabels.ready, 'ready');
  assert.equal(config.queueTriage.enabled, false);
}));
