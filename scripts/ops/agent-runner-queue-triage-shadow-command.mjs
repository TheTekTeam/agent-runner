import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EventControllerReleaseReader } from './agent-runner-event-controller.mjs';
import { QueueTriageShadowStore } from './agent-runner-queue-triage-shadow-store.mjs';

function boundedLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('--limit must be an integer from 1 to 20');
  }
  return limit;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/ops/agent-runner-queue-triage-shadow-command.mjs \\',
    '    --controller-db <path> --shadow-db <path> --release <batch-id> \\',
    '    [--evidence <normalized-evidence.json>] [--format json|markdown]',
    '  node scripts/ops/agent-runner-queue-triage-shadow-command.mjs \\',
    '    --controller-db <path> --shadow-db <path> --pending [--limit 20] \\',
    '    [--format json|markdown]',
    '',
    'The controller database is opened read-only. Only the separate shadow database may change.',
  ].join('\n');
}

export function parseQueueTriageShadowArgs(argv = []) {
  const parsed = {
    controllerDb: null,
    shadowDb: null,
    batchId: null,
    pending: false,
    limit: 20,
    evidence: null,
    format: 'json',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = (name) => {
      const value = argv[index += 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      return value;
    };
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--controller-db') parsed.controllerDb = nextValue(arg);
    else if (arg.startsWith('--controller-db=')) parsed.controllerDb = arg.slice('--controller-db='.length);
    else if (arg === '--shadow-db') parsed.shadowDb = nextValue(arg);
    else if (arg.startsWith('--shadow-db=')) parsed.shadowDb = arg.slice('--shadow-db='.length);
    else if (arg === '--release') parsed.batchId = nextValue(arg);
    else if (arg.startsWith('--release=')) parsed.batchId = arg.slice('--release='.length);
    else if (arg === '--pending') parsed.pending = true;
    else if (arg === '--limit') parsed.limit = boundedLimit(nextValue(arg));
    else if (arg.startsWith('--limit=')) parsed.limit = boundedLimit(arg.slice('--limit='.length));
    else if (arg === '--evidence') parsed.evidence = nextValue(arg);
    else if (arg.startsWith('--evidence=')) parsed.evidence = arg.slice('--evidence='.length);
    else if (arg === '--format') parsed.format = nextValue(arg);
    else if (arg.startsWith('--format=')) parsed.format = arg.slice('--format='.length);
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (parsed.help) return Object.freeze(parsed);
  if (!parsed.controllerDb || !parsed.shadowDb) {
    throw new Error('--controller-db and --shadow-db are required');
  }
  if (Boolean(parsed.batchId) === Boolean(parsed.pending)) {
    throw new Error('choose exactly one of --release or --pending');
  }
  if (parsed.evidence && parsed.pending) {
    throw new Error('--evidence requires one explicit --release');
  }
  if (!['json', 'markdown'].includes(parsed.format)) {
    throw new Error('--format must be json or markdown');
  }
  return Object.freeze(parsed);
}

function renderMarkdown(result) {
  const lines = [
    '# Agent Runner queue-triage shadow observation',
    '',
    `- Releases inspected: ${result.releasesInspected}`,
    `- Observations inserted: ${result.observationsInserted}`,
    `- Observations replayed: ${result.observationsReplayed}`,
    `- Reports inserted: ${result.reportsInserted}`,
    `- Reports replayed: ${result.reportsReplayed}`,
    '',
    '## Outcomes',
    '',
  ];
  if (result.outcomes.length === 0) lines.push('- None.');
  for (const outcome of result.outcomes) {
    lines.push(
      `- ${outcome.repository} / ${outcome.batchId}: observation=${outcome.observation}, report=${outcome.report}`,
    );
  }
  lines.push(
    '',
    '## RUN_CONTROL',
    '',
    '```json',
    JSON.stringify(result.runControl),
    '```',
  );
  return `${lines.join('\n')}\n`;
}

export function runQueueTriageShadowCommand({
  argv = process.argv.slice(2),
  readFile = readFileSync,
  observedAt = new Date().toISOString(),
} = {}) {
  const args = parseQueueTriageShadowArgs(argv);
  if (args.help) return `${usage()}\n`;
  const reader = new EventControllerReleaseReader(resolve(args.controllerDb));
  const store = new QueueTriageShadowStore(resolve(args.shadowDb));
  try {
    const releases = args.batchId
      ? [reader.getRelease(args.batchId)].filter(Boolean)
      : reader.listReleases({ states: ['pending'], limit: args.limit });
    if (args.batchId && releases.length === 0) {
      throw new Error(`pending release not found: ${args.batchId}`);
    }
    if (releases.some((release) => release.state !== 'pending')) {
      throw new Error('shadow observation accepts pending releases only');
    }
    const evidence = args.evidence
      ? JSON.parse(readFile(resolve(args.evidence), 'utf8'))
      : null;
    const outcomes = [];
    let observationsInserted = 0;
    let observationsReplayed = 0;
    let reportsInserted = 0;
    let reportsReplayed = 0;

    for (const release of releases) {
      const observed = store.observeRelease(release, { observedAt });
      observationsInserted += observed.inserted ? 1 : 0;
      observationsReplayed += observed.replayed ? 1 : 0;
      let reportState = 'none';
      if (evidence) {
        const planned = store.attachEvidenceAndPlan(release, evidence, { plannedAt: observedAt });
        reportsInserted += planned.inserted ? 1 : 0;
        reportsReplayed += planned.replayed ? 1 : 0;
        reportState = planned.inserted ? 'inserted' : 'replayed';
      }
      outcomes.push(Object.freeze({
        batchId: release.batchId,
        projectId: release.payload.projectId,
        repository: release.payload.repository,
        payloadFingerprint: observed.observation.payloadFingerprint,
        observation: observed.inserted ? 'inserted' : 'replayed',
        report: reportState,
      }));
    }

    const result = Object.freeze({
      schemaVersion: 1,
      observedAt,
      releasesInspected: releases.length,
      observationsInserted,
      observationsReplayed,
      reportsInserted,
      reportsReplayed,
      outcomes: Object.freeze(outcomes),
      runControl: Object.freeze({
        schemaVersion: 1,
        controllerDatabaseReadOnly: true,
        controllerReleasesClaimed: 0,
        controllerReleasesFinished: 0,
        githubReadsPerformed: false,
        githubWritesPerformed: false,
        shadowRowsInserted: observationsInserted + reportsInserted,
        shadowRowsReplayed: observationsReplayed + reportsReplayed,
      }),
    });
    return args.format === 'markdown'
      ? renderMarkdown(result)
      : `${JSON.stringify(result)}\n`;
  } finally {
    store.close();
    reader.close();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.stdout.write(runQueueTriageShadowCommand());
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? 'queue-triage-shadow-failed',
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}
