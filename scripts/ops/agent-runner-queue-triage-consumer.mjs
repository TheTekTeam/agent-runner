import { randomUUID } from 'node:crypto';

import { EventControllerReleaseStore } from './agent-runner-event-controller.mjs';
import { collectQueueTriageGitHubEvidence } from './agent-runner-queue-triage-github-evidence.mjs';
import { evidenceFingerprint, planQueueTriageRun, stableJson } from './agent-runner-queue-triage.mjs';

export const QUEUE_TRIAGE_CONSUMER_SCHEMA_VERSION = 1;
const MAX_TERMINAL_RESULT_BYTES = 64 * 1024;
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const FORBIDDEN_RESULT_KEYS = new Set([
  'body',
  'commentBody',
  'rawPayload',
  'providerOutput',
  'prompt',
  'secret',
  'token',
  'claimToken',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalTimestamp(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date.toISOString();
}

function boundedInteger(value, fallback, { name, min, max }) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function boundedCode(value, fallback = 'queue-triage-consumption-failed') {
  const candidate = typeof value === 'string' ? value : fallback;
  return /^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(candidate) ? candidate : fallback;
}

function codedError(code, message, { preserveClaim = false } = {}) {
  const error = new Error(message);
  error.code = code;
  error.preserveClaim = preserveClaim;
  return error;
}

function assertNoForbiddenKeys(value, path = 'result') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.has(key)) throw new Error(`${path}.${key} is forbidden`);
    assertNoForbiddenKeys(entry, `${path}.${key}`);
  }
}

function boundedTerminalResult(value) {
  assertNoForbiddenKeys(value);
  const json = stableJson(value);
  if (Buffer.byteLength(json) > MAX_TERMINAL_RESULT_BYTES) {
    throw new Error('queue-triage terminal result exceeds the bounded size');
  }
  return Object.freeze(JSON.parse(json));
}

function normalizeProject(project) {
  if (!isObject(project) || !nonEmpty(project.projectId)) {
    throw new Error('validated project config is required');
  }
  const repository = project.githubRepo ?? project.repository;
  if (!nonEmpty(repository) || !repository.includes('/')) {
    throw new Error('validated project repository is required');
  }
  return Object.freeze({ projectId: project.projectId, repository });
}

function releaseIdentity(release) {
  if (!isObject(release) || !nonEmpty(release.batchId) || !isObject(release.payload)) {
    throw new Error('controller release identity is invalid');
  }
  const payload = release.payload;
  return Object.freeze({
    batchId: release.batchId,
    projectId: payload.projectId,
    repository: payload.repository,
    objectKind: payload.objectKind,
    objectNumber: payload.objectNumber ?? null,
    payloadFingerprint: evidenceFingerprint(payload),
  });
}

function assertReleaseProject(release, project) {
  const identity = releaseIdentity(release);
  if (identity.projectId !== project.projectId
    || String(identity.repository).toLowerCase() !== project.repository.toLowerCase()) {
    throw codedError('release-project-mismatch', 'controller release does not match the validated project');
  }
  if (!['issue', 'pull_request'].includes(identity.objectKind)) {
    throw codedError('release-object-unsupported', 'queue-triage consumption requires an issue or pull-request release');
  }
  if (!Number.isInteger(identity.objectNumber) || identity.objectNumber < 1) {
    throw codedError('release-object-invalid', 'controller release object identity is invalid');
  }
  return identity;
}

function evidenceRelease(release) {
  return Object.freeze({
    batchId: release.batchId,
    state: 'pending',
    releasedAt: release.releasedAt,
    updatedAt: release.updatedAt,
    payload: release.payload,
    result: release.result ?? {},
  });
}

function consumerRunControl({ status, claimed, finished, githubReadsPerformed }) {
  return Object.freeze({
    schemaVersion: 1,
    status,
    controllerDatabaseMutated: claimed > 0 || finished > 0,
    releasesClaimed: claimed,
    releasesFinished: finished,
    githubReadsPerformed,
    githubReadOnly: true,
    githubWritesPerformed: false,
    actionPlansExecuted: 0,
    mutationAllowed: false,
    systemdChanged: false,
    scheduledTaskChanged: false,
  });
}

function terminalNoop(release, identity) {
  return Object.freeze({
    schemaVersion: QUEUE_TRIAGE_CONSUMER_SCHEMA_VERSION,
    status: 'already-terminal',
    release: Object.freeze({ ...identity, state: release.state }),
    terminalResultFingerprint: evidenceFingerprint(release.result ?? {}),
    runControl: consumerRunControl({
      status: 'already-terminal',
      claimed: 0,
      finished: 0,
      githubReadsPerformed: false,
    }),
  });
}

function processedTerminalResult({ identity, evidence, report, observedAt }) {
  return boundedTerminalResult({
    schemaVersion: QUEUE_TRIAGE_CONSUMER_SCHEMA_VERSION,
    kind: 'queue-triage-consumption',
    state: 'processed',
    processedAt: observedAt,
    release: identity,
    evidence: {
      fingerprint: evidenceFingerprint(evidence),
      liveFingerprint: evidence.liveEvidence.fingerprint,
      queryComplete: true,
    },
    report: {
      fingerprint: evidenceFingerprint(report),
      inspected: report.inspected,
      actionPlanCount: report.actionPlans.length,
      exceptionCount: report.exceptions.length,
      completionState: 'planned-no-execution',
    },
    runControl: consumerRunControl({
      status: 'processed',
      claimed: 1,
      finished: 1,
      githubReadsPerformed: true,
    }),
  });
}

function failedTerminalResult({ identity, observedAt, code, stage, githubReadsPerformed }) {
  return boundedTerminalResult({
    schemaVersion: QUEUE_TRIAGE_CONSUMER_SCHEMA_VERSION,
    kind: 'queue-triage-consumption',
    state: 'failed',
    processedAt: observedAt,
    release: identity,
    failure: {
      code: boundedCode(code),
      stage: boundedCode(stage, 'processing'),
    },
    runControl: consumerRunControl({
      status: 'failed',
      claimed: 1,
      finished: 1,
      githubReadsPerformed,
    }),
  });
}

function publicResult(release, terminalResult) {
  return Object.freeze({
    schemaVersion: QUEUE_TRIAGE_CONSUMER_SCHEMA_VERSION,
    status: terminalResult.state,
    release: Object.freeze({ ...terminalResult.release, state: release.state }),
    terminalResult,
    runControl: terminalResult.runControl,
  });
}

export function runQueueTriageReleaseConsumer({
  controllerDb,
  releaseId,
  project,
  client,
  claimToken = `queue-triage-${randomUUID()}`,
  leaseMs = 5 * 60_000,
  observedAt = new Date().toISOString(),
  storeFactory = (dbPath) => new EventControllerReleaseStore(dbPath),
  collectEvidence = collectQueueTriageGitHubEvidence,
  plan = planQueueTriageRun,
  afterClaim = null,
} = {}) {
  if (!nonEmpty(controllerDb)) throw new Error('controllerDb is required');
  if (!nonEmpty(releaseId)) throw new Error('releaseId is required');
  if (!CLAIM_TOKEN_PATTERN.test(claimToken)) throw new Error('claimToken is invalid');
  const boundedLeaseMs = boundedInteger(leaseMs, 5 * 60_000, {
    name: 'leaseMs', min: 1_000, max: 60 * 60_000,
  });
  const timestamp = canonicalTimestamp(observedAt, 'observedAt');
  const normalizedProject = normalizeProject(project);
  if (!client || typeof client.requestJson !== 'function') throw new Error('GET-only GitHub read client is required');

  const store = storeFactory(controllerDb);
  let claimedByThisRun = false;
  let identity = null;
  let stage = 'pre-claim';
  let githubReadsPerformed = false;

  try {
    const current = store.getRelease(releaseId);
    if (!current) throw codedError('release-not-found', `controller release not found: ${releaseId}`);
    identity = assertReleaseProject(current, normalizedProject);
    if (['processed', 'failed'].includes(current.state)) return terminalNoop(current, identity);
    if (current.state === 'claimed') {
      throw codedError('release-already-claimed', `controller release is already claimed: ${releaseId}`);
    }
    if (current.state !== 'pending') {
      throw codedError('release-not-claimable', `controller release is not claimable from state ${String(current.state)}`);
    }

    stage = 'claim';
    const claimed = store.claimRelease(releaseId, {
      claimToken,
      leaseMs: boundedLeaseMs,
      now: timestamp,
    });
    if (!claimed) {
      const replacement = store.getRelease(releaseId);
      if (replacement && ['processed', 'failed'].includes(replacement.state)) {
        return terminalNoop(replacement, assertReleaseProject(replacement, normalizedProject));
      }
      throw codedError('release-claim-conflict', `controller release claim was not acquired: ${releaseId}`);
    }
    claimedByThisRun = true;
    identity = assertReleaseProject(claimed, normalizedProject);

    if (typeof afterClaim === 'function') afterClaim(Object.freeze({ release: claimed, claimToken }));

    stage = 'live-evidence';
    githubReadsPerformed = true;
    const evidence = collectEvidence({
      release: evidenceRelease(claimed),
      project,
      client,
      observedAt: timestamp,
    });
    if (evidence?.liveEvidence?.queryComplete !== true) {
      throw codedError('live-evidence-incomplete', 'live GitHub evidence is incomplete');
    }

    stage = 'planning';
    const report = plan(evidence);
    if (!isObject(report) || report.releaseId !== releaseId) {
      throw codedError('triage-report-identity-mismatch', 'queue-triage report identity does not match the claimed release');
    }

    stage = 'pre-finish-recheck';
    const beforeFinish = store.getRelease(releaseId);
    if (!beforeFinish || beforeFinish.state !== 'claimed' || beforeFinish.claimToken !== claimToken) {
      throw codedError('release-ownership-lost', 'controller release ownership changed before finish', { preserveClaim: true });
    }
    const beforeFinishIdentity = assertReleaseProject(beforeFinish, normalizedProject);
    if (beforeFinishIdentity.payloadFingerprint !== identity.payloadFingerprint) {
      throw codedError('release-identity-changed', 'controller release identity changed before finish', { preserveClaim: true });
    }

    stage = 'finish-processed';
    const terminalResult = processedTerminalResult({ identity, evidence, report, observedAt: timestamp });
    const finished = store.finishRelease(releaseId, {
      claimToken,
      state: 'processed',
      result: terminalResult,
      now: timestamp,
    });
    if (!finished) {
      throw codedError('release-finish-conflict', 'controller release could not be finished with the exact claim token', { preserveClaim: true });
    }
    return publicResult(finished, terminalResult);
  } catch (error) {
    if (!claimedByThisRun || error?.preserveClaim === true) throw error;

    const owned = store.getRelease(releaseId);
    if (!owned || owned.state !== 'claimed' || owned.claimToken !== claimToken) {
      throw codedError('release-ownership-lost', 'controller release ownership changed while recording failure', { preserveClaim: true });
    }

    const terminalResult = failedTerminalResult({
      identity,
      observedAt: timestamp,
      code: error?.code,
      stage,
      githubReadsPerformed,
    });
    const finished = store.finishRelease(releaseId, {
      claimToken,
      state: 'failed',
      result: terminalResult,
      now: timestamp,
    });
    if (!finished) {
      throw codedError('release-failure-finish-conflict', 'controller release failure could not be persisted with the exact claim token', { preserveClaim: true });
    }
    return publicResult(finished, terminalResult);
  } finally {
    store.close?.();
  }
}

export function renderQueueTriageConsumptionMarkdown(result) {
  const lines = [
    '# Agent Runner queue-triage release consumption',
    '',
    `- Status: \`${result.status}\``,
    `- Release: \`${result.release.batchId}\``,
    `- Project: \`${result.release.projectId}\``,
    `- Repository: \`${result.release.repository}\``,
    `- Object: \`${result.release.objectKind}#${result.release.objectNumber}\``,
    `- Controller state: \`${result.release.state}\``,
    '',
    '## RUN_CONTROL',
    '',
    '```json',
    JSON.stringify(result.runControl),
    '```',
  ];
  return `${lines.join('\n')}\n`;
}
