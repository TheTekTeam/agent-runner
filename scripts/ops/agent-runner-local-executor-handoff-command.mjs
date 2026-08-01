import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runLocalExecutorHandoffCycle } from './agent-runner-local-executor-handoff.mjs';
import {
  loadLocalExecutorPolicy,
  resolveLocalExecutorPolicyPath,
  stripLocalExecutorPolicyArgs,
} from './agent-runner-local-executor-policy.mjs';
import {
  loadProjectRegistry,
  resolveProjectRegistryPath,
  stripProjectRegistryArgs,
} from './agent-runner-project-registry.mjs';

const DEFAULT_DB_PATH = join(
  homedir(),
  '.local',
  'state',
  'agent-runner',
  'controller',
  'controller.sqlite',
);

function optionValue(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      return value;
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

function integerOption(argv, name, fallback, { min, max }) {
  const value = optionValue(argv, name);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function parseLocalExecutorHandoffCommandOptions(argv = [], env = process.env) {
  const registryPath = resolveProjectRegistryPath(argv, env);
  const policyPath = resolveLocalExecutorPolicyPath(argv, env);
  if (!registryPath) throw new Error('project registry is required');
  if (!policyPath) throw new Error('local executor policy is required');
  const remaining = stripLocalExecutorPolicyArgs(stripProjectRegistryArgs(argv));
  return Object.freeze({
    registryPath: resolve(registryPath),
    policyPath: resolve(policyPath),
    dbPath: resolve(
      optionValue(remaining, '--db')
      || env.AGENT_RUNNER_CONTROLLER_DB
      || DEFAULT_DB_PATH,
    ),
    discoveryLimit: integerOption(remaining, '--discovery-limit', 100, {
      min: 1, max: 500,
    }),
    executionLimit: integerOption(remaining, '--execution-limit', 20, {
      min: 1, max: 20,
    }),
  });
}

export function runLocalExecutorHandoffCommand({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date().toISOString(),
} = {}) {
  if (argv.includes('--help')) {
    return Object.freeze({
      help: [
        'Usage: node scripts/ops/agent-runner-local-executor-handoff-command.mjs \\',
        '  --project-registry <path> --executor-policy <path> [--db <path>]',
        '  [--discovery-limit <1..500>] [--execution-limit <1..20>]',
        '',
        'Consumes only processed durable triage releases and emits read-only project.inspect jobs.',
      ].join('\n'),
    });
  }
  const options = parseLocalExecutorHandoffCommandOptions(argv, env);
  const registry = loadProjectRegistry({ registryPath: options.registryPath });
  const policy = loadLocalExecutorPolicy({ policyPath: options.policyPath });
  return runLocalExecutorHandoffCycle({
    controllerDb: options.dbPath,
    registry,
    policy,
    now,
    discoveryLimit: options.discoveryLimit,
    executionLimit: options.executionLimit,
    env,
  });
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    const result = runLocalExecutorHandoffCommand();
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = typeof error?.code === 'string'
      ? error.code
      : 'executor-handoff-command-failed';
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  }
}
