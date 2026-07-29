import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  executeLocalExecutorJob,
  LocalExecutorStore,
} from './agent-runner-local-executor.mjs';
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

const DEFAULT_DB_PATH = join(homedir(), '.local', 'state', 'agent-runner', 'controller', 'controller.sqlite');

function optionValue(argv, name) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      return value;
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

export function parseLocalExecutorCommandOptions(argv = [], env = process.env) {
  const registryPath = resolveProjectRegistryPath(argv, env);
  const policyPath = resolveLocalExecutorPolicyPath(argv, env);
  if (!registryPath) throw new Error('project registry is required');
  if (!policyPath) throw new Error('local executor policy is required');
  const remaining = stripLocalExecutorPolicyArgs(stripProjectRegistryArgs(argv));
  const jobPath = optionValue(remaining, '--job');
  if (!jobPath) throw new Error('--job is required');
  return Object.freeze({
    registryPath: resolve(registryPath),
    policyPath: resolve(policyPath),
    jobPath: resolve(jobPath),
    dbPath: resolve(optionValue(remaining, '--db') || env.AGENT_RUNNER_CONTROLLER_DB || DEFAULT_DB_PATH),
  });
}

export function runLocalExecutorCommand({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date().toISOString(),
} = {}) {
  if (argv.includes('--help')) {
    return {
      help: [
        'Usage: node scripts/ops/agent-runner-local-executor-job.mjs \\',
        '  --project-registry <path> --executor-policy <path> --job <path> [--db <path>]',
        '',
        'The job file must contain one typed executor job. Arbitrary shell commands are not accepted.',
      ].join('\n'),
    };
  }
  const options = parseLocalExecutorCommandOptions(argv, env);
  let input;
  try {
    input = JSON.parse(readFileSync(options.jobPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('executor job file contains invalid JSON');
    throw new Error('unable to read executor job file');
  }
  const registry = loadProjectRegistry({ registryPath: options.registryPath });
  const policy = loadLocalExecutorPolicy({ policyPath: options.policyPath });
  const store = new LocalExecutorStore(options.dbPath);
  try {
    return executeLocalExecutorJob({ input, registry, policy, store, env, now });
  } finally {
    store.close();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const result = runLocalExecutorCommand();
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'executor-command-failed' })}\n`);
    process.exitCode = 1;
  }
}
