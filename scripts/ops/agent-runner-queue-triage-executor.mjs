import { randomUUID } from 'node:crypto';

import { EventControllerReleaseStore } from './agent-runner-event-controller.mjs';
import { collectQueueTriageGitHubEvidence } from './agent-runner-queue-triage-github-evidence.mjs';
import { evidenceFingerprint, planQueueTriageRun, stableJson } from './agent-runner-queue-triage.mjs';

export const QUEUE_TRIAGE_EXECUTION_SCHEMA_VERSION = 1;
const MAX_RESULT_BYTES = 64 * 1024;
const CLAIM_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const ACTIONS = new Set(['replace_labels', 'close_issue']);
const REASONS = new Set([
  'conflicting-status-labels', 'status-reconciliation',
  'conflicting-priority-labels', 'priority-alignment',
  'conflicting-agent-labels', 'agent-alignment',
  'merged-completion-settled',
]);
const FORBIDDEN_KEYS = new Set([
  'body', 'commentBody', 'rawPayload', 'providerOutput', 'prompt', 'secret', 'token', 'claimToken',
]);

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;

function iso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date.toISOString();
}

function integer(value, fallback, { name, min, max }) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function error(code, message, options = {}) {
  const result = new Error(message);
  result.code = code;
  result.preserveClaim = options.preserveClaim === true;
  result.outcome = options.outcome ?? null;
  return result;
}

function boundedCode(value, fallback = 'queue-triage-execution-failed') {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(value) ? value : fallback;
}

function stringArray(value, name, { allowEmpty = true, max = 100 } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > max
    || value.some((entry) => !text(entry) || entry.length > 255)) throw new Error(`${name} is invalid`);
  if (new Set(value).size !== value.length) throw new Error(`${name} contains duplicates`);
  return Object.freeze([...value].sort());
}

function assertSafe(value, path = 'result') {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertSafe(entry, `${path}[${index}]`));
  if (!object(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${path}.${key} is forbidden`);
    assertSafe(entry, `${path}.${key}`);
  }
}

function boundedResult(value) {
  assertSafe(value);
  const json = stableJson(value);
  if (Buffer.byteLength(json) > MAX_RESULT_BYTES) throw new Error('terminal result exceeds bounded size');
  return Object.freeze(JSON.parse(json));
}

function authority(value) {
  if (!object(value) || !text(value.revision) || !SHA256.test(value.fingerprint || '')) {
    throw new Error('current manager revision and sha256 fingerprint are required');
  }
  return Object.freeze({ revision: value.revision, fingerprint: value.fingerprint.toLowerCase() });
}

function projectConfig(project) {
  const repository = project?.githubRepo ?? project?.repository;
  if (!object(project) || !text(project.projectId) || !text(repository) || !repository.includes('/')) {
    throw new Error('validated project config is required');
  }
  if (project.queueTriage?.enabled !== true) throw error('queue-triage-disabled', 'enabled project policy required');
  const maxMutations = integer(project.queueTriage.maxMutations, 0, { name: 'maxMutations', min: 0, max: 3 });
  if (maxMutations < 1) throw error('queue-triage-mutations-disabled', 'project permits no mutations');
  const requiredLabels = [
    ...Object.values(project.statusLabels ?? {}).filter(text),
    ...(project.priorityLabelRanking ?? []).filter(text),
    ...(project.acceptedAgentLabels ?? []).filter(text),
  ];
  return Object.freeze({
    projectId: project.projectId,
    repository,
    maxMutations,
    requiredLabels: Object.freeze([...new Set(requiredLabels)].sort()),
  });
}

function releaseIdentity(release) {
  if (!object(release) || !text(release.batchId) || !object(release.payload)) {
    throw new Error('controller release identity is invalid');
  }
  return Object.freeze({
    batchId: release.batchId,
    projectId: release.payload.projectId,
    repository: release.payload.repository,
    objectKind: release.payload.objectKind,
    objectNumber: release.payload.objectNumber ?? null,
    payloadFingerprint: evidenceFingerprint(release.payload),
  });
}

function assertRelease(release, project) {
  const identity = releaseIdentity(release);
  if (identity.projectId !== project.projectId
    || String(identity.repository).toLowerCase() !== project.repository.toLowerCase()) {
    throw error('release-project-mismatch', 'release does not match project');
  }
  if (!['issue', 'pull_request'].includes(identity.objectKind)
    || !Number.isInteger(identity.objectNumber) || identity.objectNumber < 1) {
    throw error('release-object-invalid', 'release object identity is invalid');
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

function actionPlan(plan, project) {
  if (!object(plan) || plan.schemaVersion !== 1 || plan.projectId !== project.projectId
    || String(plan.repository).toLowerCase() !== project.repository.toLowerCase()
    || !['issue', 'pull_request'].includes(plan.kind) || !Number.isInteger(plan.number) || plan.number < 1
    || !ACTIONS.has(plan.action) || plan.risk !== 'low-mechanical'
    || !text(plan.idempotencyKey) || !SHA256.test(plan.evidenceFingerprint || '')) {
    throw error('action-plan-invalid', 'action plan is invalid');
  }
  const exactBefore = Object.freeze({
    labels: stringArray(plan.exactBefore?.labels ?? [], 'exactBefore.labels'),
    updatedAt: iso(plan.exactBefore?.updatedAt, 'exactBefore.updatedAt'),
  });
  const reasons = stringArray(plan.reasons ?? [], 'reasons', { allowEmpty: false, max: 10 });
  if (reasons.some((reason) => !REASONS.has(reason))) throw error('action-reason-invalid', 'reason not allowlisted');
  let intendedLabels = null;
  if (plan.action === 'replace_labels') {
    intendedLabels = stringArray(plan.intendedFullLabelSet ?? [], 'intendedFullLabelSet');
    if (plan.expectedPostWriteState?.state !== 'open') throw error('action-post-state-invalid', 'label post-state invalid');
  } else if (plan.kind !== 'issue' || plan.intendedFullLabelSet !== null
    || plan.expectedPostWriteState?.state !== 'closed'
    || plan.expectedPostWriteState?.stateReason !== 'completed') {
    throw error('close-action-invalid', 'close action invalid');
  }
  return Object.freeze({
    projectId: plan.projectId,
    repository: plan.repository,
    kind: plan.kind,
    number: plan.number,
    exactBefore,
    action: plan.action,
    intendedLabels,
    reasons,
    idempotencyKey: plan.idempotencyKey,
    evidenceFingerprint: plan.evidenceFingerprint.toLowerCase(),
  });
}

function executionPlan(report, project) {
  if (!object(report) || report.schemaVersion !== 1 || report.mode !== 'release' || !text(report.releaseId)
    || report.project?.projectId !== project.projectId
    || String(report.project?.repository).toLowerCase() !== project.repository.toLowerCase()) {
    throw error('triage-report-invalid', 'report identity invalid');
  }
  if (!Array.isArray(report.actionPlans) || report.actionPlans.length > project.maxMutations) {
    throw error('mutation-limit-exceeded', 'report exceeds mutation limit');
  }
  const plans = report.actionPlans.map((plan) => actionPlan(plan, project));
  const targets = new Set();
  for (const plan of plans) {
    const key = `${plan.repository.toLowerCase()}#${plan.number}`;
    if (targets.has(key)) throw error('duplicate-action-target', 'duplicate action target');
    targets.add(key);
  }
  const overflow = Object.freeze({ ...(report.overflow ?? {}) });
  if (plans.length + Number(overflow.proposedMutations ?? 0) > 5) {
    throw error('repeated-corruption-stop', 'more than five mutation candidates');
  }
  const exceptions = Object.freeze(Array.isArray(report.exceptions) ? report.exceptions : []);
  return Object.freeze({
    releaseId: report.releaseId,
    plans: Object.freeze(plans),
    exceptions,
    overflow,
    fingerprint: evidenceFingerprint({ releaseId: report.releaseId, project: report.project, plans, exceptions, overflow }),
  });
}

function labels(payload) {
  if (!Array.isArray(payload?.labels) || payload.labels.length > 100) throw error('object-labels-invalid', 'labels malformed');
  return stringArray(payload.labels.map((item) => typeof item === 'string' ? item : item?.name).filter(Boolean), 'labels');
}

function snapshot(payload, plan) {
  if (!object(payload) || !['open', 'closed'].includes(payload.state) || !text(payload.updated_at)) {
    throw error('object-snapshot-invalid', 'object snapshot malformed');
  }
  if ((plan.kind === 'pull_request') !== object(payload.pull_request)) throw error('object-kind-mismatch', 'object kind changed');
  return Object.freeze({
    state: payload.state,
    stateReason: payload.state_reason ?? null,
    labels: labels(payload),
    updatedAt: iso(payload.updated_at, 'updated_at'),
  });
}

const endpoint = (repository, number) => `/repos/${repository}/issues/${number}`;
const readObject = (client, plan) => snapshot(client.requestJson(endpoint(plan.repository, plan.number)), plan);

function assertBefore(plan, current) {
  if (stableJson(plan.exactBefore.labels) !== stableJson(current.labels)
    || plan.exactBefore.updatedAt !== current.updatedAt || current.state !== 'open') {
    throw error('pre-write-snapshot-changed', 'object changed after planning');
  }
}

function verified(plan, current) {
  return plan.action === 'replace_labels'
    ? current.state === 'open' && stableJson(current.labels) === stableJson(plan.intendedLabels)
    : current.state === 'closed' && current.stateReason === 'completed';
}

function repositoryLabels(client, repository) {
  const names = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = client.requestJson(`/repos/${repository}/labels`, { per_page: 100, page });
    if (!Array.isArray(payload)) throw error('label-definitions-invalid', 'labels response malformed');
    for (const label of payload) {
      if (!text(label?.name)) throw error('label-definitions-invalid', 'label definition malformed');
      names.push(label.name);
    }
    if (payload.length < 100) return new Set(names);
  }
  throw error('label-definitions-incomplete', 'label definitions exceed page limit');
}

function assertLabelDefinitions(client, project, plans) {
  const existing = repositoryLabels(client, project.repository);
  const required = new Set(project.requiredLabels);
  for (const plan of plans) {
    plan.exactBefore.labels.forEach((label) => required.add(label));
    (plan.intendedLabels ?? []).forEach((label) => required.add(label));
  }
  if ([...required].some((label) => !existing.has(label))) throw error('label-definitions-missing', 'required labels missing');
}

function runControl(status, claimed, finished, reads, attempted, checked) {
  return Object.freeze({
    schemaVersion: 1,
    status,
    controllerDatabaseMutated: claimed > 0 || finished > 0,
    releasesClaimed: claimed,
    releasesFinished: finished,
    githubReadsPerformed: reads,
    githubReadOnly: false,
    githubWritesPerformed: attempted > 0,
    mutationsAttempted: attempted,
    mutationsVerified: checked,
    actionPlansExecuted: checked,
    mutationAllowed: true,
    pendingSweepPerformed: false,
    fallbackPerformed: false,
    systemdChanged: false,
    scheduledTaskChanged: false,
  });
}

function terminalNoop(release, identity) {
  return Object.freeze({
    schemaVersion: 1,
    status: 'already-terminal',
    release: Object.freeze({ ...identity, state: release.state }),
    terminalResultFingerprint: evidenceFingerprint(release.result ?? {}),
    runControl: runControl('already-terminal', 0, 0, false, 0, 0),
  });
}

function terminalResult({ state, identity, manager, observedAt, evidence, plan, failure, outcomes, reads, attempted, checked }) {
  const result = {
    schemaVersion: 1,
    kind: 'queue-triage-execution',
    state,
    processedAt: observedAt,
    release: identity,
    managerAuthority: manager,
    execution: { attempted, verified: checked, outcomes },
    runControl: runControl(state, 1, 1, reads, attempted, checked),
  };
  if (evidence) result.evidence = {
    fingerprint: evidenceFingerprint(evidence),
    liveFingerprint: evidence.liveEvidence.fingerprint,
    queryComplete: true,
  };
  if (plan) result.plan = {
    fingerprint: plan.fingerprint,
    actionPlanCount: plan.plans.length,
    exceptionCount: plan.exceptions.length,
    overflow: plan.overflow,
  };
  if (failure) result.failure = failure;
  return boundedResult(result);
}

function publicResult(release, result) {
  return Object.freeze({
    schemaVersion: 1,
    status: result.state,
    release: Object.freeze({ ...result.release, state: release.state }),
    terminalResult: result,
    runControl: result.runControl,
  });
}

export function runQueueTriageReleaseExecutor({
  controllerDb,
  releaseId,
  project,
  managerAuthority,
  readClient,
  writeClient,
  claimToken = `queue-triage-execute-${randomUUID()}`,
  leaseMs = 5 * 60_000,
  observedAt = new Date().toISOString(),
  storeFactory = (path) => new EventControllerReleaseStore(path),
  collectEvidence = collectQueueTriageGitHubEvidence,
  plan = planQueueTriageRun,
  afterClaim = null,
} = {}) {
  if (!text(controllerDb) || !text(releaseId)) throw new Error('controllerDb and releaseId are required');
  if (!CLAIM_TOKEN.test(claimToken)) throw new Error('claimToken is invalid');
  if (typeof readClient?.requestJson !== 'function') throw new Error('GitHub read client is required');
  if (typeof writeClient?.mutateIssue !== 'function') throw new Error('GitHub write client is required');
  const timestamp = iso(observedAt, 'observedAt');
  const lease = integer(leaseMs, 5 * 60_000, { name: 'leaseMs', min: 1_000, max: 60 * 60_000 });
  const manager = authority(managerAuthority);
  const configured = projectConfig(project);
  const store = storeFactory(controllerDb);
  let claimed = false;
  let identity = null;
  let stage = 'pre-claim';
  let reads = false;
  let attempted = 0;
  let checked = 0;
  const outcomes = [];

  try {
    const current = store.getRelease(releaseId);
    if (!current) throw error('release-not-found', 'release not found');
    identity = assertRelease(current, configured);
    if (['processed', 'failed'].includes(current.state)) return terminalNoop(current, identity);
    if (current.state !== 'pending') throw error('release-not-claimable', 'release is not pending');

    stage = 'claim';
    const owned = store.claimRelease(releaseId, { claimToken, leaseMs: lease, now: timestamp });
    if (!owned) throw error('release-claim-conflict', 'claim not acquired');
    claimed = true;
    identity = assertRelease(owned, configured);
    afterClaim?.(Object.freeze({ release: owned, claimToken }));

    reads = true;
    stage = 'initial-live-evidence';
    const initialEvidence = collectEvidence({ release: evidenceRelease(owned), project, client: readClient, observedAt: timestamp });
    if (initialEvidence?.liveEvidence?.queryComplete !== true) throw error('live-evidence-incomplete', 'initial evidence incomplete');
    const initialPlan = executionPlan(plan(initialEvidence), configured);
    if (initialPlan.releaseId !== releaseId) throw error('report-identity-mismatch', 'release identity mismatch');

    stage = 'final-live-recheck';
    const finalEvidence = collectEvidence({
      release: evidenceRelease(owned), project, client: readClient,
      observedAt: new Date(Date.parse(timestamp) + 1).toISOString(),
    });
    if (finalEvidence?.liveEvidence?.queryComplete !== true) throw error('final-live-evidence-incomplete', 'final evidence incomplete');
    const finalPlan = executionPlan(plan(finalEvidence), configured);
    if (finalPlan.fingerprint !== initialPlan.fingerprint) throw error('execution-plan-replaced', 'plan changed during recheck');
    if (finalPlan.plans.length > 0) assertLabelDefinitions(readClient, configured, finalPlan.plans);

    stage = 'pre-write-release-recheck';
    const beforeWrites = store.getRelease(releaseId);
    if (!beforeWrites || beforeWrites.state !== 'claimed' || beforeWrites.claimToken !== claimToken) {
      throw error('release-ownership-lost', 'ownership changed before writes', { preserveClaim: true });
    }
    if (assertRelease(beforeWrites, configured).payloadFingerprint !== identity.payloadFingerprint) {
      throw error('release-identity-changed', 'release changed before writes', { preserveClaim: true });
    }

    for (const action of finalPlan.plans) {
      stage = 'pre-write-recheck';
      const before = readObject(readClient, action);
      assertBefore(action, before);
      const intended = action.action === 'replace_labels'
        ? Object.freeze({ state: 'open', labels: action.intendedLabels })
        : Object.freeze({ state: 'closed', stateReason: 'completed' });
      stage = 'github-write';
      attempted += 1;
      writeClient.mutateIssue(
        endpoint(action.repository, action.number),
        action.action === 'replace_labels'
          ? { labels: action.intendedLabels }
          : { state: 'closed', state_reason: 'completed' },
      );
      stage = 'read-back-verification';
      const readBack = readObject(readClient, action);
      const outcome = Object.freeze({
        repository: action.repository,
        kind: action.kind,
        number: action.number,
        action: action.action,
        idempotencyKey: action.idempotencyKey,
        evidenceFingerprint: action.evidenceFingerprint,
        before,
        intended,
        readBack,
        verified: verified(action, readBack),
      });
      outcomes.push(outcome);
      if (!outcome.verified) throw error('mutation-readback-mismatch', 'read-back mismatch', { outcome });
      checked += 1;
    }

    stage = 'pre-finish-recheck';
    const beforeFinish = store.getRelease(releaseId);
    if (!beforeFinish || beforeFinish.state !== 'claimed' || beforeFinish.claimToken !== claimToken) {
      throw error('release-ownership-lost', 'ownership changed before finish', { preserveClaim: true });
    }
    if (assertRelease(beforeFinish, configured).payloadFingerprint !== identity.payloadFingerprint) {
      throw error('release-identity-changed', 'release changed before finish', { preserveClaim: true });
    }

    stage = 'finish-processed';
    const result = terminalResult({
      state: 'processed', identity, manager, observedAt: timestamp,
      evidence: finalEvidence, plan: finalPlan, outcomes: Object.freeze([...outcomes]), reads, attempted, checked,
    });
    const finished = store.finishRelease(releaseId, { claimToken, state: 'processed', result, now: timestamp });
    if (!finished) throw error('release-finish-conflict', 'finish failed', { preserveClaim: true });
    return publicResult(finished, result);
  } catch (cause) {
    if (cause?.outcome && !outcomes.includes(cause.outcome)) outcomes.push(cause.outcome);
    if (!claimed || cause?.preserveClaim === true) throw cause;
    const owned = store.getRelease(releaseId);
    if (!owned || owned.state !== 'claimed' || owned.claimToken !== claimToken) {
      throw error('release-ownership-lost', 'ownership changed while recording failure', { preserveClaim: true });
    }
    const result = terminalResult({
      state: 'failed', identity, manager, observedAt: timestamp,
      failure: { code: boundedCode(cause?.code), stage: boundedCode(stage, 'execution') },
      outcomes: Object.freeze([...outcomes]), reads, attempted, checked,
    });
    const finished = store.finishRelease(releaseId, { claimToken, state: 'failed', result, now: timestamp });
    if (!finished) throw error('release-failure-finish-conflict', 'failure finish failed', { preserveClaim: true });
    return publicResult(finished, result);
  } finally {
    store.close?.();
  }
}

export function renderQueueTriageExecutionMarkdown(result) {
  return [
    '# Agent Runner queue-triage bounded execution', '',
    `- Status: \`${result.status}\``,
    `- Release: \`${result.release.batchId}\``,
    `- Project: \`${result.release.projectId}\``,
    `- Repository: \`${result.release.repository}\``,
    `- Object: \`${result.release.objectKind}#${result.release.objectNumber}\``,
    `- Controller state: \`${result.release.state}\``,
    `- Mutations attempted: ${result.runControl.mutationsAttempted}`,
    `- Mutations verified: ${result.runControl.mutationsVerified}`, '',
    '## RUN_CONTROL', '', '```json', JSON.stringify(result.runControl), '```', '',
  ].join('\n');
}
