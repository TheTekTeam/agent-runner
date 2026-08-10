import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const XDG_STATE_NAMESPACE = 'agent-runner';

function pathSegments(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean);
}

/**
 * The documented machine-local state convention (docs/MIGRATION.md) places
 * every configured project's own durable state under
 * `.../agent-runner/<projectId>[/...]`. An env value that resolves a
 * project's own relative config default (e.g. `.var/claude-runner`) into
 * that same project's canonical absolute location under this convention is
 * a legitimate same-project override, not a cross-project redirect, even
 * though it disagrees textually with the config's raw field value (#169
 * regression item C). Matching on the segment immediately following the
 * shared `agent-runner` namespace folder (rather than "does projectId
 * appear anywhere in the path") avoids a false match when a project's own
 * id happens to equal that namespace folder's name.
 */
function envValueMatchesProjectStateConvention(envValue, projectId) {
  if (!projectId) return false;
  const segments = pathSegments(envValue);
  const namespaceIndex = segments.indexOf(XDG_STATE_NAMESPACE);
  return namespaceIndex !== -1 && segments[namespaceIndex + 1] === projectId;
}

/**
 * A project config explicitly selected via --config/AGENT_RUNNER_CONFIG/
 * CLAUDE_RUNNER_CONFIG owns this run's repo/output/state/lock identity.
 * Shared machine environment (e.g. a `runner.env` written for a different
 * configured project) must never silently redirect that identity into
 * another project's durable state tree (#169). An env value that agrees
 * with the selected config, or that resolves the selected project's own
 * default into its own canonical machine-local location, is redundant but
 * harmless; a value that cannot be attributed to the selected project
 * cannot be proven safe and fails closed before candidate selection, claim
 * or GitHub mutation. Without an explicit config selection there is no
 * project identity to disagree with, so the legacy default-config env
 * override contract (documented for the compiled-in ModelSpend default)
 * is preserved unchanged.
 */
export function resolveProjectScopedEnvValue({ envValue, configValue, configPath, envVarName, configFieldName, projectId }) {
  if (!envValue) return configValue;
  if (!configPath) return envValue;
  if (envValue === configValue) return envValue;
  if (envValueMatchesProjectStateConvention(envValue, projectId)) return envValue;
  throw new Error(
    `${envVarName} ("${envValue}") disagrees with project "${projectId}" config ${configFieldName} ("${configValue}") from ${configPath}; refusing to let shared machine environment redirect this project's identity`,
  );
}

// The exhaustive list of shared-machine-environment overrides that can steer
// a run's repo/output/state/lock identity (#169). Every consumer that reads
// one of these env vars -- the scheduler (`claude-runner-cron.mjs`'s
// `parseArgs`) and, critically, standalone pre-scheduler gates that resolve
// their own paths straight from `env` (e.g. the circuit breaker's state DB)
// without ever calling `parseArgs` -- must agree with the explicitly
// selected project config before any of them runs. Listing the fields once
// here, rather than once per consumer, is what keeps that agreement a single
// invariant instead of a set of call sites that can silently drift apart.
export const PROJECT_SCOPED_ENV_FIELDS = Object.freeze([
  { envVarName: 'GITHUB_REPOSITORY', configFieldName: 'githubRepo' },
  { envVarName: 'CLAUDE_RUNNER_OUTPUT_DIR', configFieldName: 'outputDir' },
  { envVarName: 'CLAUDE_RUNNER_STATE_DB', configFieldName: 'stateDbPath' },
  { envVarName: 'CLAUDE_RUNNER_CRON_LOCK', configFieldName: 'runner.lockPath' },
]);

function configFieldValue(config, configFieldName) {
  return configFieldName.split('.').reduce((value, key) => value?.[key], config);
}

/**
 * Fail closed, before any candidate discovery, claim, attempt creation,
 * GitHub mutation or model launch, if the shared machine environment
 * disagrees with the explicitly selected project config on any
 * repo/output/state/lock field (#169). Intended to run once, as early as
 * possible in the outer entrypoint (`bin/run-project.sh`), so no downstream
 * consumer -- including one that never itself validates project scope --
 * can act on a mismatched identity.
 */
export function assertProjectScopedEnv({ config, configPath, env }) {
  for (const { envVarName, configFieldName } of PROJECT_SCOPED_ENV_FIELDS) {
    resolveProjectScopedEnvValue({
      envValue: env[envVarName],
      configValue: configFieldValue(config, configFieldName),
      configPath,
      envVarName,
      configFieldName,
      projectId: config.projectId,
    });
  }
}
