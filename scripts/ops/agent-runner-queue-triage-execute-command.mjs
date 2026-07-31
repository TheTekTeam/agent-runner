import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateAgentRunnerConfig } from './agent-runner-config.mjs';
import { GhCliGitHubReadClient } from './agent-runner-github-checks-provider.mjs';
import { GhCliGitHubWriteClient } from './agent-runner-queue-triage-github-write.mjs';
import {
  renderQueueTriageExecutionMarkdown,
  runQueueTriageReleaseExecutor,
} from './agent-runner-queue-triage-executor.mjs';

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
    '  node scripts/ops/agent-runner-queue-triage-execute-command.mjs \\',
    '    --controller-db <path> --release <batch-id> --project-config <project.json> \\',
    '    --manager-revision <revision> --manager-fingerprint <sha256:...> --execute \\',
    '    [--lease-ms 300000] [--format json|markdown]',
    '',
    'Executes at most three allowlisted action plans for one explicit release.',
    'Pending sweeps, fallback, all-enabled mode, scheduling and non-issue writes are unavailable.',
  ].join('\n');
}

export function parseQueueTriageExecuteArgs(argv = []) {
  const parsed = {
    controllerDb: null,
    releaseId: null,
    projectConfig: null,
    managerRevision: null,
    managerFingerprint: null,
    execute: false,
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
    else if (arg === '--manager-revision') parsed.managerRevision = valueAfter(arg, index++);
    else if (arg.startsWith('--manager-revision=')) parsed.managerRevision = arg.slice('--manager-revision='.length);
    else if (arg === '--manager-fingerprint') parsed.managerFingerprint = valueAfter(arg, index++);
    else if (arg.startsWith('--manager-fingerprint=')) parsed.managerFingerprint = arg.slice('--manager-fingerprint='.length);
    else if (arg === '--execute') parsed.execute = true;
    else if (arg === '--lease-ms') parsed.leaseMs = boundedLease(valueAfter(arg, index++));
    else if (arg.startsWith('--lease-ms=')) parsed.leaseMs = boundedLease(arg.slice('--lease-ms='.length));
    else if (arg === '--format') parsed.format = valueAfter(arg, index++);
    else if (arg.startsWith('--format=')) parsed.format = arg.slice('--format='.length);
    else if (['--pending', '--all-enabled', '--fallback', '--dry-run'].includes(arg)) {
      throw new Error(`${arg} is not available in bounded execution`);
    } else throw new Error(`unsupported argument: ${arg}`);
  }
  if (parsed.help) return Object.freeze(parsed);
  if (!parsed.controllerDb) throw new Error('--controller-db is required');
  if (!parsed.releaseId) throw new Error('--release is required');
  if (!parsed.projectConfig) throw new Error('--project-config is required');
  if (!parsed.managerRevision) throw new Error('--manager-revision is required');
  if (!parsed.managerFingerprint) throw new Error('--manager-fingerprint is required');
  if (!parsed.execute) throw new Error('--execute is required for bounded execution');
  if (!['json', 'markdown'].includes(parsed.format)) throw new Error('--format must be json or markdown');
  return Object.freeze(parsed);
}

export function runQueueTriageExecuteCommand({
  argv = process.argv.slice(2),
  readFile = readFileSync,
  validateProject = validateAgentRunnerConfig,
  readClientFactory = () => new GhCliGitHubReadClient(),
  writeClientFactory = () => new GhCliGitHubWriteClient(),
  execute = runQueueTriageReleaseExecutor,
} = {}) {
  const args = parseQueueTriageExecuteArgs(argv);
  if (args.help) return `${usage()}\n`;
  const project = validateProject(JSON.parse(readFile(resolve(args.projectConfig), 'utf8')));
  const result = execute({
    controllerDb: resolve(args.controllerDb),
    releaseId: args.releaseId,
    project,
    managerAuthority: {
      revision: args.managerRevision,
      fingerprint: args.managerFingerprint,
    },
    readClient: readClientFactory(),
    writeClient: writeClientFactory(),
    leaseMs: args.leaseMs,
  });
  return args.format === 'markdown'
    ? renderQueueTriageExecutionMarkdown(result)
    : `${JSON.stringify(result)}\n`;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.stdout.write(runQueueTriageExecuteCommand());
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: typeof error?.code === 'string' ? error.code : 'queue-triage-execute-command-failed',
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}
