#!/usr/bin/env node

/**
 * #230: the one canonical, positive-allowlisted, bounded failure/status
 * projection deterministically derived from existing runner state.
 *
 * This is the first bounded slice of #209: it owns only the typed schema,
 * the strict validating builder (`buildFailureProjection`) and the lenient
 * source-state extractor (`deriveFailureProjection`). Neither function ever
 * calls GitHub, mutates state or launches a process -- this module is pure.
 *
 * Two properties matter most and are enforced here rather than at call
 * sites:
 *
 *  1. **Positive allowlist.** Every field is named, typed and bounded.
 *     `buildFailureProjection` throws on any unrecognized top-level field
 *     rather than passing it through, and `deriveFailureProjection` never
 *     spreads a raw source object -- it only reads the exact named
 *     properties this module knows about, so a new/unrecognized
 *     source-state field (prompts, provider stdout/stderr, raw logs,
 *     credentials, manager packet bodies, restricted handles, local paths,
 *     process command lines, diffs, file contents) is excluded by default,
 *     never serialized.
 *
 *  2. **Exact known reasons.** The reason vocabulary is imported directly
 *     from the existing typed terminal-outcome (`claude-runner-recovery.mjs`)
 *     and tool-capability (`agent-runner-candidate-admission.mjs`) sources
 *     rather than re-invented, so a known cost/tool-capability/budget/
 *     no-change/workspace reason is never collapsed into a generic
 *     `unknown_failure` here.
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

/** The furthest execution phase this attempt/candidate is known to have reached. */
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

// Ordering used for internal boolean/phase consistency checks. `systemic` is
// deliberately excluded -- it is an escape hatch for a state that could not
// be classified into the ordered lifecycle at all.
const ORDERED_PHASES = FAILURE_PROJECTION_EXECUTION_PHASES.filter((phase) => phase !== 'systemic');

/** Where, structurally, a failure/status originates. */
export const FAILURE_PROJECTION_SCOPES = Object.freeze([
  'none',
  'machine_profile',
  'issue_not_runnable',
  'task_attempt',
  'systemic',
]);

/** The bounded reason-vocabulary domain the `reason` field belongs to. */
export const FAILURE_PROJECTION_REASON_DOMAINS = Object.freeze([
  'none',
  'candidate_admission',
  'capability_admission',
  'cost_admission',
  'terminal_outcome',
  'unclassified',
]);

/**
 * Pre-attempt candidate-admission identity/label/preflight refusal reasons
 * (`agent-runner-candidate-admission.mjs` `evaluateCandidateAdmission()` /
 * `approverPolicy()` / revalidation failures). Deliberately excludes the
 * `candidate-admitted` success reason -- this projection's `reason` field is
 * scoped to failure/status evidence, not positive admission outcomes, which
 * are already represented by the `candidateAdmissionCompleted` boolean.
 */
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

/** Pre-provider #228 tool-capability admission refusal reasons. */
export const CAPABILITY_ADMISSION_REASONS = Object.freeze([IMPLEMENTATION_TOOL_CAPABILITY_MISMATCH]);

/** Pre-attempt machine-profile/cost admission refusal reasons. */
export const COST_ADMISSION_REASONS = Object.freeze(['candidate-machine-profile-cost-denied']);

/**
 * Post-launch typed terminal outcomes (`claude-runner-recovery.mjs`),
 * excluding `completed` -- a completed attempt is represented by
 * `failureScope: 'none'`, not a `task_attempt` failure reason.
 */
export const TERMINAL_OUTCOME_REASONS = Object.freeze(TERMINAL_OUTCOMES.filter((outcome) => outcome !== 'completed'));

const REASON_DOMAIN_VOCABULARY = Object.freeze({
  candidate_admission: CANDIDATE_ADMISSION_REASONS,
  capability_admission: CAPABILITY_ADMISSION_REASONS,
  cost_admission: COST_ADMISSION_REASONS,
  terminal_outcome: TERMINAL_OUTCOME_REASONS,
});

/** The recovery decision `status` vocabulary from `decideRecovery()`. */
export const RECOVERY_STATUSES = Object.freeze(['not_needed', 'forbidden', 'eligible', 'exhausted', 'waiting']);

/** The recovery `action` vocabulary: `decideRecovery()`'s non-retry actions plus every bounded retry action. */
export const RECOVERY_DISPOSITION_ACTIONS = Object.freeze(['none', 'attention_required', ...RECOVERY_ACTIONS]);

export const CIRCUIT_STATES = Object.freeze(['tripped', 'clear', 'unknown']);

export const PROVIDER_INVOCATION_STATES = Object.freeze(['yes', 'no', 'unknown']);

/** Small allowlisted diagnostic-domain enum for when safe evidence cannot determine a next action. */
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
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,127}$/;

const TOP_LEVEL_FIELDS = new Set([
  'policyRevision', 'repository', 'project', 'issueNumber', 'attemptId', 'agent', 'profile', 'model',
  'executionPhase', 'candidateAdmissionCompleted', 'attemptCreated', 'managerPacketConsumed', 'issueMutation',
  'workspaceCreated', 'childLaunched', 'providerInvocationObserved', 'failureScope', 'reasonDomain', 'reason',
  'missingCapabilities', 'terminalOutcome', 'checkpointPresent', 'worktreePresent', 'branchPresent',
  'commitPresent', 'prPresent', 'dirty', 'hasChanges', 'recoveryStatus', 'recoveryAction', 'recoveryEligible',
  'circuitState', 'circuitDomain', 'safeNextAction', 'deeperDiagnosticsRequired', 'diagnosticDomain',
]);

/**
 * Field names refused at any depth of a raw source-state object handed to
 * `deriveFailureProjection`. Defense in depth alongside the fact that the
 * derivation function only ever reads specific named properties: an
 * adversarial source object can carry any of these under any key path and
 * they must never reach the projection.
 */
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

function requiredBoolean(value, label, errors) {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be a boolean`);
    return false;
  }
  return value;
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

/**
 * Fail-closed lifecycle consistency: side-effect booleans must not claim
 * something happened before the phase that would allow it, and must not
 * claim a later phase happened while denying its own prerequisite.
 */
function assertLifecycleConsistency({ executionPhase, candidateAdmissionCompleted, attemptCreated, workspaceCreated, childLaunched, providerInvocationObserved, failureScope, deeperDiagnosticsRequired, diagnosticDomain }, errors) {
  if (executionPhase === 'systemic') {
    if (failureScope !== 'systemic') errors.push('failureScope must be systemic when executionPhase is systemic');
    if (deeperDiagnosticsRequired !== true) errors.push('deeperDiagnosticsRequired must be true when executionPhase is systemic');
    if (!diagnosticDomain) errors.push('diagnosticDomain is required when executionPhase is systemic');
    return;
  }

  const index = phaseIndex(executionPhase);
  const atLeast = (phase) => index >= phaseIndex(phase);

  if (!candidateAdmissionCompleted && atLeast('attempt_creation')) {
    errors.push('attemptCreated-bearing executionPhase requires candidateAdmissionCompleted to be true');
  }
  if (attemptCreated && !atLeast('attempt_creation')) errors.push('attemptCreated cannot be true before executionPhase reaches attempt_creation');
  if (!attemptCreated && atLeast('attempt_creation') && index > phaseIndex('attempt_creation')) {
    errors.push('executionPhase beyond attempt_creation requires attemptCreated to be true');
  }
  if (workspaceCreated && !atLeast('workspace_preparation')) errors.push('workspaceCreated cannot be true before executionPhase reaches workspace_preparation');
  if (childLaunched && !atLeast('child_launch')) errors.push('childLaunched cannot be true before executionPhase reaches child_launch');
  if (!attemptCreated && (workspaceCreated || childLaunched)) errors.push('workspaceCreated/childLaunched cannot be true when attemptCreated is false');
  if (!workspaceCreated && childLaunched) errors.push('childLaunched cannot be true when workspaceCreated is false');
  if (!childLaunched && providerInvocationObserved === 'yes') errors.push('providerInvocationObserved cannot be yes when childLaunched is false');
  if (!childLaunched && providerInvocationObserved !== 'no') errors.push('providerInvocationObserved must be no when childLaunched is false');
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

/**
 * Build one validated, deterministic failure/status projection.
 *
 * Throws on anything that is not positively allowlisted or internally
 * inconsistent, so a caller can never accidentally widen what this
 * projection publishes or assert an impossible lifecycle state.
 */
export function buildFailureProjection(input) {
  if (!isPlainObject(input)) throw new Error('Invalid agent runner failure projection: input must be an object');
  const errors = [];
  assertNoForbiddenFieldNamesRecursive(input, 'projection', errors);
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'projection', errors);
  if (errors.length) throw new Error(`Invalid agent runner failure projection: ${errors.join('; ')}`);

  const policyRevision = nullableToken(input.policyRevision, 'policyRevision', errors, { max: 199 });
  if (!nonEmptyString(input.repository) || !REPOSITORY_PATTERN.test(input.repository)) errors.push('repository must be a bounded "owner/name" identity');
  const project = nullableToken(input.project, 'project', errors, { max: 128 });
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) errors.push('issueNumber must be a positive integer');
  const attemptId = nullableToken(input.attemptId, 'attemptId', errors, { pattern: ID_PATTERN, max: 128 });
  const agent = nullableToken(input.agent, 'agent', errors, { max: 128 });
  const profile = nullableToken(input.profile, 'profile', errors, { max: 64 });
  const model = nullableToken(input.model, 'model', errors, { max: 64 });

  const executionPhase = requiredEnum(input.executionPhase, 'executionPhase', FAILURE_PROJECTION_EXECUTION_PHASES, errors);
  const candidateAdmissionCompleted = requiredBoolean(input.candidateAdmissionCompleted, 'candidateAdmissionCompleted', errors);
  const attemptCreated = requiredBoolean(input.attemptCreated, 'attemptCreated', errors);
  const managerPacketConsumed = requiredBoolean(input.managerPacketConsumed, 'managerPacketConsumed', errors);
  const issueMutation = requiredBoolean(input.issueMutation, 'issueMutation', errors);
  const workspaceCreated = requiredBoolean(input.workspaceCreated, 'workspaceCreated', errors);
  const childLaunched = requiredBoolean(input.childLaunched, 'childLaunched', errors);
  const providerInvocationObserved = requiredEnum(input.providerInvocationObserved, 'providerInvocationObserved', PROVIDER_INVOCATION_STATES, errors);

  const failureScope = requiredEnum(input.failureScope, 'failureScope', FAILURE_PROJECTION_SCOPES, errors);
  const reasonDomain = requiredEnum(input.reasonDomain, 'reasonDomain', FAILURE_PROJECTION_REASON_DOMAINS, errors);
  const reason = nullableToken(input.reason, 'reason', errors, { pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, max: 128 });
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

  const deeperDiagnosticsRequired = requiredBoolean(input.deeperDiagnosticsRequired, 'deeperDiagnosticsRequired', errors);
  const diagnosticDomain = nullableEnum(input.diagnosticDomain, 'diagnosticDomain', DIAGNOSTIC_DOMAINS, errors);
  if (deeperDiagnosticsRequired === true && !diagnosticDomain) errors.push('diagnosticDomain is required when deeperDiagnosticsRequired is true');
  if (deeperDiagnosticsRequired === false && diagnosticDomain) errors.push('diagnosticDomain must be null when deeperDiagnosticsRequired is false');

  if (errors.length === 0) {
    assertLifecycleConsistency({
      executionPhase, candidateAdmissionCompleted, attemptCreated, workspaceCreated, childLaunched,
      providerInvocationObserved, failureScope, deeperDiagnosticsRequired, diagnosticDomain,
    }, errors);
    assertReasonConsistency({ failureScope, reasonDomain, reason, terminalOutcome, missingCapabilities }, errors);
  }

  if (errors.length) throw new Error(`Invalid agent runner failure projection: ${errors.join('; ')}`);

  const projection = Object.freeze({
    schemaVersion: FAILURE_PROJECTION_SCHEMA_VERSION,
    policyRevision,
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
  return Object.freeze({ ...projection, projectionFingerprint: contentFingerprint(projection) });
}

/**
 * Lenient extraction boundary: reads only the exact named safe properties
 * this module knows about from an arbitrary/untrusted-shaped source-state
 * object, ignoring every other property (including adversarial ones such as
 * `prompt`, `stdout`, credentials, local paths or manager packet bodies),
 * then validates the derived canonical object exactly like
 * `buildFailureProjection`. New/unrecognized source-state fields are
 * excluded by default because they are never read in the first place.
 */
export function deriveFailureProjection(source = {}) {
  if (!isPlainObject(source)) throw new Error('deriveFailureProjection requires a source-state object');
  return buildFailureProjection({
    policyRevision: source.policyRevision ?? null,
    repository: source.repository,
    project: source.project ?? null,
    issueNumber: source.issueNumber,
    attemptId: source.attemptId ?? null,
    agent: source.agent ?? null,
    profile: source.profile ?? null,
    model: source.model ?? null,
    executionPhase: source.executionPhase,
    candidateAdmissionCompleted: source.candidateAdmissionCompleted === true,
    attemptCreated: source.attemptCreated === true,
    managerPacketConsumed: source.managerPacketConsumed === true,
    issueMutation: source.issueMutation === true,
    workspaceCreated: source.workspaceCreated === true,
    childLaunched: source.childLaunched === true,
    providerInvocationObserved: source.providerInvocationObserved ?? (source.childLaunched === true ? 'unknown' : 'no'),
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
    deeperDiagnosticsRequired: source.deeperDiagnosticsRequired === true,
    diagnosticDomain: source.diagnosticDomain ?? null,
  });
}
