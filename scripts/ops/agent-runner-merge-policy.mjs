import { createHash } from 'node:crypto';
import { LOCAL_EXECUTOR_RISK_CLASSES } from './agent-runner-local-executor-policy.mjs';

export const MERGE_POLICY_SCHEMA_VERSION = 1;

/**
 * Only R0/R1/R2 (low/medium risk) may ever merge automatically. R3/R4 are
 * always human-gated, matching issue #155 requirement 2, and this list is
 * not configurable by repository- or request-supplied input.
 */
export const AUTOMATIC_MERGE_RISK_CLASSES = Object.freeze(['R0', 'R1', 'R2']);

/**
 * Explicit human-gate categories a request must positively assert are all
 * false. Any true (or, at normalization time, any missing) value fails
 * closed -- this is default-deny, not default-allow.
 */
export const MERGE_HUMAN_GATE_NAMES = Object.freeze([
  'securityAuth',
  'destructiveMigration',
  'productionDeployment',
  'secretCredential',
  'billingPolicy',
  'humanGated',
]);

export const MERGE_METHODS = Object.freeze(['merge', 'squash', 'rebase']);

export const MERGE_FAILURE_CODES = Object.freeze([
  'invalid-request',
  'project-not-enabled',
  'repository-mismatch',
  'manager-authority-missing',
  'manager-authority-stale',
  'automatic-merge-authority-missing',
  'high-risk-classification',
  'human-gate-required',
  'validation-evidence-missing',
  'validation-evidence-failed',
  'validation-evidence-expired',
  'head-changed',
  'base-changed',
  'pr-not-open',
  'pr-draft',
  'unexpected-merge-state',
  'checks-unsettled',
  'checks-failed',
  'review-required',
  'merge-conflict',
  'not-mergeable',
  'partial-github-read',
  'github-write-rejected',
  'concurrent-transaction-active',
  'idempotency-key-collision',
  'transaction-not-completable',
  'settlement-read-incomplete',
]);

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40,64}$/i;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export class MergePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MergePolicyError';
    this.code = MERGE_FAILURE_CODES.includes(code) ? code : 'invalid-request';
  }
}

const fail = (code, message) => { throw new MergePolicyError(code, message); };
const token = (v, n) => (TOKEN.test(v || '') ? v : fail('invalid-request', `${n} is invalid`));
const sha = (v, n) => (SHA.test(v || '') ? v.toLowerCase() : fail('invalid-request', `${n} is invalid`));
const branch = (v, n) => (
  BRANCH.test(v || '') && !v.includes('..') && !v.includes('//') && !v.endsWith('/') && !v.endsWith('.lock') && !v.includes('@{')
    ? v : fail('invalid-request', `${n} is invalid`)
);
const text = (v, n, max = 2000) => {
  if (typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > max || /[\x00-\x1f\x7f]/.test(v) || v.includes('```')) {
    fail('invalid-request', `${n} is invalid`);
  }
  return v.trim();
};
const boolean = (v, n) => (typeof v === 'boolean' ? v : fail('invalid-request', `${n} must be a boolean`));
const positiveInt = (v, n, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => (
  Number.isInteger(v) && v >= min && v <= max ? v : fail('invalid-request', `${n} is invalid`)
);
const stable = (v) => (Array.isArray(v) ? v.map(stable) : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v));
const digest = (v) => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');

function normalizeGates(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-request', 'gates must be an object');
  const gates = {};
  for (const name of MERGE_HUMAN_GATE_NAMES) gates[name] = boolean(input[name], `gates.${name}`);
  return Object.freeze(gates);
}

function normalizeRequiredValidationProfiles(input) {
  if (!Array.isArray(input) || !input.length || input.length > 8) fail('invalid-request', 'requiredValidationProfiles is invalid');
  const seen = new Set();
  return Object.freeze(input.map((x) => {
    const profile = text(x?.profile, 'validation profile', 64);
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(profile) || seen.has(profile)) fail('invalid-request', 'validation profiles are invalid');
    seen.add(profile);
    return Object.freeze({ profile, validationId: token(x.validationId, 'validationId') });
  }).sort((a, b) => a.profile.localeCompare(b.profile)));
}

/**
 * Structural + identity normalization for a merge decision request. This
 * does not decide eligibility -- see evaluateMergeEligibility -- so a
 * well-formed but policy-ineligible request still normalizes successfully
 * and can be durably recorded/refused with a specific reason code.
 */
export function normalizeMergeDecisionRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-request', 'request must be an object');
  const projectId = token(input.projectId, 'projectId');
  const repository = REPO.test(input.repository || '') ? input.repository : fail('invalid-request', 'repository is invalid');
  const issueNumber = positiveInt(input.issueNumber, 'issueNumber');
  const prNumber = positiveInt(input.prNumber, 'prNumber');
  const sourceBranch = branch(input.sourceBranch, 'sourceBranch');
  const targetBranch = branch(input.targetBranch, 'targetBranch');
  if (sourceBranch === targetBranch) fail('invalid-request', 'source and target branches must differ');
  const expectedHeadSha = sha(input.expectedHeadSha, 'expectedHeadSha');
  const expectedBaseSha = sha(input.expectedBaseSha, 'expectedBaseSha');
  const managerRevision = text(input.managerRevision, 'managerRevision', 200);
  const managerFingerprint = /^sha256:[a-f0-9]{64}$/.test(input.managerFingerprint || '') ? input.managerFingerprint : fail('invalid-request', 'managerFingerprint is invalid');
  const executorJobId = token(input.executorJobId, 'executorJobId');
  const requestId = token(input.requestId, 'requestId');
  if (!LOCAL_EXECUTOR_RISK_CLASSES.includes(input.riskClass)) fail('invalid-request', 'riskClass is invalid');
  const gates = normalizeGates(input.gates);
  const automaticMergeAuthority = boolean(input.automaticMergeAuthority, 'automaticMergeAuthority');
  const requiredValidationProfiles = normalizeRequiredValidationProfiles(input.requiredValidationProfiles);
  const mergeMethod = MERGE_METHODS.includes(input.mergeMethod) ? input.mergeMethod : fail('invalid-request', 'mergeMethod is invalid');
  const requiredApprovals = positiveInt(input.requiredApprovals, 'requiredApprovals', { min: 0, max: 6 });
  const approvedScope = text(input.approvedScope, 'approvedScope', 2000);

  const identity = {
    schemaVersion: MERGE_POLICY_SCHEMA_VERSION, projectId, repository, prNumber, issueNumber,
    sourceBranch, targetBranch, expectedHeadSha, expectedBaseSha, managerRevision, managerFingerprint,
    executorJobId, riskClass: input.riskClass, gates, automaticMergeAuthority, requiredValidationProfiles,
    mergeMethod, requiredApprovals,
  };
  const idempotencyKey = `merge-transaction:${digest(identity)}`;
  return Object.freeze({
    schemaVersion: MERGE_POLICY_SCHEMA_VERSION, projectId, repository, issueNumber, prNumber,
    sourceBranch, targetBranch, expectedHeadSha, expectedBaseSha, managerRevision, managerFingerprint,
    executorJobId, requestId, riskClass: input.riskClass, gates, automaticMergeAuthority,
    requiredValidationProfiles, mergeMethod, requiredApprovals, approvedScope,
    idempotencyKey, transactionId: `merge-tx-${digest({ idempotencyKey, requestId }).slice(0, 48)}`,
  });
}

/**
 * Pure, default-deny merge-eligibility decision from an already-normalized
 * request. No I/O: this is the fast local refusal that runs before any
 * GitHub read, so ineligible work never triggers a network call.
 */
export function evaluateMergeEligibility(request) {
  if (!AUTOMATIC_MERGE_RISK_CLASSES.includes(request.riskClass)) {
    return Object.freeze({ eligible: false, reasonCode: 'high-risk-classification' });
  }
  for (const name of MERGE_HUMAN_GATE_NAMES) {
    if (request.gates[name] === true) return Object.freeze({ eligible: false, reasonCode: 'human-gate-required' });
  }
  if (request.automaticMergeAuthority !== true) {
    return Object.freeze({ eligible: false, reasonCode: 'automatic-merge-authority-missing' });
  }
  return Object.freeze({ eligible: true, reasonCode: null });
}

export const mapValidationFreshnessFailure = (reason) => (reason === 'validation-expired' ? 'validation-evidence-expired' : 'validation-evidence-failed');
