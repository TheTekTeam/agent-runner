import { createHash } from 'node:crypto';

import { validateWorkerLease } from './agent-runner-worker-pool.mjs';

export const WORKER_DISPATCH_SCHEMA_VERSION = 1;
export const WORKER_DISPATCH_REVISION = 'worker-dispatch-v1';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'blocked', 'checkpointed']);
const WORKER_FORBIDDEN_AUTHORITIES = Object.freeze([
  'queue-select', 'issue-claim', 'manager-authority', 'issue-mutate', 'pr-merge', 'issue-close',
  'deploy', 'source-activate', 'scheduler-recurrence', 'lease-steal', 'work-reassign',
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function token(value, name) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function boundedText(value, maxBytes) {
  let text = String(value ?? '').replace(/\r/g, '');
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let buffer = Buffer.from(text).subarray(0, maxBytes);
  text = buffer.toString('utf8');
  while (Buffer.byteLength(text) > maxBytes) text = text.slice(0, -1);
  return { text, truncated: true };
}

export function assertWorkerAuthority(action) {
  const normalized = token(action, 'worker action');
  if (WORKER_FORBIDDEN_AUTHORITIES.includes(normalized)) {
    throw new Error(`worker-control-authority-forbidden:${normalized}`);
  }
  return normalized;
}

export function buildWorkerJobEnvelope({
  lease,
  operationProfile,
  operationRevision,
  taskFingerprint,
  requestedAt,
  returnChannel = 'controller',
} = {}) {
  if (!lease?.leaseFingerprint || !SHA256.test(lease.leaseFingerprint)) throw new Error('valid worker lease is required');
  const requested = new Date(requestedAt);
  if (!Number.isFinite(requested.getTime())) throw new Error('requestedAt is invalid');
  const payload = {
    schemaVersion: WORKER_DISPATCH_SCHEMA_VERSION,
    revision: WORKER_DISPATCH_REVISION,
    leaseFingerprint: lease.leaseFingerprint,
    controllerNodeId: token(lease.controllerNodeId, 'controllerNodeId'),
    nodeId: token(lease.nodeId, 'nodeId'),
    agentInstanceId: token(lease.agentInstanceId, 'agentInstanceId'),
    projectId: token(lease.projectId, 'projectId'),
    repository: token(lease.repository, 'repository'),
    issueNumber: lease.issueNumber,
    baseSha: lease.baseSha,
    branch: token(lease.branch, 'branch'),
    worktree: token(lease.worktree, 'worktree'),
    laneId: token(lease.laneId, 'laneId'),
    operationProfile: token(operationProfile, 'operationProfile'),
    operationRevision: token(operationRevision, 'operationRevision'),
    taskFingerprint: token(taskFingerprint, 'taskFingerprint'),
    returnChannel: token(returnChannel, 'returnChannel'),
    requestedAt: requested.toISOString(),
    expiresAt: lease.expiresAt,
  };
  return Object.freeze({ ...payload, jobFingerprint: digest(payload) });
}

export function validateWorkerJobEnvelope({ job, lease, registry, executingNodeId, allowedProfiles = [], now = new Date() } = {}) {
  const refuse = (reason) => Object.freeze({ valid: false, reason });
  const leaseResult = validateWorkerLease({ lease, registry, executingNodeId, now });
  if (!leaseResult.valid) return refuse(`lease:${leaseResult.reason}`);
  if (!job || job.schemaVersion !== WORKER_DISPATCH_SCHEMA_VERSION) return refuse('job-schema-invalid');
  if (job.leaseFingerprint !== lease.leaseFingerprint) return refuse('lease-fingerprint-mismatch');
  if (job.nodeId !== executingNodeId || job.nodeId !== lease.nodeId) return refuse('wrong-node');
  if (job.agentInstanceId !== lease.agentInstanceId) return refuse('wrong-agent-instance');
  if (job.repository !== lease.repository || job.projectId !== lease.projectId || job.issueNumber !== lease.issueNumber) return refuse('task-identity-mismatch');
  if (job.baseSha !== lease.baseSha || job.branch !== lease.branch || job.worktree !== lease.worktree || job.laneId !== lease.laneId) return refuse('source-or-lane-mismatch');
  const profiles = new Set(allowedProfiles.map((value) => token(value, 'allowed profile')));
  if (!profiles.has(job.operationProfile)) return refuse('operation-profile-not-allowlisted');
  const candidate = { ...job };
  delete candidate.jobFingerprint;
  if (!SHA256.test(job.jobFingerprint || '') || digest(candidate) !== job.jobFingerprint) return refuse('job-fingerprint-mismatch');
  return Object.freeze({ valid: true, reason: null, jobFingerprint: job.jobFingerprint, operationProfile: job.operationProfile });
}

export function buildWorkerResultEvidence({
  job,
  status,
  sourceSha,
  exitCode = null,
  durationMs = null,
  output = '',
  checkpointFingerprint = null,
  portableCheckpoint = false,
  completedAt,
} = {}) {
  if (!job?.jobFingerprint || !SHA256.test(job.jobFingerprint)) throw new Error('valid worker job is required');
  if (!TERMINAL_STATES.includes(status)) throw new Error('worker result status is invalid');
  if (sourceSha !== job.baseSha && status === 'succeeded' && job.operationProfile.includes('validation')) {
    throw new Error('validation result source SHA does not match dispatched source');
  }
  const completed = new Date(completedAt);
  if (!Number.isFinite(completed.getTime())) throw new Error('completedAt is invalid');
  const bounded = boundedText(output, 4096);
  const payload = {
    schemaVersion: WORKER_DISPATCH_SCHEMA_VERSION,
    revision: WORKER_DISPATCH_REVISION,
    jobFingerprint: job.jobFingerprint,
    leaseFingerprint: job.leaseFingerprint,
    controllerNodeId: job.controllerNodeId,
    nodeId: job.nodeId,
    agentInstanceId: job.agentInstanceId,
    projectId: job.projectId,
    repository: job.repository,
    issueNumber: job.issueNumber,
    sourceSha,
    operationProfile: job.operationProfile,
    status,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
    diagnostic: bounded.text || null,
    diagnosticTruncated: bounded.truncated,
    outputDigest: digest(String(output ?? '')),
    checkpointFingerprint: checkpointFingerprint && SHA256.test(checkpointFingerprint) ? checkpointFingerprint : null,
    portableCheckpoint: portableCheckpoint === true,
    completedAt: completed.toISOString(),
  };
  return Object.freeze({ ...payload, resultFingerprint: digest(payload) });
}

export function validateWorkerResultEvidence({ result, job } = {}) {
  const refuse = (reason) => Object.freeze({ valid: false, reason });
  if (!result || result.schemaVersion !== WORKER_DISPATCH_SCHEMA_VERSION) return refuse('result-schema-invalid');
  if (!job || result.jobFingerprint !== job.jobFingerprint || result.leaseFingerprint !== job.leaseFingerprint) return refuse('job-or-lease-mismatch');
  for (const field of ['controllerNodeId', 'nodeId', 'agentInstanceId', 'projectId', 'repository', 'issueNumber', 'operationProfile']) {
    if (result[field] !== job[field]) return refuse(`result-identity-mismatch:${field}`);
  }
  const candidate = { ...result };
  delete candidate.resultFingerprint;
  if (!SHA256.test(result.resultFingerprint || '') || digest(candidate) !== result.resultFingerprint) return refuse('result-fingerprint-mismatch');
  if (!TERMINAL_STATES.includes(result.status)) return refuse('result-status-invalid');
  return Object.freeze({ valid: true, reason: null, status: result.status, resultFingerprint: result.resultFingerprint });
}

/**
 * Shared provider/account admission is host-independent. `active` contains
 * controller-known leases that already consume the provider/account class.
 * A full account excludes only routes sharing that class.
 */
export function evaluateProviderAccountCapacity({ providerAccountClass, active = [], caps = {} } = {}) {
  const account = token(providerAccountClass, 'providerAccountClass');
  const cap = Number(caps[account] ?? 1);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 128) throw new Error('provider account cap is invalid');
  const consuming = active.filter((entry) => entry?.providerAccountClass === account).length;
  return Object.freeze({
    allowed: consuming < cap,
    providerAccountClass: account,
    active: consuming,
    cap,
    reason: consuming < cap ? null : 'provider-account-cap-full',
  });
}

export function evaluateRecoveryNodeAffinity({
  previousNodeId,
  candidateNodeId,
  requiresExactSession = false,
  portableCheckpoint = false,
  checkpointFingerprint = null,
  freshAuthority = false,
} = {}) {
  const previous = token(previousNodeId, 'previousNodeId');
  const candidate = token(candidateNodeId, 'candidateNodeId');
  if (previous === candidate) return Object.freeze({ allowed: true, reason: 'same-node-recovery' });
  if (requiresExactSession) return Object.freeze({ allowed: false, reason: 'exact-session-node-affinity' });
  if (!portableCheckpoint || !SHA256.test(checkpointFingerprint || '')) return Object.freeze({ allowed: false, reason: 'portable-checkpoint-not-proven' });
  if (!freshAuthority) return Object.freeze({ allowed: false, reason: 'cross-node-fresh-authority-required' });
  return Object.freeze({ allowed: true, reason: 'portable-checkpoint-fresh-authority' });
}

export function workerControlSurface() {
  return Object.freeze({
    schemaVersion: WORKER_DISPATCH_SCHEMA_VERSION,
    scheduler: false,
    queueSelection: false,
    managerAuthority: false,
    githubManagementMutation: false,
    mergeCloseDeploy: false,
    sourceActivation: false,
    activeWorkStealing: false,
    acceptedInputs: Object.freeze(['validated-job-envelope']),
    acceptedOutputs: Object.freeze(['bounded-result-evidence']),
  });
}
