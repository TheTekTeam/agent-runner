import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import { normalizeQueueTriagePolicy } from './agent-runner-queue-triage.mjs';

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
    blocked: 'status:blocked',
    done: 'status:done',
  },
  priorityLabelRanking: ['priority:P0', 'priority:P1', 'priority:P2', 'priority:P3'],
  safeDefaultValidationCommands: [
    'npm run validate:quick:plan -- --files <changed files>',
    'node --test scripts/ops/agent-runner-config.test.mjs',
  ],
  queueTriage: {
    enabled: false,
    fallbackIntervalMinutes: 60,
    timezone: 'Europe/London',
    rotatingBacklogSlice: 2,
    maxChangedItems: 20,
    maxDebuggerAnomalies: 4,
    maxMutations: 3,
    acceptedStatusLabels: ['status:ready', 'status:in-progress', 'status:blocked', 'status:done'],
    priorityLabels: ['priority:P0', 'priority:P1', 'priority:P2', 'priority:P3'],
  },
  systemd: {
    serviceName: 'modelspend-claude-runner.service',
    timerName: 'modelspend-claude-runner.timer',
  },
  runner: {
    lockPath: '.var/claude-runner/cron.lock',
    candidateLimit: 100,
  },
});

const CONFIG_ENV = 'AGENT_RUNNER_CONFIG';

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function requestedExecuteMode(argv = [], env = process.env) {
  let execute = truthy(env?.CLAUDE_RUNNER_CRON_EXECUTE);
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (arg === '--execute') execute = true;
    else if (arg === '--dry-run') execute = false;
  }
  return execute;
}

/**
 * #256: current quota evidence is mandatory for every executing scheduled run.
 * The historical skip controls may remain parseable for mutation-free dry-run
 * diagnostics, but they must fail closed before config loading, candidate
 * discovery, claim mutation, workspace creation, or provider launch whenever
 * the scheduler resolves to execute mode. Account-credit state is deliberately
 * not consulted.
 */
export function assertMandatoryQuotaPreflight({ argv = [], env = process.env } = {}) {
  const args = Array.isArray(argv) ? argv : [];
  if (!requestedExecuteMode(args, env)) return;

  const skipFlagRequested = args.includes('--skip-quota-preflight');
  const skipEnvRequested = truthy(env?.CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT);
  if (!skipFlagRequested && !skipEnvRequested) return;

  const sources = [];
  if (skipFlagRequested) sources.push('--skip-quota-preflight');
  if (skipEnvRequested) sources.push('CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT');
  throw new Error(`Quota preflight is mandatory in execute mode; refusing legacy quota-preflight bypass (${sources.join(', ')})`);
}

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
  assertMandatoryQuotaPreflight({ argv, env });
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
    queueTriage: raw.queueTriage,
    systemd: raw.systemd ?? {
      serviceName: raw.runner?.serviceName,
      timerName: raw.runner?.timerName,
    },
    runner: {
      lockPath: raw.runner?.lockPath,
      candidateLimit: raw.runner?.candidateLimit,
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

  const statusLabels = { ...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.statusLabels, ...definedEntries(config.statusLabels) };
  const priorityLabelRanking = [...config.priorityLabelRanking];
  let queueTriage;
  try {
    queueTriage = normalizeQueueTriagePolicy(config.queueTriage ?? {}, {
      statusLabels: [...new Set(Object.values(statusLabels))],
      priorityLabels: priorityLabelRanking,
    });
  } catch (error) {
    throw new Error(`Invalid agent runner config: ${error.message}`);
  }

  return {
    ...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG,
    ...config,
    acceptedAgentLabels: [...new Set(config.acceptedAgentLabels)],
    statusLabels,
    priorityLabelRanking,
    safeDefaultValidationCommands: [...config.safeDefaultValidationCommands],
    queueTriage,
    systemd: { ...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.systemd, ...definedEntries(config.systemd) },
    runner: { ...DEFAULT_MODELSPEND_AGENT_RUNNER_CONFIG.runner, ...definedEntries(config.runner) },
  };
}

export function loadAgentRunnerConfig({ argv = [], env = process.env, configPath = resolveConfigPath(argv, env) } = {}) {
  assertMandatoryQuotaPreflight({ argv, env });
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

// Path fields only: env value must resolve under $HOME/.local/state/agent-runner/<projectId> (docs/MIGRATION.md), not merely contain matching segments anywhere.
// Both sides are resolved (lexically normalized, `..`/`.` collapsed) before containment is checked, so
// traversal escapes (modelspend/../agent-runner) and prefix collisions (modelspend-other) are rejected.
function envValueMatchesProjectStateConvention(envValue, projectId, env) {
  if (!projectId) return false;
  const home = String(env.HOME || homedir());
  const root = resolve(home, '.local', 'state', 'agent-runner', projectId);
  const candidate = resolve(String(envValue || ''));
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Selected project config owns repo/output/state/lock identity; shared env must never redirect it.
// No config selected => legacy default-config override unchanged. 'path' fields accept the
// canonical-state-root exception; 'identity' fields (e.g. GITHUB_REPOSITORY) require exact agreement.
export function resolveProjectScopedEnvValue({ envValue, configValue, configPath, envVarName, configFieldName, projectId, env = process.env, fieldKind = 'path' }) {
  if (!envValue) return configValue;
  if (!configPath) return envValue;
  if (envValue === configValue) return envValue;
  if (fieldKind === 'path' && envValueMatchesProjectStateConvention(envValue, projectId, env)) return envValue;
  throw new Error(`${envVarName} ("${envValue}") disagrees with project "${projectId}" config ${configFieldName} ("${configValue}") from ${configPath}; refusing to let shared machine environment redirect this project's identity`);
}

// Env vars steering repo/output/state/lock identity; read from `env` by parseArgs and pre-scheduler gates.
export const PROJECT_SCOPED_ENV_FIELDS = Object.freeze([
  { envVarName: 'GITHUB_REPOSITORY', configFieldName: 'githubRepo', fieldKind: 'identity' },
  { envVarName: 'CLAUDE_RUNNER_OUTPUT_DIR', configFieldName: 'outputDir', fieldKind: 'path' },
  { envVarName: 'CLAUDE_RUNNER_STATE_DB', configFieldName: 'stateDbPath', fieldKind: 'path' },
  { envVarName: 'CLAUDE_RUNNER_CRON_LOCK', configFieldName: 'runner.lockPath', fieldKind: 'path' },
]);

function configFieldValue(config, configFieldName) {
  return configFieldName.split('.').reduce((value, key) => value?.[key], config);
}

// Fail closed, as early as possible in the outer entrypoint, before candidate discovery, claim, GitHub mutation, or model launch.
export function assertProjectScopedEnv({ config, configPath, env }) {
  for (const { envVarName, configFieldName, fieldKind } of PROJECT_SCOPED_ENV_FIELDS) {
    resolveProjectScopedEnvValue({
      envValue: env[envVarName],
      configValue: configFieldValue(config, configFieldName),
      configPath,
      envVarName,
      configFieldName,
      projectId: config.projectId,
      env,
      fieldKind,
    });
  }
}
