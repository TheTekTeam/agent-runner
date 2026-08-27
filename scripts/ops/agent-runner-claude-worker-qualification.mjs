import { createHash } from 'node:crypto';

import { MINIMUM_IMPLEMENTATION_CLAUDE_VERSION } from './claude-runner-execution-policy.mjs';
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

export const CLAUDE_WORKER_QUALIFICATION_SCHEMA_VERSION = 1;
export const CLAUDE_WORKER_QUALIFICATION_REVISION = 'claude-worker-qualification-v1';
export const CLAUDE_WORKER_QUALIFICATION_OPERATION_PROFILE = 'claude-qualification-canary';
export const CLAUDE_WORKER_QUALIFICATION_OPERATION_REVISION = '1';
export const CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE = 'dev-cluster-dell';
export const CLAUDE_WORKER_QUALIFICATION_TARGET_NODE = 'dev-cluster-z790';
export const CLAUDE_WORKER_QUALIFICATION_AGENT = 'claude-code-cli';
export const CLAUDE_WORKER_QUALIFICATION_INSTANCE = 'claude-code-cli@dev-cluster-z790';
export const CLAUDE_WORKER_QUALIFICATION_REPOSITORY = 'TheTekTeam/agent-runner';
export const CLAUDE_WORKER_QUALIFICATION_ISSUE = 398;
export const CLAUDE_WORKER_QUALIFICATION_PROJECT = 'agent-runner';
export const CLAUDE_WORKER_QUALIFICATION_MODEL = 'sonnet';
export const CLAUDE_WORKER_QUALIFICATION_PROFILE = 'narrow';
export const CLAUDE_WORKER_QUALIFICATION_EFFORT = 'low';
export const CLAUDE_WORKER_QUALIFICATION_PERMISSION_MODE = 'dontAsk';
export const CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE = 'claude-canary.txt';
export const CLAUDE_WORKER_QUALIFICATION_EXPECTED_CONTENT = 'AGENT_RUNNER_CLAUDE_CANARY=PASS\n';
export const CLAUDE_WORKER_QUALIFICATION_COMPLETION_SENTINEL = 'AGENT_RUNNER_CLAUDE_CANARY_COMPLETE';
// Narrow admission ceiling: mirrors the repository-default narrow session-usage
// threshold in claude-runner-quota.mjs. The canary must start well below it.
export const CLAUDE_WORKER_QUALIFICATION_SESSION_USAGE_THRESHOLD = 75;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const PROVIDER_CLASS = /^[a-z][a-z0-9-]{1,32}$/;

const RESULT_EVIDENCE_FIELDS = Object.freeze([
  'schemaVersion',
  'claudeVersion',
  'authMethod',
  'providerClass',
  'sessionUsedPercent',
  'weeklyUsedPercent',
  'model',
  'profile',
  'effort',
  'permissionMode',
  'promptCacheEnabled',
  'toolPolicyAllowedRuleCount',
  'toolPolicyDisallowedRuleCount',
  'toolPolicyFingerprint',
  'settingSourcesEmpty',
  'headUnchanged',
  'exactExpectedDiff',
  'exactExpectedContent',
  'parserCompletionSentinelObserved',
  'parserFilesystemAgree',
  'branchCleaned',
  'worktreeCleaned',
  'rawPromptPersisted',
  'providerOutputPersisted',
  'sessionIdPersisted',
  'credentialMaterialPersisted',
  'creditFieldsUsedForAdmission',
  'normalRoutingEnabled',
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
  if (!Number.isInteger(number) || number < 0 || number > 100) {
    throw new Error(`${name} is invalid`);
  }
  return number;
}

function semverParts(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1, 4).map((part) => Number.parseInt(part, 10)) : null;
}

function versionAtLeast(installed, minimum) {
  const left = semverParts(installed);
  const right = semverParts(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function taskContract() {
  return Object.freeze({
    revision: CLAUDE_WORKER_QUALIFICATION_REVISION,
    repository: CLAUDE_WORKER_QUALIFICATION_REPOSITORY,
    issueNumber: CLAUDE_WORKER_QUALIFICATION_ISSUE,
    controllerNodeId: CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE,
    nodeId: CLAUDE_WORKER_QUALIFICATION_TARGET_NODE,
    agentInstanceId: CLAUDE_WORKER_QUALIFICATION_INSTANCE,
    model: CLAUDE_WORKER_QUALIFICATION_MODEL,
    profile: CLAUDE_WORKER_QUALIFICATION_PROFILE,
    effort: CLAUDE_WORKER_QUALIFICATION_EFFORT,
    permissionMode: CLAUDE_WORKER_QUALIFICATION_PERMISSION_MODE,
    expectedFile: CLAUDE_WORKER_QUALIFICATION_EXPECTED_FILE,
    expectedContent: CLAUDE_WORKER_QUALIFICATION_EXPECTED_CONTENT,
    completionSentinel: CLAUDE_WORKER_QUALIFICATION_COMPLETION_SENTINEL,
    sessionUsageThreshold: CLAUDE_WORKER_QUALIFICATION_SESSION_USAGE_THRESHOLD,
    promptCacheRequired: true,
    settingSources: '',
    resumeSession: false,
    firstPartyAuthRequired: true,
  });
}

export const CLAUDE_WORKER_QUALIFICATION_TASK_FINGERPRINT = digest(taskContract());
export const CLAUDE_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT = digest({
  schemaVersion: CLAUDE_WORKER_QUALIFICATION_SCHEMA_VERSION,
  operationProfile: CLAUDE_WORKER_QUALIFICATION_OPERATION_PROFILE,
  operationRevision: CLAUDE_WORKER_QUALIFICATION_OPERATION_REVISION,
  taskFingerprint: CLAUDE_WORKER_QUALIFICATION_TASK_FINGERPRINT,
});

export function buildClaudeWorkerQualificationRequest({
  registry,
  authorityFingerprint,
  baseSha,
  branch,
  worktree,
  laneId = 'qualification-claude-z790',
  requestedAt,
  expiresAt,
} = {}) {
  if (!DIGEST.test(String(authorityFingerprint || ''))) throw new Error('authorityFingerprint is invalid');
  if (!SHA.test(String(baseSha || ''))) throw new Error('baseSha is invalid');
  const requestedMs = Date.parse(requestedAt);
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(requestedMs) || !Number.isFinite(expiresMs) || requestedMs >= expiresMs) {
    throw new Error('qualification authority window is invalid');
  }

  const route = selectWorkerQualificationRoute(registry, {
    nodeId: CLAUDE_WORKER_QUALIFICATION_TARGET_NODE,
    adapterId: CLAUDE_WORKER_QUALIFICATION_AGENT,
    model: CLAUDE_WORKER_QUALIFICATION_MODEL,
    profile: CLAUDE_WORKER_QUALIFICATION_PROFILE,
    jobClass: 'implementation',
    requiredCapabilities: ['git'],
  });
  if (!route.selected) {
    throw new Error(`qualification route unavailable:${route.reasons.join(',') || 'unknown'}`);
  }

  const lease = issueWorkerQualificationLease({
    registry,
    route,
    projectId: CLAUDE_WORKER_QUALIFICATION_PROJECT,
    repository: CLAUDE_WORKER_QUALIFICATION_REPOSITORY,
    issueNumber: CLAUDE_WORKER_QUALIFICATION_ISSUE,
    authorityFingerprint,
    baseSha,
    branch,
    worktree,
    adapterId: CLAUDE_WORKER_QUALIFICATION_AGENT,
    model: CLAUDE_WORKER_QUALIFICATION_MODEL,
    profile: CLAUDE_WORKER_QUALIFICATION_PROFILE,
    jobClass: 'implementation',
    laneId,
    validationProfile: 'claude-canary',
    qualificationProfile: CLAUDE_WORKER_QUALIFICATION_PROFILE,
    expiresAt,
  });

  const job = buildWorkerJobEnvelope({
    lease,
    operationProfile: CLAUDE_WORKER_QUALIFICATION_OPERATION_PROFILE,
    operationRevision: CLAUDE_WORKER_QUALIFICATION_OPERATION_REVISION,
    taskFingerprint: CLAUDE_WORKER_QUALIFICATION_TASK_FINGERPRINT,
    requestedAt,
  });

  return Object.freeze({
    schemaVersion: CLAUDE_WORKER_QUALIFICATION_SCHEMA_VERSION,
    contractFingerprint: CLAUDE_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT,
    lease,
    job,
  });
}

export function validateClaudeWorkerQualificationRequest({
  request,
  registry,
  executingNodeId,
  now = new Date(),
} = {}) {
  const refuse = (reason) => Object.freeze({ valid: false, reason });
  if (!exactFields(request, ['schemaVersion', 'contractFingerprint', 'lease', 'job'])) {
    return refuse('request-field-set-invalid');
  }
  if (request.schemaVersion !== CLAUDE_WORKER_QUALIFICATION_SCHEMA_VERSION) return refuse('request-schema-invalid');
  if (request.contractFingerprint !== CLAUDE_WORKER_QUALIFICATION_CONTRACT_FINGERPRINT) {
    return refuse('qualification-contract-mismatch');
  }

  const { lease, job } = request;
  if (lease?.qualificationOnly !== true) return refuse('qualification-lease-required');
  if (lease?.controllerNodeId !== CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE) return refuse('controller-mismatch');
  if (lease?.nodeId !== CLAUDE_WORKER_QUALIFICATION_TARGET_NODE) return refuse('target-node-mismatch');
  if (lease?.agentInstanceId !== CLAUDE_WORKER_QUALIFICATION_INSTANCE) return refuse('agent-instance-mismatch');
  if (lease?.repository !== CLAUDE_WORKER_QUALIFICATION_REPOSITORY || lease?.issueNumber !== CLAUDE_WORKER_QUALIFICATION_ISSUE) {
    return refuse('qualification-scope-mismatch');
  }
  if (lease?.adapterId !== CLAUDE_WORKER_QUALIFICATION_AGENT) return refuse('adapter-mismatch');
  if (lease?.model !== CLAUDE_WORKER_QUALIFICATION_MODEL || lease?.profile !== CLAUDE_WORKER_QUALIFICATION_PROFILE) {
    return refuse('model-profile-mismatch');
  }
  if (lease?.qualificationProfile !== CLAUDE_WORKER_QUALIFICATION_PROFILE) return refuse('qualification-profile-mismatch');
  if (!SHA.test(String(lease?.baseSha || ''))) return refuse('source-sha-invalid');

  if (job?.operationProfile !== CLAUDE_WORKER_QUALIFICATION_OPERATION_PROFILE) return refuse('operation-profile-mismatch');
  if (job?.operationRevision !== CLAUDE_WORKER_QUALIFICATION_OPERATION_REVISION) return refuse('operation-revision-mismatch');
  if (job?.taskFingerprint !== CLAUDE_WORKER_QUALIFICATION_TASK_FINGERPRINT) return refuse('task-fingerprint-mismatch');

  const validated = validateWorkerJobEnvelope({
    job,
    lease,
    registry,
    executingNodeId,
    allowedProfiles: [CLAUDE_WORKER_QUALIFICATION_OPERATION_PROFILE],
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

export function normalizeClaudeWorkerQualificationEvidence(raw = {}) {
  if (!exactFields(raw, RESULT_EVIDENCE_FIELDS)) throw new Error('qualification evidence field set is invalid');
  if (raw.schemaVersion !== CLAUDE_WORKER_QUALIFICATION_SCHEMA_VERSION) throw new Error('qualification evidence schema is invalid');
  if (!SEMVER.test(String(raw.claudeVersion || ''))) throw new Error('claudeVersion is invalid');
  if (!versionAtLeast(raw.claudeVersion, MINIMUM_IMPLEMENTATION_CLAUDE_VERSION)) {
    throw new Error('claudeVersion is below the repository minimum');
  }
  if (raw.authMethod !== 'claude.ai') throw new Error('authMethod is invalid');
  if (!PROVIDER_CLASS.test(String(raw.providerClass || ''))) throw new Error('providerClass is invalid');

  const sessionUsedPercent = boundedPercent(raw.sessionUsedPercent, 'sessionUsedPercent');
  const weeklyUsedPercent = boundedPercent(raw.weeklyUsedPercent, 'weeklyUsedPercent');
  if (sessionUsedPercent >= CLAUDE_WORKER_QUALIFICATION_SESSION_USAGE_THRESHOLD) {
    throw new Error('narrow session usage is at or above the admission threshold');
  }

  if (raw.model !== CLAUDE_WORKER_QUALIFICATION_MODEL) throw new Error('model is invalid');
  if (raw.profile !== CLAUDE_WORKER_QUALIFICATION_PROFILE) throw new Error('profile is invalid');
  if (raw.effort !== CLAUDE_WORKER_QUALIFICATION_EFFORT) throw new Error('effort is invalid');
  if (raw.permissionMode !== CLAUDE_WORKER_QUALIFICATION_PERMISSION_MODE) throw new Error('permissionMode is invalid');

  if (!Number.isInteger(raw.toolPolicyAllowedRuleCount) || raw.toolPolicyAllowedRuleCount < 1) {
    throw new Error('toolPolicyAllowedRuleCount is invalid');
  }
  if (!Number.isInteger(raw.toolPolicyDisallowedRuleCount) || raw.toolPolicyDisallowedRuleCount < 1) {
    throw new Error('toolPolicyDisallowedRuleCount is invalid');
  }
  if (!DIGEST.test(String(raw.toolPolicyFingerprint || ''))) throw new Error('toolPolicyFingerprint is invalid');

  const requiredTrue = [
    'promptCacheEnabled',
    'settingSourcesEmpty',
    'headUnchanged',
    'exactExpectedDiff',
    'exactExpectedContent',
    'parserCompletionSentinelObserved',
    'parserFilesystemAgree',
    'branchCleaned',
    'worktreeCleaned',
  ];
  for (const field of requiredTrue) {
    if (raw[field] !== true) throw new Error(`${field} must be true`);
  }

  const requiredFalse = [
    'rawPromptPersisted',
    'providerOutputPersisted',
    'sessionIdPersisted',
    'credentialMaterialPersisted',
    'creditFieldsUsedForAdmission',
    'normalRoutingEnabled',
  ];
  for (const field of requiredFalse) {
    if (raw[field] !== false) throw new Error(`${field} must be false`);
  }

  return Object.freeze({
    ...raw,
    sessionUsedPercent,
    weeklyUsedPercent,
  });
}

export function buildClaudeWorkerQualificationResult({
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
      evidence: normalizeClaudeWorkerQualificationEvidence(evidence),
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

export function acceptClaudeWorkerQualificationResult({
  request,
  result,
  registry,
  now = new Date(),
} = {}) {
  const refuse = (reason) => Object.freeze({ accepted: false, reason, qualified: false });

  const requestValidation = validateClaudeWorkerQualificationRequest({
    request,
    registry,
    executingNodeId: CLAUDE_WORKER_QUALIFICATION_TARGET_NODE,
    now,
  });
  if (!requestValidation.valid) return refuse(`request:${requestValidation.reason}`);

  const resultValidation = validateWorkerResultEvidence({ result, job: request.job });
  if (!resultValidation.valid) return refuse(`result:${resultValidation.reason}`);
  if (result.sourceSha !== request.lease.baseSha) return refuse('result-source-sha-mismatch');
  if (result.status !== 'succeeded' || result.exitCode !== 0) return refuse(`qualification-${result.status}`);
  const requestedMs = Date.parse(request.job.requestedAt);
  const expiresMs = Date.parse(request.job.expiresAt);
  const completedMs = Date.parse(result.completedAt);
  if (!Number.isFinite(requestedMs) || !Number.isFinite(expiresMs) || !Number.isFinite(completedMs)
    || completedMs < requestedMs || completedMs > expiresMs) {
    return refuse('result-outside-authority-window');
  }
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
    evidence = normalizeClaudeWorkerQualificationEvidence(diagnostic.evidence);
  } catch {
    return refuse('qualification-evidence-invalid');
  }

  const revision = `claude-z790-${result.resultFingerprint.slice('sha256:'.length, 'sha256:'.length + 16)}`;
  return Object.freeze({
    accepted: true,
    reason: 'claude-worker-qualification-accepted',
    qualified: true,
    nodeId: CLAUDE_WORKER_QUALIFICATION_TARGET_NODE,
    agentInstanceId: CLAUDE_WORKER_QUALIFICATION_INSTANCE,
    model: CLAUDE_WORKER_QUALIFICATION_MODEL,
    profile: CLAUDE_WORKER_QUALIFICATION_PROFILE,
    effort: CLAUDE_WORKER_QUALIFICATION_EFFORT,
    baseSha: request.lease.baseSha,
    jobFingerprint: request.job.jobFingerprint,
    resultFingerprint: result.resultFingerprint,
    qualificationRevision: revision,
    evidence,
  });
}

export function claudeWorkerQualificationControlSurface() {
  return Object.freeze({
    schemaVersion: CLAUDE_WORKER_QUALIFICATION_SCHEMA_VERSION,
    controllerNodeId: CLAUDE_WORKER_QUALIFICATION_CONTROLLER_NODE,
    targetNodeId: CLAUDE_WORKER_QUALIFICATION_TARGET_NODE,
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
