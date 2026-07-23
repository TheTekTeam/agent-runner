import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import { parseArgs as schedulerParseArgs } from './claude-runner-cron.mjs';

const DEFAULT_CONFIG_RELATIVE = '.config/agent-runner/modelspend.json';
const DEFAULT_ENV_RELATIVE = '.config/agent-runner/runner.env';

function unquote(value) {
  const text = String(value ?? '');
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Parse the deliberately restricted KEY=VALUE format accepted by
 * bin/run-project.sh. This never evaluates shell syntax, substitutions or
 * expansions; values are ordinary strings with one optional quote pair.
 */
export function parseRunnerEnvFile(text = '') {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length);
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

function absoluteRuntimePath(value, workingDirectory) {
  const path = String(value || '').trim();
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(workingDirectory, path);
}

/**
 * Mirror bin/run-project.sh before any probe, admission or execution:
 * choose the config path, load the machine env file over the inherited env,
 * pin both config variables to the chosen file, then let the scheduler's own
 * parser determine state/output precedence.
 */
export function resolveSupervisedCanaryRuntime(env = process.env, dependencies = {}) {
  const fileExists = dependencies.fileExists || existsSync;
  const readFile = dependencies.readFile || readFileSync;
  const parseSchedulerArgs = dependencies.parseSchedulerArgs || schedulerParseArgs;
  const home = String(env.HOME || homedir());
  const configPath = resolve(String(env.AGENT_RUNNER_CONFIG || join(home, DEFAULT_CONFIG_RELATIVE)));
  const envFilePath = resolve(String(env.AGENT_RUNNER_ENV_FILE || join(home, DEFAULT_ENV_RELATIVE)));
  const fileEnv = fileExists(envFilePath)
    ? parseRunnerEnvFile(readFile(envFilePath, 'utf8'))
    : {};
  const runtimeEnv = {
    ...env,
    ...fileEnv,
    AGENT_RUNNER_CONFIG: configPath,
    CLAUDE_RUNNER_CONFIG: configPath,
  };
  const config = loadAgentRunnerConfig({ env: runtimeEnv, configPath });
  const schedulerArgs = parseSchedulerArgs([], runtimeEnv);
  const workingDirectory = resolve(config.localRepoPath);
  const stateDbPath = absoluteRuntimePath(schedulerArgs.stateDbPath, workingDirectory);
  const outputDir = absoluteRuntimePath(schedulerArgs.outputDir, workingDirectory);
  if (!stateDbPath) throw new Error('supervised canary runtime state database path is unavailable');

  return {
    env: runtimeEnv,
    config: {
      ...config,
      stateDbPath,
      outputDir,
    },
    configPath,
    envFilePath,
    envFileLoaded: fileExists(envFilePath),
    stateDbPath,
    outputDir,
    workingDirectory,
  };
}

export function applySupervisedCanaryRuntime(runtime, dependencies = {}) {
  if (!runtime?.stateDbPath || !runtime?.env) {
    throw new Error('resolved supervised canary runtime is required');
  }
  return {
    ...dependencies,
    config: {
      ...(dependencies.config || runtime.config || {}),
      stateDbPath: runtime.stateDbPath,
      outputDir: runtime.outputDir || dependencies.config?.outputDir || runtime.config?.outputDir,
    },
  };
}
