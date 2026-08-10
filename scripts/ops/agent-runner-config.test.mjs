import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG,
  loadAgentRunnerConfig,
  PROJECT_SCOPED_ENV_FIELDS,
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

// Shared runner.env must never redirect a different project's identity. A same-project canonical
// override ($HOME/.local/state/agent-runner/<projectId>) is legitimate for path fields only; identity fields require exact agreement.
const SCOPED_ENV_BASE = { envVarName: 'CLAUDE_RUNNER_OUTPUT_DIR', configFieldName: 'outputDir' };
const IDENTITY_ENV_BASE = { envVarName: 'GITHUB_REPOSITORY', configFieldName: 'githubRepo', fieldKind: 'identity' };
const HOME = { HOME: '/home/gp' };

for (const [name, overrides, expected] of [
  ['passes through an unset env value',
    { envValue: undefined, configValue: '.var/agent-runner', configPath: '/cfg/agent-runner.json', projectId: 'agent-runner' },
    '.var/agent-runner'],
  ['preserves the legacy default-config env override when no project config is explicitly selected',
    { envValue: '/home/gp/.local/state/agent-runner/modelspend', configValue: '.var/claude-runner', configPath: null, projectId: 'modelspend' },
    '/home/gp/.local/state/agent-runner/modelspend'],
  ['accepts an env value that agrees with the selected project config',
    { envValue: '/home/gp/.local/state/agent-runner/modelspend', configValue: '/home/gp/.local/state/agent-runner/modelspend', configPath: '/cfg/modelspend.json', projectId: 'modelspend' },
    '/home/gp/.local/state/agent-runner/modelspend'],
  ['accepts a same-project canonical override of the project\'s own relative default',
    { envValue: '/home/gp/.local/state/agent-runner/modelspend', configValue: '.var/claude-runner', configPath: '/cfg/modelspend.json', projectId: 'modelspend', env: HOME },
    '/home/gp/.local/state/agent-runner/modelspend'],
  ['identity fields accept only exact agreement with the project config',
    { ...IDENTITY_ENV_BASE, envValue: 'TheTekTeam/modelspend', configValue: 'TheTekTeam/modelspend', configPath: '/cfg/modelspend.json', projectId: 'modelspend' },
    'TheTekTeam/modelspend'],
]) {
  test(`resolveProjectScopedEnvValue ${name}`, () => {
    assert.equal(resolveProjectScopedEnvValue({ ...SCOPED_ENV_BASE, ...overrides }), expected);
  });
}

for (const [name, overrides, pattern] of [
  ['fails closed when a shared env value disagrees with the explicitly selected project config (#44 reproduction)',
    { envValue: '/home/gp/.local/state/agent-runner/modelspend', configValue: '.var/agent-runner', configPath: '/cfg/agent-runner.json', projectId: 'agent-runner' },
    /CLAUDE_RUNNER_OUTPUT_DIR.*disagrees with project "agent-runner".*outputDir.*refusing to let shared machine environment redirect this project's identity/],
  ['rejects a path that merely contains matching segments outside the project\'s own canonical state root',
    { envValue: '/tmp/untrusted/agent-runner/modelspend/anything', configValue: '.var/claude-runner', configPath: '/cfg/modelspend.json', projectId: 'modelspend', env: HOME },
    /CLAUDE_RUNNER_OUTPUT_DIR.*disagrees with project "modelspend"/],
  ['identity fields reject a value that merely looks like the project\'s canonical state-root path',
    { ...IDENTITY_ENV_BASE, envValue: '/home/gp/.local/state/agent-runner/modelspend', configValue: 'TheTekTeam/modelspend', configPath: '/cfg/modelspend.json', projectId: 'modelspend', env: HOME },
    /GITHUB_REPOSITORY.*disagrees with project "modelspend".*githubRepo.*refusing to let shared machine environment redirect this project's identity/],
  ['identity fields fail closed on a differing repo even for the selected project',
    { ...IDENTITY_ENV_BASE, envValue: 'TheTekTeam/agent-runner', configValue: 'TheTekTeam/modelspend', configPath: '/cfg/modelspend.json', projectId: 'modelspend' },
    /GITHUB_REPOSITORY.*disagrees with project "modelspend"/],
]) {
  test(`resolveProjectScopedEnvValue ${name}`, () => {
    assert.throws(() => resolveProjectScopedEnvValue({ ...SCOPED_ENV_BASE, ...overrides }), pattern);
  });
}

// A project id equal to the shared `agent-runner` namespace folder must not be confused with it.
test('resolveProjectScopedEnvValue same-project convention match is unconfused when the selected project id equals the shared namespace folder name', () => {
  const base = { envVarName: 'CLAUDE_RUNNER_STATE_DB', configFieldName: 'stateDbPath', configValue: '.var/agent-runner/runner-state.sqlite', configPath: '/cfg/agent-runner.json', projectId: 'agent-runner', env: HOME };
  assert.equal(
    resolveProjectScopedEnvValue({ ...base, envValue: '/home/gp/.local/state/agent-runner/agent-runner/runner-state.sqlite' }),
    '/home/gp/.local/state/agent-runner/agent-runner/runner-state.sqlite',
  );
  assert.throws(
    () => resolveProjectScopedEnvValue({ ...base, envValue: '/home/gp/.local/state/agent-runner/modelspend/runner-state.sqlite' }),
    /CLAUDE_RUNNER_STATE_DB.*disagrees with project "agent-runner"/,
  );
});

test('PROJECT_SCOPED_ENV_FIELDS marks GITHUB_REPOSITORY as an identity field and the path env vars as path fields', () => {
  const byName = Object.fromEntries(PROJECT_SCOPED_ENV_FIELDS.map((field) => [field.envVarName, field.fieldKind]));
  assert.equal(byName.GITHUB_REPOSITORY, 'identity');
  assert.equal(byName.CLAUDE_RUNNER_OUTPUT_DIR, 'path');
  assert.equal(byName.CLAUDE_RUNNER_STATE_DB, 'path');
  assert.equal(byName.CLAUDE_RUNNER_CRON_LOCK, 'path');
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
