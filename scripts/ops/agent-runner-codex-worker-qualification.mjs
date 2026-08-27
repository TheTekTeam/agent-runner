import { createHash } from 'node:crypto';

import {
  issueWorkerQualificationLease,
  selectWorkerQualificationRoute,
} from './agent-runner-worker-pool.mjs';
import {
  buildWorkerJobEnvelope,
  buildWorkerResultEvidence,
  validateWorkerJobEnvelope,
  validateWorkerResultEvidence,
} from './agent-runner-worker-dispatch.mjs';

export const CODEX_WORKER_QUALIFICATION_SCHEMA_VERSION = 1;
export const CODEX_WORKER_QUALIFICATION_REVISION = 'codex-worker-qualification-v1';
export const CODEX_WORKER_QUALIFICATION_OPERATION_PROFILE = 'codex-qualification-canary';
export const CODEX_WORKER_QUALIFICATION_OPERATION_REVISION = '1';
export const CODEX_WORKER_QUALIFICATION_CONTROLLER_NODE = 'dev-cluster-dell';
export const CODEX_WORKER_QUALIFICATION_TARGET_NODE = 'dev-cluster-z790';
export const CODEX_WORKER_QUALIFICATION_AGENT = 'codex-cli';
export const CODEX_WORKER_QUALIFICATION_INSTANCE = 'codex-cli@dev-cluster-z790';
export const CODEX_WORKER_QUALIFICATION_REPOSITORY = 'TheTekTeam/agent-runner';
export const CODEX_WORKER_QUALIFICATION_ISSUE = 389;
export const CODEX_WORKER_QUALIFICATION_PROJECT = 'agent-runner';
export const CODEX_WORKER_QUALIFICATION_MODEL = 'gpt-5.6-terra';
export const CODEX_WORKER_QUALIFICATION_PROFILE = 'codex-canary-v1';
export const CODEX_WORKER_QUALIFICATION_EFFORT = 'low';
export const CODEX_WORKER_QUALIFICATION_EXPECTED_FILE = 'codex-canary.txt';
export const CODEX_WORKER_QUALIFICATION_EXPECTED_CONTENT = 'AGENT_RUNNER_CODEX_CANARY=PASS\n';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$/;
const RESULT_EVIDENCE_FIELDS = Object.freeze([
  'schemaVersion',
  'codexVersion',
  'authMode',
  'primaryRemainingPercent',
  'secondaryRemainingPercent',
  'model',
  'profile',
  'effort',
  'sandboxMode',
  'approvalMode',
  'networkAccess',
  'ephemeral',
  'ignoreUserConfig',
  'headUnchanged',
  'exactExpectedDiff',
  'exactExpectedContent',
  'parserMutationAgrees',
  'branchCleaned',
  'worktreeCleaned',
  'rawPromptPersisted',
  'providerOutputPersisted',
  'credentialMaterialPersisted',
  'creditFieldsUsedForAdmission',
  'normalCatalogueImplemented',
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function exactFields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedPercent(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`${name} is invalid`);
  }
  return number;
}

function taskContract() {
  return Object.freeze({
    revision: CODEX_WORKER_QUALIFICATION_REVISION,
    repository: CODEX_WORKER_QUALIFICATION_REPOSITORY,
    issueNumber: CODEX_WORKER_QUALIFICATION_ISSUE,
    controllerNodeId: CODEX_WORKER_QUALIFICATION_CONTROLLER_NODE,
    nodeId: CODEX_WORKER_QUALIFICATION_TARGET_NODE,
    agentInstanceId: CODEX_WORKER_QUALIFICATION_INSTANCE,
    model: CODEX_WORKER_QUALIFICATION_MODEL,
    profile: CODEX_WORKER_QUALIFICATION_PROFILE,
    effort: CODEX_WORKER_QUALIFICATION_EFFORT,
    expectedFile: CODEX_WORKER_QUALIFICATION_EXPECTED_FILE,
    expectedContent: CODEX_WORKER_QUALIFICATION_EXPECTED_CONTENT,
    sandboxMode: 'workspace-write',
    approvalMode: 'never',
    networkAccess: false,
    ephemeral: true,
    ignoreUserConfig: true,
  });
}

export const CODEX_WORKER_QUALIFICATION_TASK_FINGERPRINT = digest(taskContract());
export const CODEX_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT = digest({
  schemaVersion: CODEX_WORKER_QUALIFICATION_SCHEMA_VERSION,
  operationProfile: CODEX_WORKER_QUALIFICATION_OPERATION_PROFILE,
  operationRevision: CODEX_WORKER_QUALIFICATION_OPERATION_REVISION,
  taskFingerprint: CODEX_WORKER_QUALIFICATION_TASK_FINGERPRINT,
});

export function buildCodexWorkerQualificationRequest({
  registry,
  authorityFingerprint,
  baseSha,
  branch,
  worktree,
  laneId = 'qualification-codex-z790',
  requestedAt,
  expiresAt,
} = {}) {
  if (!DIGEST.test(String(authorityFingerprint || ''))) throw new Error('authorityFingerprint is invalid');
  if (!SHA.test(String(baseSha || ''))) throw new Error('baseSha is invalid');

  const route = selectWorkerQualificationRoute(registry, {
    nodeId: CODEX_WORKER_QUALIFICATION_TARGET_NODE,
    adapterId: CODEX_WORKER_QUALIFICATION_AGENT,
    model: CODEX_WORKER_QUALIFICATION_MODEL,
    profile: CODEX_WORKER_QUALIFICATION_PROFILE,
    jobClass: 'implementation',
    requiredCapabilities: ['git'],
  });
  if (!route.selected) {
    throw new Error(`qualification route unavailable:${route.reasons.join(',') || 'unknown'}`);
  }

  const lease = issueWorkerQualificationLease({
    registry,
    route,
    projectId: CODEX_WORKER_QUALIFICATION_PROJECT,
    repository: CODEX_WORKER_QUALIFICATION_REPOSITORY,
    issueNumber: CODEX_WORKER_QUALIFICATION_ISSUE,
    authorityFingerprint,
    baseSha,
    branch,
    worktree,
    adapterId: CODEX_WORKER_QUALIFICATION_AGENT,
    model: CODEX_WORKER_QUALIFICATION_MODEL,
    profile: CODEX_WORKER_QUALIFICATION_PROFILE,
    jobClass: 'implementation',
    laneId,
    validationProfile: 'codex-canary',
    qualificationProfile: CODEX_WORKER_QUALIFICATION_PROFILE,
    expiresAt,
  });

  const job = buildWorkerJobEnvelope({
    lease,
    operationProfile: CODEX_WORKER_QUALIFICATION_OPERATION_PROFILE,
    operationRevision: CODEX_WORKER_QUALIFICATION_OPERATION_REVISION,
    taskFingerprint: CODEX_WORKER_QUALIFICATION_TASK_FINGERPRINT,
    requestedAt,
  });

  return Object.freeze({
    schemaVersion: CODEX_WORKER_QUALIFICATION_SCHEMA_VERSION,
    contractFingerprint: CODEX_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT,
    lease,
    job,
  });
}

export function validateCodexWorkerQualificationRequest({
  request,
  registry,
  executingNodeId,
  now = new Date(),
} = {}) {
  const refuse = (reason) => Object.freeze({ valid: false, reason });
  if (!exactFields(request, ['schemaVersion', 'contractFingerprint', 'lease', 'job'])) {
    return refuse('request-field-set-invalid');
  }
  if (request.schemaVersion !== CODEX_WORKER_QUALIFICATION_SCHEMA_VERSION) return refuse('request-schema-invalid');
  if (request.contractFingerprint !== CODEX_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT) {
    return refuse('qualification-contract-mismatch');
  }

  const { lease, job } = request;
  if (lease?.qualificationOnly !== true) return refuse('qualification-lease-required');
  if (lease?.controllerNodeId !== CODEX_WORKER_QUALIFICATION_CONTROLLER_NODE) return refuse('controller-mismatch');
  if (lease?.nodeId !== CODEX_WORKER_QUALIFICATION_TARGET_NODE) return refuse('target-node-mismatch');
  if (lease?.agentInstanceId !== CODEX_WORKER_QUALIFICATION_INSTANCE) return refuse('agent-instance-mismatch');
  if (lease?.repository !== CODEX_WORKER_QUALIFICATION_REPOSITORY || lease?.issueNumber !== CODEX_WORKER_QUALIFICATION_ISSUE) {
    return refuse('qualification-scope-mismatch');
  }
  if (lease?.adapterId !== CODEX_WORKER_QUALIFICATION_AGENT) return refuse('adapter-mismatch');
  if (lease?.model !== CODEX_WORKER_QUALIFICATION_MODEL || lease?.profile !== CODEX_WORKER_QUALIFICATION_PROFILE) {
    return refuse('model-profile-mismatch');
  }
  if (lease?.qualificationProfile !== CODEX_WORKER_QUALIFICATION_PROFILE) return refuse('qualification-profile-mismatch');
  if (!SHA.test(String(lease?.baseSha || ''))) return refuse('source-sha-invalid');

  if (job?.operationProfile !== CODEX_WORKER_QUALIFICATION_OPERATION_PROFILE) return refuse('operation-profile-mismatch');
  if (job?.operationRevision !== CODEX_WORKER_QUALIFICATION_OPERATION_REVISION) return refuse('operation-revision-mismatch');
  if (job?.taskFingerprint !== CODEX_WORKER_QUALIFICATION_TASK_FINGERPRINT) return refuse('task-fingerprint-mismatch');

  const validated = validateWorkerJobEnvelope({
    job,
    lease,
    registry,
    executingNodeId,
    allowedProfiles: [CODEX_WORKER_QUALIFICATION_OPERATION_PROFILE],
    now,
  });
  if (!validated.valid) return refuse(`worker-job:${validated.reason}`);

  return Object.freeze({
    valid: true,
    reason: null,
    nodeId: lease.nodeId,
    agentInstanceId: lease.agentInstanceId,
    baseSha: lease.baseSha,
    jobFingerprint: job.jobFingerprint,
  });
}

export function normalizeCodexWorkerQualificationEvidence(raw = {}) {
  if (!exactFields(raw, RESULT_EVIDENCE_FIELDS)) throw new Error('qualification evidence field set is invalid');
  if (raw.schemaVersion !== CODEX_WORKER_QUALIFICATION_SCHEMA_VERSION) throw new Error('qualification evidence schema is invalid');
  if (!VERSION.test(String(raw.codexVersion || ''))) throw new Error('codexVersion is invalid');
  if (raw.authMode !== 'chatgpt') throw new Error('authMode is invalid');

  const primaryRemainingPercent = boundedPercent(raw.primaryRemainingPercent, 'primaryRemainingPercent');
  const secondaryRemainingPercent = boundedPercent(raw.secondaryRemainingPercent, 'secondaryRemainingPercent');

  if (raw.model !== CODEX_WORKER_QUALIFICATION_MODEL) throw new Error('model is invalid');
  if (raw.profile !== CODEX_WORKER_QUALIFICATION_PROFILE) throw new Error('profile is invalid');
  if (raw.effort !== CODEX_WORKER_QUALIFICATION_EFFORT) throw new Error('effort is invalid');
  if (raw.sandboxMode !== 'workspace-write') throw new Error('sandboxMode is invalid');
  if (raw.approvalMode !== 'never') throw new Error('approvalMode is invalid');

  const requiredTrue = [
    'ephemeral',
    'ignoreUserConfig',
    'headUnchanged',
    'exactExpectedDiff',
    'exactExpectedContent',
    'parserMutationAgrees',
    'branchCleaned',
    'worktreeCleaned',
  ];
  for (const field of requiredTrue) {
    if (raw[field] !== true) throw new Error(`${field} must be true`);
  }

  const requiredFalse = [
    'networkAccess',
    'rawPromptPersisted',
    'providerOutputPersisted',
    'credentialMaterialPersisted',
    'creditFieldsUsedForAdmission',
    'normalCatalogueImplemented',
  ];
  for (const field of requiredFalse) {
    if (raw[field] !== false) throw new Error(`${field} must be false`);
  }

  return Object.freeze({
    ...raw,
    primaryRemainingPercent,
    secondaryRemainingPercent,
  });
}

export function buildCodexWorkerQualificationResult({
  request,
  status,
  sourceSha,
  exitCode,
  durationMs,
  evidence = null,
  failureReason = null,
  completedAt,
} = {}) {
  if (!request?.job) throw new Error('qualification request is required');
  let diagnostic;
  if (status === 'succeeded') {
    diagnostic = JSON.stringify({
      kind: 'qualification-success',
      evidence: normalizeCodexWorkerQualificationEvidence(evidence),
    });
  } else {
    const reason = String(failureReason || 'qualification-failed');
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(reason)) throw new Error('failureReason is invalid');
    diagnostic = JSON.stringify({ kind: 'qualification-failure', reason });
  }

  return buildWorkerResultEvidence({
    job: request.job,
    status,
    sourceSha,
    exitCode,
    durationMs,
    output: diagnostic,
    completedAt,
  });
}

export function acceptCodexWorkerQualificationResult({
  request,
  result,
  registry,
  now = new Date(),
} = {}) {
  const refuse = (reason) => Object.freeze({ accepted: false, reason, qualified: false });

  const requestValidation = validateCodexWorkerQualificationRequest({
    request,
    registry,
    executingNodeId: CODEX_WORKER_QUALIFICATION_TARGET_NODE,
    now,
  });
  if (!requestValidation.valid) return refuse(`request:${requestValidation.reason}`);

  const resultValidation = validateWorkerResultEvidence({ result, job: request.job });
  if (!resultValidation.valid) return refuse(`result:${resultValidation.reason}`);
  if (result.sourceSha !== request.lease.baseSha) return refuse('result-source-sha-mismatch');
  if (result.status !== 'succeeded' || result.exitCode !== 0) return refuse(`qualification-${result.status}`);
  if (result.diagnosticTruncated === true || typeof result.diagnostic !== 'string') return refuse('qualification-evidence-truncated');

  let diagnostic;
  try {
    diagnostic = JSON.parse(result.diagnostic);
  } catch {
    return refuse('qualification-evidence-json-invalid');
  }
  if (!exactFields(diagnostic, ['kind', 'evidence']) || diagnostic.kind !== 'qualification-success') {
    return refuse('qualification-evidence-shape-invalid');
  }

  let evidence;
  try {
    evidence = normalizeCodexWorkerQualificationEvidence(diagnostic.evidence);
  } catch {
    return refuse('qualification-evidence-invalid');
  }

  const revision = `codex-z790-${result.resultFingerprint.slice('sha256:'.length, 'sha256:'.length + 16)}`;
  return Object.freeze({
    accepted: true,
    reason: 'codex-worker-qualification-accepted',
    qualified: true,
    nodeId: CODEX_WORKER_QUALIFICATION_TARGET_NODE,
    agentInstanceId: CODEX_WORKER_QUALIFICATION_INSTANCE,
    model: CODEX_WORKER_QUALIFICATION_MODEL,
    profile: CODEX_WORKER_QUALIFICATION_PROFILE,
    effort: CODEX_WORKER_QUALIFICATION_EFFORT,
    baseSha: request.lease.baseSha,
    jobFingerprint: request.job.jobFingerprint,
    resultFingerprint: result.resultFingerprint,
    qualificationRevision: revision,
    evidence,
  });
}

export function codexWorkerQualificationControlSurface() {
  return Object.freeze({
    schemaVersion: CODEX_WORKER_QUALIFICATION_SCHEMA_VERSION,
    controllerNodeId: CODEX_WORKER_QUALIFICATION_CONTROLLER_NODE,
    targetNodeId: CODEX_WORKER_QUALIFICATION_TARGET_NODE,
    workerScheduler: false,
    workerQueueSelection: false,
    workerManagerAuthority: false,
    workerGithubManagementMutation: false,
    workerMergeCloseDeploy: false,
    workerSourceActivation: false,
    workerArbitraryShell: false,
    normalRoutingEnabled: false,
    acceptedInput: 'validated-qualification-worker-job',
    acceptedOutput: 'bounded-qualification-result-evidence',
  });
}
