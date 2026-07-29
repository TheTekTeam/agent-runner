import {
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  dirname,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateAgentRunnerConfig } from './agent-runner-config.mjs';
import { EventControllerReleaseReader } from './agent-runner-event-controller.mjs';
import { GhCliGitHubReadClient } from './agent-runner-github-checks-provider.mjs';
import { collectQueueTriageGitHubEvidence } from './agent-runner-queue-triage-github-evidence.mjs';
import {
  buildQueueTriageParityCandidate,
  compareQueueTriageParity,
  normalizeQueueTriageParityCandidate,
  persistQueueTriageParity,
} from './agent-runner-queue-triage-parity.mjs';
import { planQueueTriageRun } from './agent-runner-queue-triage.mjs';
import {
  normalizeShadowRelease,
  QueueTriageShadowStore,
  validateShadowEvidenceIdentity,
} from './agent-runner-queue-triage-shadow-store.mjs';

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
    '    [--evidence <normalized-evidence.json> | --live-github --project-config <project.json>] \\',
    '    [--oversight <normalized-oversight.json>] [--format json|markdown]',
    '  node scripts/ops/agent-runner-queue-triage-shadow-command.mjs \\',
    '    --controller-db <path> --shadow-db <path> --pending [--limit 20] \\',
    '    [--format json|markdown]',
    '',
    'The controller database is captured as a stable private snapshot. Only GET GitHub reads are supported.',
    'Only the separate shadow database may change; release claims and GitHub writes are unavailable.',
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
    liveGithub: false,
    projectConfig: null,
    oversight: null,
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
    else if (arg === '--live-github') parsed.liveGithub = true;
    else if (arg === '--project-config') parsed.projectConfig = nextValue(arg);
    else if (arg.startsWith('--project-config=')) parsed.projectConfig = arg.slice('--project-config='.length);
    else if (arg === '--oversight') parsed.oversight = nextValue(arg);
    else if (arg.startsWith('--oversight=')) parsed.oversight = arg.slice('--oversight='.length);
    else if (arg === '--format') parsed.format = nextValue(arg);
    else if (arg.startsWith('--format=')) parsed.format = arg.slice('--format='.length);
    else if (arg === '--execute') throw new Error('--execute is not available in queue-triage shadow mode');
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (parsed.help) return Object.freeze(parsed);
  if (!parsed.controllerDb || !parsed.shadowDb) {
    throw new Error('--controller-db and --shadow-db are required');
  }
  if (Boolean(parsed.batchId) === Boolean(parsed.pending)) {
    throw new Error('choose exactly one of --release or --pending');
  }
  if (parsed.pending && (parsed.evidence || parsed.liveGithub || parsed.projectConfig || parsed.oversight)) {
    throw new Error('live evidence, supplied evidence and oversight require one explicit --release');
  }
  if (parsed.evidence && parsed.liveGithub) {
    throw new Error('choose either --evidence or --live-github');
  }
  if (parsed.liveGithub && !parsed.projectConfig) {
    throw new Error('--live-github requires --project-config');
  }
  if (parsed.projectConfig && !parsed.liveGithub) {
    throw new Error('--project-config requires --live-github');
  }
  if (parsed.oversight && !parsed.evidence && !parsed.liveGithub) {
    throw new Error('--oversight requires normalized or live evidence');
  }
  if (!['json', 'markdown'].includes(parsed.format)) {
    throw new Error('--format must be json or markdown');
  }
  return Object.freeze(parsed);
}

function canonicalCandidate(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const suffix = [basename(absolute)];
  let parent = dirname(absolute);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error(`unable to resolve shadow database parent: ${absolute}`);
    suffix.unshift(basename(parent));
    parent = next;
  }
  return resolve(realpathSync(parent), ...suffix);
}

function assertSeparateDatabases(controllerDb, shadowDb) {
  const controller = realpathSync(resolve(controllerDb));
  const shadow = canonicalCandidate(shadowDb);
  const forbidden = new Set([
    controller,
    `${controller}-wal`,
    `${controller}-shm`,
    `${controller}-journal`,
  ]);
  if (forbidden.has(shadow)) {
    throw new Error('--shadow-db must be separate from the controller database and its sidecars');
  }
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
    `- Parity inserted: ${result.parityInserted}`,
    `- Parity replayed: ${result.parityReplayed}`,
    `- Parity status: ${result.parityStatus ?? 'not-compared'}`,
    '',
    '## Outcomes',
    '',
  ];
  if (result.outcomes.length === 0) lines.push('- None.');
  for (const outcome of result.outcomes) {
    lines.push(
      `- ${outcome.repository} / ${outcome.batchId}: observation=${outcome.observation}, report=${outcome.report}, parity=${outcome.parity}`,
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
  readerFactory = (dbPath) => new EventControllerReleaseReader(dbPath),
  storeFactory = (dbPath) => new QueueTriageShadowStore(dbPath),
  projectValidator = validateAgentRunnerConfig,
  githubClientFactory = () => new GhCliGitHubReadClient(),
  collectLiveEvidence = collectQueueTriageGitHubEvidence,
  plan = planQueueTriageRun,
  buildParityCandidate = buildQueueTriageParityCandidate,
  normalizeParityCandidate = normalizeQueueTriageParityCandidate,
  compareParity = compareQueueTriageParity,
  persistParity = persistQueueTriageParity,
} = {}) {
  const args = parseQueueTriageShadowArgs(argv);
  if (args.help) return `${usage()}\n`;
  const controllerDb = resolve(args.controllerDb);
  const shadowDb = resolve(args.shadowDb);
  assertSeparateDatabases(controllerDb, shadowDb);
  const reader = readerFactory(controllerDb);
  let store = null;
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

    let evidence = null;
    if (args.evidence) evidence = JSON.parse(readFile(resolve(args.evidence), 'utf8'));
    if (args.liveGithub) {
      const projectConfig = projectValidator(JSON.parse(readFile(resolve(args.projectConfig), 'utf8')));
      evidence = collectLiveEvidence({
        release: releases[0],
        project: projectConfig,
        client: githubClientFactory(),
        observedAt,
      });
    }
    let dryRunReport = null;
    let agentCandidate = null;
    let oversightCandidate = null;
    let parityPreview = null;
    if (evidence) {
      const normalizedRelease = normalizeShadowRelease(releases[0]);
      validateShadowEvidenceIdentity(normalizedRelease, evidence);
      dryRunReport = plan(evidence);
    }
    if (args.oversight) {
      oversightCandidate = normalizeParityCandidate(JSON.parse(readFile(resolve(args.oversight), 'utf8')));
      agentCandidate = buildParityCandidate({ evidence, report: dryRunReport });
      parityPreview = compareParity(agentCandidate, oversightCandidate, { comparedAt: observedAt });
    }

    store = storeFactory(shadowDb);
    const outcomes = [];
    let observationsInserted = 0;
    let observationsReplayed = 0;
    let reportsInserted = 0;
    let reportsReplayed = 0;
    let parityInserted = 0;
    let parityReplayed = 0;
    let parityStatus = null;

    for (const release of releases) {
      const observed = store.observeRelease(release, { observedAt });
      observationsInserted += observed.inserted ? 1 : 0;
      observationsReplayed += observed.replayed ? 1 : 0;
      let reportState = 'none';
      let parityState = 'none';
      if (evidence) {
        const planned = store.attachEvidenceAndPlan(release, evidence, { plannedAt: observedAt });
        reportsInserted += planned.inserted ? 1 : 0;
        reportsReplayed += planned.replayed ? 1 : 0;
        reportState = planned.inserted ? 'inserted' : 'replayed';
        if (oversightCandidate) {
          const persisted = persistParity({
            db: store.db,
            releaseId: release.batchId,
            agentCandidate: buildParityCandidate({ evidence, report: planned.report }),
            oversightCandidate,
            comparedAt: observedAt,
          });
          parityInserted += persisted.inserted ? 1 : 0;
          parityReplayed += persisted.replayed ? 1 : 0;
          parityStatus = persisted.result.status;
          parityState = persisted.inserted ? 'inserted' : 'replayed';
        }
      }
      outcomes.push(Object.freeze({
        batchId: release.batchId,
        projectId: release.payload.projectId,
        repository: release.payload.repository,
        payloadFingerprint: observed.observation.payloadFingerprint,
        observation: observed.inserted ? 'inserted' : 'replayed',
        report: reportState,
        parity: parityState,
      }));
    }

    const liveComplete = evidence?.liveEvidence?.queryComplete;
    const result = Object.freeze({
      schemaVersion: 1,
      observedAt,
      releasesInspected: releases.length,
      observationsInserted,
      observationsReplayed,
      reportsInserted,
      reportsReplayed,
      parityInserted,
      parityReplayed,
      parityStatus: parityStatus ?? parityPreview?.status ?? null,
      outcomes: Object.freeze(outcomes),
      runControl: Object.freeze({
        schemaVersion: 1,
        controllerDatabaseReadOnly: true,
        controllerReleasesClaimed: 0,
        controllerReleasesFinished: 0,
        githubReadsPerformed: args.liveGithub,
        githubReadOnly: args.liveGithub,
        githubWritesPerformed: false,
        liveEvidenceComplete: typeof liveComplete === 'boolean' ? liveComplete : null,
        parityCompared: Boolean(args.oversight),
        parityMatch: parityStatus === 'match',
        mutationAllowed: false,
        shadowRowsInserted: observationsInserted + reportsInserted + parityInserted,
        shadowRowsReplayed: observationsReplayed + reportsReplayed + parityReplayed,
      }),
    });
    return args.format === 'markdown'
      ? renderMarkdown(result)
      : `${JSON.stringify(result)}\n`;
  } finally {
    store?.close();
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
