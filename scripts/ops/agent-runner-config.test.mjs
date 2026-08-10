import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG,
  loadAgentRunnerConfig,
  resolveConfigPath,
  resolveProjectScopedEnvValue,
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

// #169: reproduces the observed #44 boundary -- a shared machine-local
// runner.env carrying ModelSpend's canonical output/state paths must never
// silently override a different, explicitly selected project's identity.
test('resolveProjectScopedEnvValue passes through an unset env value', () => {
  assert.equal(
    resolveProjectScopedEnvValue({
      envValue: undefined,
      configValue: '.var/agent-runner',
      configPath: '/home/gp/.config/agent-runner/agent-runner.json',
      envVarName: 'CLAUDE_RUNNER_OUTPUT_DIR',
      configFieldName: 'outputDir',
      projectId: 'agent-runner',
    }),
    '.var/agent-runner',
  );
});

test('resolveProjectScopedEnvValue preserves the legacy default-config env override when no project config is explicitly selected', () => {
  assert.equal(
    resolveProjectScopedEnvValue({
      envValue: '/home/gp/.local/state/agent-runner/modelspend',
      configValue: '.var/claude-runner',
      configPath: null,
      envVarName: 'CLAUDE_RUNNER_OUTPUT_DIR',
      configFieldName: 'outputDir',
      projectId: 'modelspend',
    }),
    '/home/gp/.local/state/agent-runner/modelspend',
  );
});

test('resolveProjectScopedEnvValue accepts an env value that agrees with the selected project config', () => {
  assert.equal(
    resolveProjectScopedEnvValue({
      envValue: '/home/gp/.local/state/agent-runner/modelspend',
      configValue: '/home/gp/.local/state/agent-runner/modelspend',
      configPath: '/home/gp/.config/agent-runner/modelspend.json',
      envVarName: 'CLAUDE_RUNNER_OUTPUT_DIR',
      configFieldName: 'outputDir',
      projectId: 'modelspend',
    }),
    '/home/gp/.local/state/agent-runner/modelspend',
  );
});

test('resolveProjectScopedEnvValue fails closed when a shared env value disagrees with the explicitly selected project config (#44 reproduction)', () => {
  assert.throws(
    () => resolveProjectScopedEnvValue({
      envValue: '/home/gp/.local/state/agent-runner/modelspend',
      configValue: '.var/agent-runner',
      configPath: '/home/gp/.config/agent-runner/agent-runner.json',
      envVarName: 'CLAUDE_RUNNER_OUTPUT_DIR',
      configFieldName: 'outputDir',
      projectId: 'agent-runner',
    }),
    /CLAUDE_RUNNER_OUTPUT_DIR.*disagrees with project "agent-runner".*outputDir.*refusing to let shared machine environment redirect this project's identity/,
  );
});

// #169 regression item C: a project's own relative config default (e.g.
// `.var/claude-runner`) resolved by shared machine env into that same
// project's documented canonical `.../agent-runner/<projectId>` location
// (docs/MIGRATION.md) is a legitimate same-project override, not a
// cross-project redirect, even though it disagrees textually with the raw
// config field.
test('resolveProjectScopedEnvValue accepts an env value that resolves the selected project\'s own relative default into its documented canonical machine-local location', () => {
  assert.equal(
    resolveProjectScopedEnvValue({
      envValue: '/home/gp/.local/state/agent-runner/modelspend',
      configValue: '.var/claude-runner',
      configPath: '/home/gp/.config/agent-runner/modelspend.json',
      envVarName: 'CLAUDE_RUNNER_OUTPUT_DIR',
      configFieldName: 'outputDir',
      projectId: 'modelspend',
    }),
    '/home/gp/.local/state/agent-runner/modelspend',
  );
});

// A project whose own id happens to equal the shared `agent-runner`
// namespace folder name (this repository's own self-hosted project) must
// not confuse "is this the tool's namespace folder" with "is this the
// selected project's own id segment" -- the same-project override still
// resolves correctly, and a differently-named project's path is still
// rejected.
test('resolveProjectScopedEnvValue same-project convention match is unconfused when the selected project id equals the shared namespace folder name', () => {
  assert.equal(
    resolveProjectScopedEnvValue({
      envValue: '/home/gp/.local/state/agent-runner/agent-runner/runner-state.sqlite',
      configValue: '.var/agent-runner/runner-state.sqlite',
      configPath: '/home/gp/.config/agent-runner/agent-runner.json',
      envVarName: 'CLAUDE_RUNNER_STATE_DB',
      configFieldName: 'stateDbPath',
      projectId: 'agent-runner',
    }),
    '/home/gp/.local/state/agent-runner/agent-runner/runner-state.sqlite',
  );
  assert.throws(
    () => resolveProjectScopedEnvValue({
      envValue: '/home/gp/.local/state/agent-runner/modelspend/runner-state.sqlite',
      configValue: '.var/agent-runner/runner-state.sqlite',
      configPath: '/home/gp/.config/agent-runner/agent-runner.json',
      envVarName: 'CLAUDE_RUNNER_STATE_DB',
      configFieldName: 'stateDbPath',
      projectId: 'agent-runner',
    }),
    /CLAUDE_RUNNER_STATE_DB.*disagrees with project "agent-runner"/,
  );
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
