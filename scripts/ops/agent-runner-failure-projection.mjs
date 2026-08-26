#!/usr/bin/env node

/**
 * #230: canonical positive-allowlisted, bounded failure/status projection.
 * Pure projection only: no GitHub mutation, state mutation or process launch.
 */

import {
  IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH,
} from './agent-runner-candidate-admission.mjs';
import {
  RECOVERY_ACTIONS,
  TERMINAL_OUTCOMES,
} from './claude-runner-recovery.mjs';
import { REQUIRED_CAPABILITY_IDS } from './claude-runner-capability-model.mjs';
import {
  assertBoundedSafeText,
  assertNoUnknownFields,
  contentFingerprint,
  freezeArray,
  isPlainObject,
  nonEmptyString,
} from './agent-runner-manager-planner-safety.mjs';

export const FAILURE_PROJECTION_SCHEMA_VERSION = 'agent-runner-failure-projection/v1';
export const FAILURE_PROJECTION_INCIDENT_IDENTITY_VERSION = 'agent-runner-failure-incident/v1';

export const FAILURE_PROJECTION_EXECUTION_PHASES = Object.freeze([
  'candidate_admission',
  'capability_admission',
  'cost_admission',
  'attempt_creation',
  'workspace_preparation',
  'child_launch',
  'provider_invocation',
  'completed',
  'systemic',
]);

const ORDERED_PHASES = FAILURE_PROJECTION_EXECUTION_PHASES.filter((phase) => phase !== 'systemic');

export const FAILURE_PROJECTION_SCOPES = Object.freeze([
  'none',
  'machine_profile',
  'issue_not_runnable',
  'task_attempt',
  'systemic',
]);

export const FAILURE_PROJECTION_REASON_DOMAINS = Object.freeze([
  'none',
  'candidate_admission',
  'capability_admission',
  'cost_admission',
  'terminal_outcome',
  'unclassified',
]);

export const CANDIDATE_ADMISSION_REASONS = Object.freeze([
  'candidate-no-longer-runnable',
  'candidate-selection-changed',
  'candidate-label-authority-invalid',
  'candidate-status-field-label-conflict',
  'candidate-agent-field-label-conflict',
  'candidate-status-changed',
  'candidate-agent-changed',
  'candidate-dispatch-mode-changed',
  'candidate-manager-preflight-required',
  'candidate-proceed-command-not-authoritative',
  'candidate-manager-preflight-invalid',
  'candidate-preflight-agent-not-approved',
  'candidate-preflight-revision-changed',
  'candidate-preflight-content-changed',
  'candidate-preflight-comment-identity-unavailable',
  'candidate-preflight-author-not-approved',
  'candidate-approver-policy-invalid',
  'candidate-revalidation-unavailable',
  'candidate-revalidation-timeout',
]);

export const CAPABILITY_ADMISSION_REASONS = Object.freeze([IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH]);
export const COST_ADMISSION_REASONS = Object.freeze(['candidate-machine-profile-cost-denied']);
export const TERMINAL_OUTCOME_REASONS = Object.freeze(TERMINAL_OUTCOMES.filter((outcome) => outcome !== 'completed'));

const REASON_DOMAIN_VOCABULARY = Object.freeze({
  candidate_admission: CANDIDATE_ADMISSION_REASONS,
  capability_admission: CAPABILITY_ADMISSION_REASONS,
  cost_admission: COST_ADMISSION_REASONS,
  terminal_outcome: TERMINAL_OUTCOME_REASONS,
});

export const RECOVERY_STATUSES = Object.freeze(['not_needed', 'forbidden', 'eligible', 'exhausted', 'waiting']);
export const RECOVERY_DISPOSITION_ACTIONS = Object.freeze(['none', 'attention_required', ...RECOVERY_ACTIONS]);
export const CIRCUIT_STATES = Object.freeze(['tripped', 'clear', 'unknown']);
export const PROVIDER_INVOCATION_STATES = Object.freeze(['yes', 'no', 'unknown']);
export const DIAGNOSTIC_DOMAINS = Object.freeze([
  'candidate_admission',
  'capability_admission',
  'cost_admission',
  'workspace_ownership',
  'provider_invocation',
  'recovery_state',
  'terminal_outcome',
  'unclassified',
]);

const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const POLICY_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,198}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

const TOP_LEVEL_FIELDS = new Set([
  'policyRevision', 'managerAuthorityFingerprint', 'repository', 'project', 'issueNumber', 'attemptId',
  'agent', 'profile', 'model', 'executionPhase', 'candidateAdmissionCompleted', 'attemptCreated',
  'managerPacketConsumed', 'issueMutation', 'workspaceCreated', 'childLaunched', 'providerInvocationObserved',
  'failureScope', 'reasonDomain', 'reason', 'missingCapabilities', 'terminalOutcome', 'checkpointPresent',
  'worktreePresent', 'branchPresent', 'commitPresent', 'prPresent', 'dirty', 'hasChanges', 'recoveryStatus',
  'recoveryAction', 'recoveryEligible', 'circuitState', 'circuitDomain', 'safeNextAction',
  'deeperDiagnosticsRequired', 'diagnosticDomain',
]);

const FORBIDDEN_SOURCE_FIELD_PATTERN = /^(?:prompt|prompts|provider[-_]?output|provider[-_]?response|raw[-_]?output|transcript|stdout|stderr|logs?|stack|stacktrace|env|environment|token|claim[-_]?token|credential|secret|cookie|api[-_]?key|command|command[-_]?line|argv|worktree[-_]?path|local[-_]?path|path|cwd|packet[-_]?body|comment[-_]?body|restricted[-_]?handle|session[-_]?id|diff|file[-_]?contents?)$/i;

function assertNoForbiddenFieldNamesRecursive(value, path, errors, depth = 0) {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFieldNamesRecursive(item, `${path}[${index}]`, errors, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_SOURCE_FIELD_PATTERN.test(key)) {
      errors.push(`${path}.${key} is never projectable: prompts, provider output, logs/stacks, credentials, packet/comment bodies, restricted handles, local paths, command lines, diffs and file contents are not status`);
    }
    assertNoForbiddenFieldNamesRecursive(nested, `${path}.${key}`, errors, depth + 1);
  }
}

function nullableBoolean(value, label, errors) {
  if (value == null) return null;
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be a boolean or null`);
    return null;
  }
  return value;
}

function requiredEnum(value, label, allowed, errors) {
  if (!nonEmptyString(value) || !allowed.includes(value)) {
    errors.push(`${label} must be one of: ${allowed.join(', ')}`);
    return null;
  }
  return value;
}

function nullableEnum(value, label, allowed, errors) {
  if (value == null) return null;
  return requiredEnum(value, label, allowed, errors);
}

function nullableToken(value, label, errors, { pattern = TOKEN_PATTERN, max = 128 } = {}) {
  if (value == null) return null;
  if (!nonEmptyString(value) || value.trim().length > max || !pattern.test(value.trim())) {
    errors.push(`${label} must be a bounded machine-safe token when present`);
    return null;
  }
  return value.trim();
}

function phaseIndex(phase) {
  return ORDERED_PHASES.indexOf(phase);
}

function beforePhase(executionPhase, threshold) {
  if (executionPhase === 'systemic') return false;
  return phaseIndex(executionPhase) < phaseIndex(threshold);
}

function phaseAwareAbsentBoolean(value, executionPhase, threshold = null) {
  if (value === true || value === false) return value;
  if (threshold && beforePhase(executionPhase, threshold)) return false;
  return null;
}

function assertLifecycleConsistency({
  executionPhase,
  candidateAdmissionCompleted,
  attemptCreated,
  workspaceCreated,
  childLaunched,
  providerInvocationObserved,
  failureScope,
  deeperDiagnosticsRequired,
  diagnosticDomain,
}, errors) {
  if (executionPhase === 'systemic') {
    if (failureScope !== 'systemic') errors.push('failureScope must be systemic when executionPhase is systemic');
    if (deeperDiagnosticsRequired !== true) errors.push('deeperDiagnosticsRequired must be true when executionPhase is systemic');
    if (!diagnosticDomain) errors.push('diagnosticDomain is required when executionPhase is systemic');
    return;
  }

  const index = phaseIndex(executionPhase);
  const atLeast = (phase) => index >= phaseIndex(phase);

  if (candidateAdmissionCompleted === false && atLeast('attempt_creation')) {
    errors.push('executionPhase at/after attempt_creation cannot assert candidateAdmissionCompleted false');
  }
  if (attemptCreated === true && !atLeast('attempt_creation')) {
    errors.push('attemptCreated cannot be true before executionPhase reaches attempt_creation');
  }
  if (attemptCreated === false && index > phaseIndex('attempt_creation')) {
    errors.push('executionPhase beyond attempt_creation cannot assert attemptCreated false');
  }
  if (workspaceCreated === true && !atLeast('workspace_preparation')) {
    errors.push('workspaceCreated cannot be true before executionPhase reaches workspace_preparation');
  }
  if (workspaceCreated === false && index > phaseIndex('workspace_preparation')) {
    errors.push('executionPhase beyond workspace_preparation cannot assert workspaceCreated false');
  }
  if (childLaunched === true && !atLeast('child_launch')) {
    errors.push('childLaunched cannot be true before executionPhase reaches child_launch');
  }
  if (childLaunched === false && index > phaseIndex('child_launch')) {
    errors.push('executionPhase beyond child_launch cannot assert childLaunched false');
  }
  if (attemptCreated === false && (workspaceCreated === true || childLaunched === true)) {
    errors.push('workspaceCreated/childLaunched cannot be true when attemptCreated is false');
  }
  if (workspaceCreated === false && childLaunched === true) {
    errors.push('childLaunched cannot be true when workspaceCreated is false');
  }
  if (childLaunched === false && providerInvocationObserved === 'yes') {
    errors.push('providerInvocationObserved cannot be yes when childLaunched is false');
  }
  if (childLaunched === false && providerInvocationObserved !== 'no') {
    errors.push('providerInvocationObserved must be no when childLaunched is false');
  }
  if (providerInvocationObserved === 'yes' && !atLeast('provider_invocation')) {
    errors.push('providerInvocationObserved cannot be yes before executionPhase reaches provider_invocation');
  }
}

function assertReasonConsistency({ failureScope, reasonDomain, reason, terminalOutcome, missingCapabilities }, errors) {
  if (failureScope === 'none') {
    if (reasonDomain !== 'none' || reason !== null) errors.push('failureScope none requires reasonDomain none and reason null');
  } else if (failureScope === 'systemic') {
    if (reasonDomain !== 'unclassified' || reason !== null) errors.push('failureScope systemic requires reasonDomain unclassified and reason null');
  } else if (failureScope === 'machine_profile') {
    if (!['capability_admission', 'cost_admission'].includes(reasonDomain)) {
      errors.push('failureScope machine_profile requires reasonDomain capability_admission or cost_admission');
    }
  } else if (failureScope === 'issue_not_runnable') {
    if (reasonDomain !== 'candidate_admission') errors.push('failureScope issue_not_runnable requires reasonDomain candidate_admission');
  } else if (failureScope === 'task_attempt') {
    if (reasonDomain !== 'terminal_outcome') errors.push('failureScope task_attempt requires reasonDomain terminal_outcome');
  }

  if (reasonDomain !== 'none' && reasonDomain !== 'unclassified') {
    const vocabulary = REASON_DOMAIN_VOCABULARY[reasonDomain];
    if (!vocabulary || !vocabulary.includes(reason)) {
      errors.push(`reason must be a known ${reasonDomain} reason when reasonDomain is ${reasonDomain}`);
    }
  }

  if (reasonDomain !== 'capability_admission' && missingCapabilities.length > 0) {
    errors.push('missingCapabilities must be empty unless reasonDomain is capability_admission');
  }

  if (terminalOutcome === 'completed' && failureScope !== 'none') {
    errors.push('terminalOutcome completed requires failureScope none');
  }
}

function assertAttemptIdentityConsistency({ attemptId, attemptCreated, failureScope }, errors) {
  if ((attemptCreated === true || failureScope === 'task_attempt') && !attemptId) {
    errors.push('a real attemptId is required when attemptCreated is true or failureScope is task_attempt');
  }
}

function validateMissingCapabilities(input, errors) {
  if (input == null) return freezeArray([]);
  if (!Array.isArray(input)) {
    errors.push('missingCapabilities must be an array when present');
    return freezeArray([]);
  }
  if (input.length > REQUIRED_CAPABILITY_IDS.length) {
    errors.push(`missingCapabilities must contain at most ${REQUIRED_CAPABILITY_IDS.length} entries`);
  }
  const bounded = input.filter((id) => {
    if (!nonEmptyString(id) || !REQUIRED_CAPABILITY_IDS.includes(id)) {
      errors.push(`missingCapabilities entries must be known #228 capability identifiers; refused: ${JSON.stringify(id)}`);
      return false;
    }
    return true;
  });
  return freezeArray(bounded);
}

function buildCandidateFingerprint({ repository, project, issueNumber, agent, policyRevision, managerAuthorityFingerprint }) {
  return contentFingerprint(Object.freeze({
    identityVersion: 'agent-runner-failure-candidate/v1',
    repository,
    project,
    issueNumber,
    agent,
    policyRevision,
    managerAuthorityFingerprint,
  }));
}

function buildIncidentFingerprint({
  repository,
  issueNumber,
  policyRevision,
  candidateFingerprint,
  managerAuthorityFingerprint,
  attemptId,
  failureScope,
  reason,
  terminalOutcome,
  attemptCreated,
}) {
  const postAttempt = attemptCreated === true || failureScope === 'task_attempt';
  const material = postAttempt
    ? Object.freeze({
        identityVersion: FAILURE_PROJECTION_INCIDENT_IDENTITY_VERSION,
        phase: 'post-attempt',
        repository,
        issueNumber,
        attemptId,
        failureScope,
        reason,
        terminalOutcome,
        policyRevision,
      })
    : Object.freeze({
        identityVersion: FAILURE_PROJECTION_INCIDENT_IDENTITY_VERSION,
        phase: 'pre-attempt',
        repository,
        issueNumber,
        candidateFingerprint,
        managerAuthorityFingerprint,
        failureScope,
        reason,
        policyRevision,
      });
  return contentFingerprint(material);
}

export function buildFailureProjection(input) {
  if (!isPlainObject(input)) throw new Error('Invalid agent runner failure projection: input must be an object');
  const errors = [];
  assertNoForbiddenFieldNamesRecursive(input, 'projection', errors);
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'projection', errors);
  if (errors.length) throw new Error(`Invalid agent runner failure projection: ${errors.join('; ')}`);

  const policyRevision = nullableToken(input.policyRevision, 'policyRevision', errors, {
    pattern: POLICY_REVISION_PATTERN,
    max: 199,
  });
  const managerAuthorityFingerprint = nullableToken(
    input.managerAuthorityFingerprint,
    'managerAuthorityFingerprint',
    errors,
    { pattern: FINGERPRINT_PATTERN, max: 71 },
  );
  if (!nonEmptyString(input.repository) || !REPOSITORY_PATTERN.test(input.repository)) {
    errors.push('repository must be a bounded "owner/name" identity');
  }
  const project = nullableToken(input.project, 'project', errors, { max: 128 });
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) errors.push('issueNumber must be a positive integer');
  const attemptId = nullableToken(input.attemptId, 'attemptId', errors, { pattern: ID_PATTERN, max: 128 });
  const agent = nullableToken(input.agent, 'agent', errors, { max: 128 });
  const profile = nullableToken(input.profile, 'profile', errors, { max: 64 });
  const model = nullableToken(input.model, 'model', errors, { max: 64 });

  const executionPhase = requiredEnum(input.executionPhase, 'executionPhase', FAILURE_PROJECTION_EXECUTION_PHASES, errors);
  const candidateAdmissionCompleted = nullableBoolean(input.candidateAdmissionCompleted, 'candidateAdmissionCompleted', errors);
  const attemptCreated = nullableBoolean(input.attemptCreated, 'attemptCreated', errors);
  const managerPacketConsumed = nullableBoolean(input.managerPacketConsumed, 'managerPacketConsumed', errors);
  const issueMutation = nullableBoolean(input.issueMutation, 'issueMutation', errors);
  const workspaceCreated = nullableBoolean(input.workspaceCreated, 'workspaceCreated', errors);
  const childLaunched = nullableBoolean(input.childLaunched, 'childLaunched', errors);
  const providerInvocationObserved = requiredEnum(input.providerInvocationObserved, 'providerInvocationObserved', PROVIDER_INVOCATION_STATES, errors);

  const failureScope = requiredEnum(input.failureScope, 'failureScope', FAILURE_PROJECTION_SCOPES, errors);
  const reasonDomain = requiredEnum(input.reasonDomain, 'reasonDomain', FAILURE_PROJECTION_REASON_DOMAINS, errors);
  const reason = nullableToken(input.reason, 'reason', errors, {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    max: 128,
  });
  const missingCapabilities = validateMissingCapabilities(input.missingCapabilities, errors);
  const terminalOutcome = nullableEnum(input.terminalOutcome, 'terminalOutcome', TERMINAL_OUTCOMES, errors);

  const checkpointPresent = nullableBoolean(input.checkpointPresent, 'checkpointPresent', errors);
  const worktreePresent = nullableBoolean(input.worktreePresent, 'worktreePresent', errors);
  const branchPresent = nullableBoolean(input.branchPresent, 'branchPresent', errors);
  const commitPresent = nullableBoolean(input.commitPresent, 'commitPresent', errors);
  const prPresent = nullableBoolean(input.prPresent, 'prPresent', errors);
  const dirty = nullableBoolean(input.dirty, 'dirty', errors);
  const hasChanges = nullableBoolean(input.hasChanges, 'hasChanges', errors);

  const recoveryStatus = nullableEnum(input.recoveryStatus, 'recoveryStatus', RECOVERY_STATUSES, errors);
  const recoveryAction = nullableEnum(input.recoveryAction, 'recoveryAction', RECOVERY_DISPOSITION_ACTIONS, errors);
  const recoveryEligible = nullableBoolean(input.recoveryEligible, 'recoveryEligible', errors);
  const circuitState = nullableEnum(input.circuitState, 'circuitState', CIRCUIT_STATES, errors);
  const circuitDomain = nullableToken(input.circuitDomain, 'circuitDomain', errors, { max: 64 });

  const safeNextActionErrorsBefore = errors.length;
  assertBoundedSafeText(input.safeNextAction, 'safeNextAction', errors, { max: 500, allowWriteActionScan: false });
  const safeNextAction = errors.length === safeNextActionErrorsBefore ? input.safeNextAction.trim() : 'invalid';

  const deeperDiagnosticsRequired = nullableBoolean(input.deeperDiagnosticsRequired, 'deeperDiagnosticsRequired', errors);
  const diagnosticDomain = nullableEnum(input.diagnosticDomain, 'diagnosticDomain', DIAGNOSTIC_DOMAINS, errors);
  if (deeperDiagnosticsRequired === true && !diagnosticDomain) {
    errors.push('diagnosticDomain is required when deeperDiagnosticsRequired is true');
  }
  if (deeperDiagnosticsRequired !== true && diagnosticDomain) {
    errors.push('diagnosticDomain requires deeperDiagnosticsRequired to be true');
  }

  if (errors.length === 0) {
    assertLifecycleConsistency({
      executionPhase,
      candidateAdmissionCompleted,
      attemptCreated,
      workspaceCreated,
      childLaunched,
      providerInvocationObserved,
      failureScope,
      deeperDiagnosticsRequired,
      diagnosticDomain,
    }, errors);
    assertReasonConsistency({ failureScope, reasonDomain, reason, terminalOutcome, missingCapabilities }, errors);
    assertAttemptIdentityConsistency({ attemptId, attemptCreated, failureScope }, errors);
  }

  if (errors.length) throw new Error(`Invalid agent runner failure projection: ${errors.join('; ')}`);

  const candidateFingerprint = buildCandidateFingerprint({
    repository: input.repository,
    project,
    issueNumber: input.issueNumber,
    agent,
    policyRevision,
    managerAuthorityFingerprint,
  });

  const projection = Object.freeze({
    schemaVersion: FAILURE_PROJECTION_SCHEMA_VERSION,
    policyRevision,
    managerAuthorityFingerprint,
    candidateFingerprint,
    repository: input.repository,
    project,
    issueNumber: input.issueNumber,
    attemptId,
    agent,
    profile,
    model,
    executionPhase,
    candidateAdmissionCompleted,
    attemptCreated,
    managerPacketConsumed,
    issueMutation,
    workspaceCreated,
    childLaunched,
    providerInvocationObserved,
    failureScope,
    reasonDomain,
    reason,
    missingCapabilities,
    terminalOutcome,
    checkpointPresent,
    worktreePresent,
    branchPresent,
    commitPresent,
    prPresent,
    dirty,
    hasChanges,
    recoveryStatus,
    recoveryAction,
    recoveryEligible,
    circuitState,
    circuitDomain,
    safeNextAction,
    deeperDiagnosticsRequired,
    diagnosticDomain,
  });

  const incidentFingerprint = buildIncidentFingerprint({ ...projection, candidateFingerprint });
  return Object.freeze({
    ...projection,
    incidentFingerprint,
    projectionFingerprint: contentFingerprint(projection),
  });
}

export function deriveFailureProjection(source = {}) {
  if (!isPlainObject(source)) throw new Error('deriveFailureProjection requires a source-state object');

  const executionPhase = source.executionPhase;
  const attemptCreated = phaseAwareAbsentBoolean(source.attemptCreated, executionPhase, 'attempt_creation');
  const workspaceCreated = phaseAwareAbsentBoolean(source.workspaceCreated, executionPhase, 'workspace_preparation');
  const childLaunched = phaseAwareAbsentBoolean(source.childLaunched, executionPhase, 'child_launch');
  const providerInvocationObserved = source.providerInvocationObserved
    ?? (executionPhase !== 'systemic' && beforePhase(executionPhase, 'provider_invocation') ? 'no' : null)
    ?? (childLaunched === false ? 'no' : 'unknown');

  return buildFailureProjection({
    policyRevision: source.policyRevision ?? null,
    managerAuthorityFingerprint: source.managerAuthorityFingerprint ?? source.preflightFingerprint ?? null,
    repository: source.repository,
    project: source.project ?? null,
    issueNumber: source.issueNumber,
    attemptId: source.attemptId ?? null,
    agent: source.agent ?? null,
    profile: source.profile ?? null,
    model: source.model ?? null,
    executionPhase,
    candidateAdmissionCompleted: source.candidateAdmissionCompleted ?? null,
    attemptCreated,
    managerPacketConsumed: source.managerPacketConsumed ?? null,
    issueMutation: source.issueMutation ?? null,
    workspaceCreated,
    childLaunched,
    providerInvocationObserved,
    failureScope: source.failureScope,
    reasonDomain: source.reasonDomain,
    reason: source.reason ?? null,
    missingCapabilities: source.missingCapabilities ?? [],
    terminalOutcome: source.terminalOutcome ?? null,
    checkpointPresent: source.checkpointPresent ?? null,
    worktreePresent: source.worktreePresent ?? null,
    branchPresent: source.branchPresent ?? null,
    commitPresent: source.commitPresent ?? null,
    prPresent: source.prPresent ?? null,
    dirty: source.dirty ?? null,
    hasChanges: source.hasChanges ?? null,
    recoveryStatus: source.recoveryStatus ?? null,
    recoveryAction: source.recoveryAction ?? null,
    recoveryEligible: source.recoveryEligible ?? null,
    circuitState: source.circuitState ?? null,
    circuitDomain: source.circuitDomain ?? null,
    safeNextAction: source.safeNextAction,
    deeperDiagnosticsRequired: source.deeperDiagnosticsRequired ?? null,
    diagnosticDomain: source.diagnosticDomain ?? null,
  });
}
