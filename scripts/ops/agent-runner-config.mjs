import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG = Object.freeze({
  projectId: 'modelspend',
  displayName: 'ModelSpend',
  githubRepo: 'TheTekTeam/modelspend',
  localRepoPath: '/workspace/modelspend',
  outputDir: '.var/claude-runner',
  stateDbPath: '.var/claude-runner/runner-state.sqlite',
  acceptedAgentLabels: ['agent:claude', 'agent:claude-code-cli'],
  statusLabels: {
    ready: 'status:ready',
    inProgress: 'status:in-progress',
  },
  priorityLabelRanking: ['priority:P0', 'priority:P1', 'priority:P2', 'priority:P3'],
  safeDefaultValidationCommands: [
    'npm run validate:quick:plan -- --files <changed files>',
    'node --test scripts/ops/agent-runner-config.test.mjs',
  ],
  systemd: {
    serviceName: 'modelspend-claude-runner.service',
    timerName: 'modelspend-claude-runner.timer',
  },
  runner: {
    lockPath: '.var/claude-runner/cron.lock',
    candidateLimit: 100,
    requireManagerPreflight: true,
    autoProceedFromPreflight: true,
  },
});

const CONFIG_ENV = 'AGENT_RUNNER_CONFIG';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function cleanPathForError(path) {
  return path ? resolve(path) : path;
}

export function resolveConfigPath(argv = [], env = process.env) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--config requires a value');
      return value;
    }
    if (arg.startsWith('--config=')) return arg.slice('--config='.length);
  }
  return env[CONFIG_ENV] || env.CLAUDE_RUNNER_CONFIG || null;
}

export function stripConfigArgs(argv = []) {
  const stripped = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--config=')) continue;
    stripped.push(arg);
  }
  return stripped;
}

function definedEntries(object = {}) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function readConfigFile(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid agent runner config JSON at ${cleanPathForError(configPath)}: ${error.message}`);
    throw new Error(`Unable to read agent runner config at ${cleanPathForError(configPath)}: ${error.message}`);
  }
}

function normalizeLegacyShape(raw) {
  if (!isPlainObject(raw)) return raw;
  return {
    projectId: raw.projectId ?? raw.projectName,
    displayName: raw.displayName ?? raw.projectName,
    githubRepo: raw.githubRepo ?? raw.repo,
    localRepoPath: raw.localRepoPath,
    outputDir: raw.outputDir ?? raw.runner?.outputDir,
    stateDbPath: raw.stateDbPath ?? raw.runner?.stateDbPath,
    acceptedAgentLabels: raw.acceptedAgentLabels ?? raw.github?.agentLabels,
    statusLabels: raw.statusLabels ?? {
      ready: raw.github?.statusReadyLabel,
      inProgress: raw.github?.statusInProgressLabel,
    },
    priorityLabelRanking: raw.priorityLabelRanking ?? raw.github?.priorityLabels,
    safeDefaultValidationCommands: raw.safeDefaultValidationCommands,
    systemd: raw.systemd ?? {
      serviceName: raw.runner?.serviceName,
      timerName: raw.runner?.timerName,
    },
    runner: {
      lockPath: raw.runner?.lockPath,
      candidateLimit: raw.runner?.candidateLimit,
      requireManagerPreflight: raw.runner?.requireManagerPreflight ?? raw.github?.requireManagerPreflight,
      autoProceedFromPreflight: raw.runner?.autoProceedFromPreflight ?? raw.github?.autoProceedFromPreflight,
    },
  };
}

export function validateAgentRunnerConfig(input) {
  const config = normalizeLegacyShape(input);
  const errors = [];
  if (!isPlainObject(config)) errors.push('config must be a JSON object');
  if (!nonEmptyString(config?.projectId)) errors.push('projectId is required');
  if (!nonEmptyString(config?.displayName)) errors.push('displayName is required');
  if (!nonEmptyString(config?.githubRepo) || !config.githubRepo.includes('/')) errors.push('githubRepo is required as owner/repo');
  if (!nonEmptyString(config?.localRepoPath)) errors.push('localRepoPath is required');
  if (!nonEmptyString(config?.outputDir)) errors.push('outputDir is required');
  if (!nonEmptyString(config?.stateDbPath)) errors.push('stateDbPath is required');
  if (!stringArray(config?.acceptedAgentLabels) || config.acceptedAgentLabels.length === 0) errors.push('acceptedAgentLabels must contain at least one label');
  if (!nonEmptyString(config?.statusLabels?.ready)) errors.push('statusLabels.ready is required');
  if (!nonEmptyString(config?.statusLabels?.inProgress)) errors.push('statusLabels.inProgress is required');
  if (!stringArray(config?.priorityLabelRanking) || config.priorityLabelRanking.length === 0) errors.push('priorityLabelRanking must contain at least one label');
  if (!stringArray(config?.safeDefaultValidationCommands)) errors.push('safeDefaultValidationCommands must be an array of strings');
  if (!nonEmptyString(config?.systemd?.serviceName)) errors.push('systemd.serviceName is required');
  if (!nonEmptyString(config?.systemd?.timerName)) errors.push('systemd.timerName is required');
  if (errors.length > 0) throw new Error(`Invalid agent runner config: ${errors.join('; ')}`);

  return {
    ...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG,
    ...config,
    acceptedAgentLabels: [...new Set(config.acceptedAgentLabels)],
    statusLabels: { ...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.statusLabels, ...config.statusLabels },
    priorityLabelRanking: [...config.priorityLabelRanking],
    safeDefaultValidationCommands: [...config.safeDefaultValidationCommands],
    systemd: { ...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.systemd, ...definedEntries(config.systemd) },
    runner: { ...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.runner, ...definedEntries(config.runner) },
  };
}

export function loadAgentRunnerConfig({ argv = [], env = process.env, configPath = resolveConfigPath(argv, env) } = {}) {
  if (!configPath) return validateAgentRunnerConfig(DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG);
  return validateAgentRunnerConfig(readConfigFile(configPath));
}

export function projectIdentity(config) {
  return {
    projectId: config.projectId,
    displayName: config.displayName,
    githubRepo: config.githubRepo,
    localRepoPath: config.localRepoPath,
  };
}
