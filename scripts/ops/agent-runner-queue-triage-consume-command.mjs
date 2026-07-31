import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateAgentRunnerConfig } from './agent-runner-config.mjs';
import { GhCliGitHubReadClient } from './agent-runner-github-checks-provider.mjs';
import {
  renderQueueTriageConsumptionMarkdown,
  runQueueTriageReleaseConsumer,
} from './agent-runner-queue-triage-consumer.mjs';

function boundedLease(value) {
  const leaseMs = Number(value);
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60 * 60_000) {
    throw new Error('--lease-ms must be an integer from 1000 to 3600000');
  }
  return leaseMs;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/ops/agent-runner-queue-triage-consume-command.mjs \\',
    '    --controller-db <path> --release <batch-id> --project-config <project.json> \\',
    '    [--lease-ms 300000] [--format json|markdown]',
    '',
    'Consumes exactly one explicit release into a durable dry-run terminal result.',
    'GitHub access is GET-only. Action-plan execution, --execute, pending sweeps and scheduling are unavailable.',
  ].join('\n');
}

export function parseQueueTriageConsumeArgs(argv = []) {
  const parsed = {
    controllerDb: null,
    releaseId: null,
    projectConfig: null,
    leaseMs: 5 * 60_000,
    format: 'json',
    help: false,
  };
  const valueAfter = (name, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--controller-db') parsed.controllerDb = valueAfter(arg, index++);
    else if (arg.startsWith('--controller-db=')) parsed.controllerDb = arg.slice('--controller-db='.length);
    else if (arg === '--release') parsed.releaseId = valueAfter(arg, index++);
    else if (arg.startsWith('--release=')) parsed.releaseId = arg.slice('--release='.length);
    else if (arg === '--project-config') parsed.projectConfig = valueAfter(arg, index++);
    else if (arg.startsWith('--project-config=')) parsed.projectConfig = arg.slice('--project-config='.length);
    else if (arg === '--lease-ms') parsed.leaseMs = boundedLease(valueAfter(arg, index++));
    else if (arg.startsWith('--lease-ms=')) parsed.leaseMs = boundedLease(arg.slice('--lease-ms='.length));
    else if (arg === '--format') parsed.format = valueAfter(arg, index++);
    else if (arg.startsWith('--format=')) parsed.format = arg.slice('--format='.length);
    else if (['--execute', '--pending', '--all-enabled', '--fallback'].includes(arg)) {
      throw new Error(`${arg} is not available in durable single-release consumption`);
    } else throw new Error(`unsupported argument: ${arg}`);
  }

  if (parsed.help) return Object.freeze(parsed);
  if (!parsed.controllerDb) throw new Error('--controller-db is required');
  if (!parsed.releaseId) throw new Error('--release is required');
  if (!parsed.projectConfig) throw new Error('--project-config is required');
  if (!['json', 'markdown'].includes(parsed.format)) throw new Error('--format must be json or markdown');
  return Object.freeze(parsed);
}

export function runQueueTriageConsumeCommand({
  argv = process.argv.slice(2),
  readFile = readFileSync,
  validateProject = validateAgentRunnerConfig,
  clientFactory = () => new GhCliGitHubReadClient(),
  consume = runQueueTriageReleaseConsumer,
} = {}) {
  const args = parseQueueTriageConsumeArgs(argv);
  if (args.help) return `${usage()}\n`;
  const project = validateProject(JSON.parse(readFile(resolve(args.projectConfig), 'utf8')));
  const result = consume({
    controllerDb: resolve(args.controllerDb),
    releaseId: args.releaseId,
    project,
    client: clientFactory(),
    leaseMs: args.leaseMs,
  });
  return args.format === 'markdown'
    ? renderQueueTriageConsumptionMarkdown(result)
    : `${JSON.stringify(result)}\n`;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.stdout.write(runQueueTriageConsumeCommand());
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: typeof error?.code === 'string' ? error.code : 'queue-triage-consume-command-failed',
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}
