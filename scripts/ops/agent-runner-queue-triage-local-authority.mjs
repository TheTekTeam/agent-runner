import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EventControllerReleaseReader } from './agent-runner-event-controller.mjs';
import { GhCliGitHubReadClient } from './agent-runner-github-checks-provider.mjs';
import { loadProjectRegistry } from './agent-runner-project-registry.mjs';
import { parsePollingControllerOptions } from './agent-runner-polling-controller-cycle.mjs';
import { runPollingControllerSummaryCommand } from './agent-runner-polling-controller-summary.mjs';
import { GhCliGitHubWriteClient } from './agent-runner-queue-triage-github-write.mjs';
import { runQueueTriageReleaseExecutor } from './agent-runner-queue-triage-executor.mjs';

export const QUEUE_TRIAGE_LOCAL_AUTHORITY_SCHEMA_VERSION = 1;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function boundedInteger(value, fallback, { name, min, max }) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function authorityFingerprintInput(authority) {
  return {
    schemaVersion: QUEUE_TRIAGE_LOCAL_AUTHORITY_SCHEMA_VERSION,
    enabled: authority.enabled,
    revision: authority.revision,
    sourceSha: authority.sourceSha.toLowerCase(),
    projectIds: [...authority.projectIds].sort(),
    maxReleasesPerCycle: authority.maxReleasesPerCycle,
  };
}

export function computeQueueTriageLocalAuthorityFingerprint(authority) {
  return sha256(stableJson(authorityFingerprintInput(authority)));
}

export function normalizeQueueTriageLocalAuthority(input) {
  if (!isObject(input)) throw new Error('queue-triage local authority must be an object');
  if (input.schemaVersion !== QUEUE_TRIAGE_LOCAL_AUTHORITY_SCHEMA_VERSION) {
    throw new Error('queue-triage local authority schemaVersion must equal 1');
  }
  if (typeof input.enabled !== 'boolean') throw new Error('queue-triage local authority enabled must be boolean');
  if (typeof input.revision !== 'string' || input.revision.trim().length === 0 || input.revision.length > 255) {
    throw new Error('queue-triage local authority revision is required');
  }
  if (!SHA_PATTERN.test(input.sourceSha ?? '')) throw new Error('queue-triage local authority sourceSha is invalid');
  if (!Array.isArray(input.projectIds) || input.projectIds.length === 0 || input.projectIds.length > 50
    || input.projectIds.some((value) => typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value))) {
    throw new Error('queue-triage local authority projectIds are invalid');
  }
  const projectIds = [...new Set(input.projectIds)].sort();
  if (projectIds.length !== input.projectIds.length) throw new Error('queue-triage local authority projectIds contain duplicates');
  const authority = Object.freeze({
    schemaVersion: QUEUE_TRIAGE_LOCAL_AUTHORITY_SCHEMA_VERSION,
    enabled: input.enabled,
    revision: input.revision,
    sourceSha: input.sourceSha.toLowerCase(),
    projectIds: Object.freeze(projectIds),
    maxReleasesPerCycle: boundedInteger(input.maxReleasesPerCycle, 20, {
      name: 'queue-triage local authority maxReleasesPerCycle', min: 1, max: 20,
    }),
    fingerprint: String(input.fingerprint ?? '').toLowerCase(),
  });
  if (!FINGERPRINT_PATTERN.test(authority.fingerprint)) {
    throw new Error('queue-triage local authority fingerprint is invalid');
  }
  const expected = computeQueueTriageLocalAuthorityFingerprint(authority);
  if (authority.fingerprint !== expected) throw new Error('queue-triage local authority fingerprint mismatch');
  return authority;
}

export function loadQueueTriageLocalAuthority(authorityPath, {
  readFile = readFileSync,
} = {}) {
  if (typeof authorityPath !== 'string' || authorityPath.length === 0) return null;
  const path = resolve(authorityPath);
  let parsed;
  try {
    parsed = JSON.parse(readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error(`invalid queue-triage local authority JSON at ${path}: ${error.message}`);
    throw error;
  }
  return normalizeQueueTriageLocalAuthority(parsed);
}

function publicExecutionOutcome(result, release) {
  return Object.freeze({
    batchId: release.batchId,
    projectId: release.payload.projectId,
    repository: release.payload.repository,
    status: result?.status ?? 'unknown',
    mutationsAttempted: result?.runControl?.mutationsAttempted ?? 0,
    mutationsVerified: result?.runControl?.mutationsVerified ?? 0,
  });
}

function runControl({ status, inspected, eligible, processed, failed, writes, verified, fallbackPerformed }) {
  return Object.freeze({
    schemaVersion: 1,
    status,
    pendingSweepPerformed: true,
    fallbackPerformed,
    releasesInspected: inspected,
    releasesEligible: eligible,
    releasesProcessed: processed,
    releasesFailed: failed,
    githubWritesPerformed: writes > 0,
    mutationsAttempted: writes,
    mutationsVerified: verified,
    systemdChanged: false,
    scheduledTaskChanged: false,
  });
}

export function runQueueTriageLocalAuthorityCycle({
  controllerDb,
  registry,
  authority,
  sourceSha,
  execute = false,
  fallbackPerformed = false,
  observedAt = new Date().toISOString(),
  readerFactory = (path) => new EventControllerReleaseReader(path),
  executor = runQueueTriageReleaseExecutor,
  readClient = null,
  writeClient = null,
} = {}) {
  if (typeof controllerDb !== 'string' || controllerDb.length === 0) throw new Error('controllerDb is required');
  if (!registry?.projectsById || !Array.isArray(registry.projects)) throw new Error('validated project registry is required');
  if (authority == null || authority.enabled !== true) {
    return Object.freeze({
      schemaVersion: 1,
      observedAt,
      status: 'disabled',
      authority: null,
      outcomes: Object.freeze([]),
      runControl: runControl({ status: 'disabled', inspected: 0, eligible: 0, processed: 0, failed: 0, writes: 0, verified: 0, fallbackPerformed }),
    });
  }
  if (!SHA_PATTERN.test(sourceSha ?? '') || sourceSha.toLowerCase() !== authority.sourceSha) {
    throw new Error('queue-triage local authority source SHA mismatch');
  }
  if (execute !== true) {
    return Object.freeze({
      schemaVersion: 1,
      observedAt,
      status: 'dry-run',
      authority: Object.freeze({ revision: authority.revision, fingerprint: authority.fingerprint }),
      outcomes: Object.freeze([]),
      runControl: runControl({ status: 'dry-run', inspected: 0, eligible: 0, processed: 0, failed: 0, writes: 0, verified: 0, fallbackPerformed }),
    });
  }

  const reader = readerFactory(resolve(controllerDb));
  let releases;
  try {
    releases = reader.listReleases({ states: ['pending'], limit: authority.maxReleasesPerCycle });
  } finally {
    reader.close();
  }

  const outcomes = [];
  let eligible = 0;
  let processed = 0;
  let failed = 0;
  let writes = 0;
  let verified = 0;

  for (const release of releases) {
    const projectId = release?.payload?.projectId;
    const repository = release?.payload?.repository;
    const project = registry.projectsById[projectId] ?? null;
    if (!project || project.queueTriage?.enabled !== true || !authority.projectIds.includes(projectId)
      || String(project.githubRepo).toLowerCase() !== String(repository).toLowerCase()) {
      continue;
    }
    eligible += 1;
    const result = executor({
      controllerDb: resolve(controllerDb),
      releaseId: release.batchId,
      project,
      managerAuthority: { revision: authority.revision, fingerprint: authority.fingerprint },
      readClient: readClient ?? new GhCliGitHubReadClient(),
      writeClient: writeClient ?? new GhCliGitHubWriteClient(),
      observedAt,
    });
    const outcome = publicExecutionOutcome(result, release);
    outcomes.push(outcome);
    writes += outcome.mutationsAttempted;
    verified += outcome.mutationsVerified;
    if (outcome.status === 'processed' || outcome.status === 'already-terminal') {
      processed += outcome.status === 'processed' ? 1 : 0;
      continue;
    }
    failed += 1;
    break;
  }

  const status = failed > 0 ? 'failed' : 'completed';
  return Object.freeze({
    schemaVersion: 1,
    observedAt,
    status,
    authority: Object.freeze({
      revision: authority.revision,
      fingerprint: authority.fingerprint,
      sourceSha: authority.sourceSha,
      projectIds: authority.projectIds,
    }),
    outcomes: Object.freeze(outcomes),
    runControl: runControl({
      status,
      inspected: releases.length,
      eligible,
      processed,
      failed,
      writes,
      verified,
      fallbackPerformed,
    }),
  });
}

function takeOption(argv, name) {
  const remaining = [];
  let value = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${name} requires a value`);
      value = next;
      index += 1;
    } else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
    else remaining.push(arg);
  }
  return { value, remaining };
}

export function parseClosedLoopOptions(argv = [], env = process.env) {
  const authority = takeOption(argv, '--queue-triage-authority');
  const source = takeOption(authority.remaining, '--queue-triage-source-sha');
  const execute = source.remaining.includes('--execute');
  const pollingArgv = source.remaining.filter((arg) => arg !== '--execute');
  if (pollingArgv.some((arg) => ['--pending', '--all-enabled'].includes(arg))) {
    throw new Error('unbounded queue-triage aliases are unavailable');
  }
  return Object.freeze({
    authorityPath: authority.value ?? env.AGENT_RUNNER_QUEUE_TRIAGE_AUTHORITY ?? null,
    sourceSha: source.value ?? env.AGENT_RUNNER_QUEUE_TRIAGE_SOURCE_SHA ?? null,
    execute,
    pollingArgv: Object.freeze(pollingArgv),
  });
}

export async function runClosedLoopCycle({
  argv = process.argv.slice(2),
  env = process.env,
  observedAt = new Date().toISOString(),
  runPolling = runPollingControllerSummaryCommand,
  parsePolling = parsePollingControllerOptions,
  loadRegistry = loadProjectRegistry,
  loadAuthority = loadQueueTriageLocalAuthority,
  runTriage = runQueueTriageLocalAuthorityCycle,
  readClientFactory = () => new GhCliGitHubReadClient({ env }),
  writeClientFactory = () => new GhCliGitHubWriteClient({ env }),
} = {}) {
  if (argv.includes('--help')) {
    return Object.freeze({
      help: [
        'Usage: node scripts/ops/agent-runner-queue-triage-local-authority.mjs --project-registry <path> [polling options] [--execute]',
        '',
        'Optional local-authority inputs:',
        '  --queue-triage-authority <path>',
        '  --queue-triage-source-sha <exact checkout SHA>',
        '',
        'Without a valid enabled authority file the cycle remains read-only after polling/settlement.',
      ].join('\n'),
    });
  }
  const options = parseClosedLoopOptions(argv, env);
  const polling = await runPolling({ argv: options.pollingArgv, env, observedAt });
  const pollingOptions = parsePolling(options.pollingArgv, env);
  const registry = loadRegistry({ registryPath: pollingOptions.registryPath });
  const authority = loadAuthority(options.authorityPath);
  const triage = runTriage({
    controllerDb: pollingOptions.dbPath,
    registry,
    authority,
    sourceSha: options.sourceSha,
    execute: options.execute,
    fallbackPerformed: true,
    observedAt,
    readClient: readClientFactory(),
    writeClient: writeClientFactory(),
  });
  return Object.freeze({
    schemaVersion: 1,
    observedAt,
    polling,
    triage,
    runControl: Object.freeze({
      schemaVersion: 1,
      pollingCompleted: true,
      fallbackPerformed: true,
      queueTriageStatus: triage.status,
      githubWritesPerformed: triage.runControl.githubWritesPerformed,
      mutationsAttempted: triage.runControl.mutationsAttempted,
      mutationsVerified: triage.runControl.mutationsVerified,
      systemdChanged: false,
      scheduledTaskChanged: false,
    }),
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runClosedLoopCycle().then((result) => {
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: typeof error?.code === 'string' ? error.code : 'closed-loop-cycle-failed',
      message: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}
