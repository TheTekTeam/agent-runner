import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EventControllerReleaseStore,
  runEventControllerCycle,
} from './agent-runner-event-controller.mjs';
import { EventIngressStore } from './agent-runner-event-ingress.mjs';
import { EventSettlementStore } from './agent-runner-event-settlement.mjs';
import { GhCliGitHubReadClient } from './agent-runner-github-checks-provider.mjs';
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

function integerOption(argv, name, fallback, { min, max }) {
  const raw = optionValue(argv, name);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function parseEventControllerOptions(argv = [], env = process.env) {
  const registryPath = resolveProjectRegistryPath(argv, env);
  if (!registryPath) throw new Error('project registry is required');
  const remaining = stripProjectRegistryArgs(argv);
  return Object.freeze({
    registryPath: resolve(registryPath),
    dbPath: resolve(optionValue(remaining, '--db') || env.AGENT_RUNNER_CONTROLLER_DB || DEFAULT_DB_PATH),
    debounceMs: integerOption(remaining, '--debounce-ms', 60_000, { min: 0, max: 60 * 60_000 }),
    quietPeriodMs: integerOption(remaining, '--quiet-ms', 90_000, { min: 0, max: 60 * 60_000 }),
    settlementTimeoutMs: integerOption(remaining, '--settlement-timeout-ms', 60 * 60_000, {
      min: 1_000,
      max: 24 * 60 * 60_000,
    }),
    batchLimit: integerOption(remaining, '--batch-limit', 100, { min: 1, max: 500 }),
  });
}

export async function runEventControllerCommand({
  argv = process.argv.slice(2),
  env = process.env,
  observedAt = new Date().toISOString(),
} = {}) {
  if (argv.includes('--help')) {
    return {
      help: [
        'Usage: node scripts/ops/agent-runner-event-controller-cycle.mjs --project-registry <path> [options]',
        '',
        'Options:',
        '  --db <path>',
        '  --debounce-ms <milliseconds>',
        '  --quiet-ms <milliseconds>',
        '  --settlement-timeout-ms <milliseconds>',
        '  --batch-limit <1-500>',
        '',
        'Environment:',
        '  AGENT_RUNNER_PROJECT_REGISTRY',
        '  AGENT_RUNNER_CONTROLLER_DB',
        '  GH_TOKEN/GITHUB_TOKEN or an existing gh authenticated session',
      ].join('\n'),
    };
  }

  const options = parseEventControllerOptions(argv, env);
  const registry = loadProjectRegistry({ registryPath: options.registryPath });
  const ingressStore = new EventIngressStore(options.dbPath);
  const settlementStore = new EventSettlementStore(options.dbPath);
  const releaseStore = new EventControllerReleaseStore(options.dbPath);
  try {
    return await runEventControllerCycle({
      registry,
      settlementStore,
      releaseStore,
      githubClient: new GhCliGitHubReadClient({ env }),
      now: observedAt,
      debounceMs: options.debounceMs,
      quietPeriodMs: options.quietPeriodMs,
      settlementTimeoutMs: options.settlementTimeoutMs,
      batchLimit: options.batchLimit,
    });
  } finally {
    releaseStore.close();
    settlementStore.close();
    ingressStore.close();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runEventControllerCommand().then((result) => {
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'controller-command-failed' })}\n`);
    process.exitCode = 1;
  });
}
