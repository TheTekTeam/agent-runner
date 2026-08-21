#!/usr/bin/env node

/**
 * #268: the bounded, deterministic per-project management status projection.
 *
 * This is the one surface an operator or dashboard reads to answer: is
 * management running, what is pending, what is being reconciled, why is work
 * blocked, is a worker active, what is next, does owner attention exist, and is
 * the control plane shadow/active/fenced.
 *
 * Two properties matter most and are enforced here rather than at the call
 * sites:
 *
 *  1. **Positive allowlist.** Every field is named, typed and bounded. Free
 *     text passes the shared safety scan, so a prompt, provider transcript, raw
 *     comment, log line, credential, environment value, command line or
 *     machine-local path can never reach a projection. Unknown fields are
 *     refused rather than passed through.
 *
 *  2. **Semantic dedupe.** The fingerprint deliberately excludes `updatedAt`,
 *     so re-projecting an unchanged project yields an identical fingerprint and
 *     the store leaves the record alone. Only a real semantic change advances
 *     the revision, which is what stops a polling dashboard from churning.
 *
 * The module is pure: no clock, no I/O, no database, no network.
 */

import {
  assertBoundedSafeText,
  assertBoundedSafeTextArray,
  assertNoUnknownFields,
  contentFingerprint,
  freezeArray,
  isPlainObject,
  nonEmptyString,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_STATUS_PROJECTION_SCHEMA_VERSION = 'agent-runner-management-status-projection/v1';

/** Bounded lifecycle states a project may be projected in. */
export const PROJECTION_LIFECYCLE_STATES = Object.freeze([
  'idle',
  'planning',
  'awaiting-execution',
  'implementation-active',
  'awaiting-checks',
  'awaiting-review',
  'blocked',
  'owner-attention',
  'quiescent',
]);

/** Bounded classifications of the next required management action. */
export const PROJECTION_NEXT_ACTIONS = Object.freeze([
  'none',
  'programme-reconcile',
  'execution-reconcile',
  'queue-assurance',
  'delayed-retry',
  'owner-decision',
]);

/** The management event types a projection may name as the next required event. */
const NEXT_EVENT_TYPES = Object.freeze([
  'programme-reconcile-required',
  'execution-reconcile-required',
  'queue-assurance-required',
]);

const TOP_LEVEL_FIELDS = new Set([
  'projectId', 'repository', 'objective', 'planRevision', 'milestones', 'counts',
  'criticalPath', 'currentEvent', 'lifecycleState', 'recentDecisions', 'risks',
  'blockers', 'nextAction', 'ownerAttentionRequired', 'controlMode', 'updatedAt',
]);
const MILESTONE_FIELDS = new Set(['id', 'title', 'total', 'completed', 'blocked']);
const COUNT_FIELDS = new Set(['ready', 'inProgress', 'blocked', 'review', 'completed']);
const CRITICAL_PATH_FIELDS = new Set(['curationKey', 'issueNumber', 'readiness']);
const CURRENT_EVENT_FIELDS = new Set(['eventId', 'eventType', 'state']);
const DECISION_FIELDS = new Set(['eventId', 'role', 'outcome', 'recordedAt']);
const NEXT_ACTION_FIELDS = new Set(['classification', 'eventType', 'notBefore']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const CURATION_KEY_PATTERN = /^qc:[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const MAX_MILESTONES = 20;
const MAX_CRITICAL_PATH = 20;
const MAX_DECISIONS = 10;
const MAX_RISKS = 10;

/**
 * Field names refused at any depth. A projection is bounded status, never a
 * carrier for provider output, credentials, environment data or local paths.
 */
const FORBIDDEN_FIELD_NAME_PATTERN = /^(?:prompt|prompts|provider[-_]?output|provider[-_]?response|raw[-_]?output|transcript|stdout|stderr|logs?|env|environment|token|claim[-_]?token|credential|secret|cookie|api[-_]?key|command|command[-_]?line|worktree[-_]?path|local[-_]?path|path|cwd|balance|credits?)$/i;

const VALIDATED_PROJECTIONS = new WeakSet();

function assertNoForbiddenFieldNamesRecursive(value, path, errors, depth = 0) {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFieldNamesRecursive(item, `${path}[${index}]`, errors, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAME_PATTERN.test(key)) {
      errors.push(`${path}.${key} is never projectable: prompts, provider output, logs, environment, credentials, claim tokens, command lines and local paths are not status`);
    }
    assertNoForbiddenFieldNamesRecursive(nested, `${path}.${key}`, errors, depth + 1);
  }
}

function boundedCount(value, label, errors) {
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    errors.push(`${label} must be a bounded non-negative integer`);
    return 0;
  }
  return value;
}

function requiredToken(value, label, allowed, errors) {
  if (!nonEmptyString(value) || !TOKEN_PATTERN.test(value)) {
    errors.push(`${label} must be a bounded machine-safe token`);
    return null;
  }
  if (allowed && !allowed.includes(value)) {
    errors.push(`${label} '${value}' is not one of: ${allowed.join(', ')}`);
    return null;
  }
  return value;
}

function validateMilestones(input, errors) {
  if (!Array.isArray(input)) {
    errors.push('milestones must be an array');
    return freezeArray([]);
  }
  if (input.length > MAX_MILESTONES) errors.push(`milestones must contain at most ${MAX_MILESTONES} entries`);
  return freezeArray(input.slice(0, MAX_MILESTONES).map((milestone, index) => {
    const label = `milestones[${index}]`;
    if (!isPlainObject(milestone)) {
      errors.push(`${label} must be an object`);
      return Object.freeze({ id: 'invalid', title: 'invalid', total: 0, completed: 0, blocked: 0 });
    }
    assertNoUnknownFields(milestone, MILESTONE_FIELDS, label, errors);
    const id = requiredToken(milestone.id, `${label}.id`, null, errors) ?? 'invalid';
    assertBoundedSafeText(milestone.title, `${label}.title`, errors, { max: 200, allowWriteActionScan: false });
    return Object.freeze({
      id,
      title: nonEmptyString(milestone.title) ? milestone.title.trim() : 'invalid',
      total: boundedCount(milestone.total, `${label}.total`, errors),
      completed: boundedCount(milestone.completed, `${label}.completed`, errors),
      blocked: boundedCount(milestone.blocked, `${label}.blocked`, errors),
    });
  }));
}

function validateCounts(input, errors) {
  if (!isPlainObject(input)) {
    errors.push('counts must be an object');
    return Object.freeze({ ready: 0, inProgress: 0, blocked: 0, review: 0, completed: 0 });
  }
  assertNoUnknownFields(input, COUNT_FIELDS, 'counts', errors);
  const counts = {};
  for (const field of COUNT_FIELDS) {
    counts[field] = boundedCount(input[field], `counts.${field}`, errors);
  }
  return Object.freeze(counts);
}

function validateCriticalPath(input, errors) {
  if (!Array.isArray(input)) {
    errors.push('criticalPath must be an array');
    return freezeArray([]);
  }
  if (input.length > MAX_CRITICAL_PATH) errors.push(`criticalPath must contain at most ${MAX_CRITICAL_PATH} entries`);
  return freezeArray(input.slice(0, MAX_CRITICAL_PATH).map((entry, index) => {
    const label = `criticalPath[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${label} must be an object`);
      return Object.freeze({ curationKey: 'invalid', issueNumber: null, readiness: 'invalid' });
    }
    assertNoUnknownFields(entry, CRITICAL_PATH_FIELDS, label, errors);
    if (!nonEmptyString(entry.curationKey) || !CURATION_KEY_PATTERN.test(entry.curationKey)) {
      errors.push(`${label}.curationKey must be a bounded "qc:<projectId>:<proposedIssueId>" key`);
    }
    if (entry.issueNumber != null && (!Number.isInteger(entry.issueNumber) || entry.issueNumber <= 0)) {
      errors.push(`${label}.issueNumber must be a positive integer when present`);
    }
    return Object.freeze({
      curationKey: nonEmptyString(entry.curationKey) ? entry.curationKey : 'invalid',
      issueNumber: entry.issueNumber ?? null,
      readiness: requiredToken(entry.readiness, `${label}.readiness`, null, errors) ?? 'invalid',
    });
  }));
}

function validateCurrentEvent(input, errors) {
  if (input == null) return null;
  if (!isPlainObject(input)) {
    errors.push('currentEvent must be an object when present');
    return null;
  }
  assertNoUnknownFields(input, CURRENT_EVENT_FIELDS, 'currentEvent', errors);
  if (!nonEmptyString(input.eventId) || !ID_PATTERN.test(input.eventId)) errors.push('currentEvent.eventId must be a bounded identifier');
  return Object.freeze({
    eventId: nonEmptyString(input.eventId) ? input.eventId : 'invalid',
    eventType: requiredToken(input.eventType, 'currentEvent.eventType', null, errors) ?? 'invalid',
    state: requiredToken(input.state, 'currentEvent.state', null, errors) ?? 'invalid',
  });
}

function validateRecentDecisions(input, errors) {
  if (!Array.isArray(input)) {
    errors.push('recentDecisions must be an array');
    return freezeArray([]);
  }
  if (input.length > MAX_DECISIONS) errors.push(`recentDecisions must contain at most ${MAX_DECISIONS} entries`);
  return freezeArray(input.slice(0, MAX_DECISIONS).map((decision, index) => {
    const label = `recentDecisions[${index}]`;
    if (!isPlainObject(decision)) {
      errors.push(`${label} must be an object`);
      return Object.freeze({ eventId: 'invalid', role: 'invalid', outcome: 'invalid', recordedAt: null });
    }
    assertNoUnknownFields(decision, DECISION_FIELDS, label, errors);
    if (!nonEmptyString(decision.eventId) || !ID_PATTERN.test(decision.eventId)) errors.push(`${label}.eventId must be a bounded identifier`);
    if (decision.recordedAt != null && !TIMESTAMP_PATTERN.test(String(decision.recordedAt))) {
      errors.push(`${label}.recordedAt must be an ISO-8601 UTC timestamp when present`);
    }
    return Object.freeze({
      eventId: nonEmptyString(decision.eventId) ? decision.eventId : 'invalid',
      role: requiredToken(decision.role, `${label}.role`, null, errors) ?? 'invalid',
      outcome: requiredToken(decision.outcome, `${label}.outcome`, null, errors) ?? 'invalid',
      recordedAt: decision.recordedAt ?? null,
    });
  }));
}

function validateNextAction(input, errors) {
  if (!isPlainObject(input)) {
    errors.push('nextAction must be an object');
    return Object.freeze({ classification: 'none', eventType: null, notBefore: null });
  }
  assertNoUnknownFields(input, NEXT_ACTION_FIELDS, 'nextAction', errors);
  const classification = requiredToken(input.classification, 'nextAction.classification', PROJECTION_NEXT_ACTIONS, errors) ?? 'none';
  let eventType = null;
  if (input.eventType != null) {
    eventType = requiredToken(input.eventType, 'nextAction.eventType', NEXT_EVENT_TYPES, errors);
  }
  if (input.notBefore != null && !TIMESTAMP_PATTERN.test(String(input.notBefore))) {
    errors.push('nextAction.notBefore must be an ISO-8601 UTC timestamp when present');
  }
  return Object.freeze({ classification, eventType, notBefore: input.notBefore ?? null });
}

/**
 * Build one validated, deterministic status projection.
 *
 * Throws on anything that is not positively allowlisted, so a caller can never
 * accidentally widen what management publishes.
 */
export function buildManagementStatusProjection(input) {
  if (!isPlainObject(input)) throw new Error('Invalid agent runner management status projection: input must be an object');
  const errors = [];
  assertNoForbiddenFieldNamesRecursive(input, 'projection', errors);
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'projection', errors);
  if (errors.length) throw new Error(`Invalid agent runner management status projection: ${errors.join('; ')}`);

  if (!nonEmptyString(input.projectId) || !ID_PATTERN.test(input.projectId)) errors.push('projectId must be a bounded registered project identifier');
  if (!nonEmptyString(input.repository) || !REPOSITORY_PATTERN.test(input.repository)) errors.push('repository must be a bounded "owner/name" identity');
  assertBoundedSafeText(input.objective, 'objective', errors, { max: 300, allowWriteActionScan: false });
  if (!nonEmptyString(input.planRevision) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.planRevision)) {
    errors.push('planRevision must be a bounded machine-safe revision identifier');
  }

  const milestones = validateMilestones(input.milestones, errors);
  const counts = validateCounts(input.counts, errors);
  const criticalPath = validateCriticalPath(input.criticalPath, errors);
  const currentEvent = validateCurrentEvent(input.currentEvent, errors);
  const lifecycleState = requiredToken(input.lifecycleState, 'lifecycleState', PROJECTION_LIFECYCLE_STATES, errors) ?? 'idle';
  const recentDecisions = validateRecentDecisions(input.recentDecisions, errors);
  const risks = assertBoundedSafeTextArray(input.risks ?? [], 'risks', errors, { max: MAX_RISKS, itemMax: 200, allowWriteActionScan: false }) ?? freezeArray([]);
  const blockers = assertBoundedSafeTextArray(input.blockers ?? [], 'blockers', errors, { max: MAX_RISKS, itemMax: 200, allowWriteActionScan: false }) ?? freezeArray([]);
  const nextAction = validateNextAction(input.nextAction, errors);
  if (typeof input.ownerAttentionRequired !== 'boolean') errors.push('ownerAttentionRequired must be a boolean');
  const controlMode = requiredToken(input.controlMode, 'controlMode', ['disabled', 'shadow', 'active', 'fenced'], errors) ?? 'disabled';
  if (input.updatedAt != null && !TIMESTAMP_PATTERN.test(String(input.updatedAt))) {
    errors.push('updatedAt must be an ISO-8601 UTC timestamp when present');
  }
  if (errors.length) throw new Error(`Invalid agent runner management status projection: ${errors.join('; ')}`);

  // `updatedAt` is deliberately outside the fingerprint: a re-projection whose
  // semantics did not change must dedupe rather than churn the record.
  const semantic = Object.freeze({
    schemaVersion: MANAGEMENT_STATUS_PROJECTION_SCHEMA_VERSION,
    projectId: input.projectId,
    repository: input.repository,
    objective: input.objective.trim(),
    planRevision: input.planRevision,
    milestones,
    counts,
    criticalPath,
    currentEvent,
    lifecycleState,
    recentDecisions,
    risks,
    blockers,
    nextAction,
    ownerAttentionRequired: input.ownerAttentionRequired,
    controlMode,
  });
  const projectionFingerprint = contentFingerprint(semantic);
  const projection = Object.freeze({ ...semantic, projectionFingerprint, updatedAt: input.updatedAt ?? null });
  VALIDATED_PROJECTIONS.add(projection);
  return projection;
}

/** Refuse anything that merely *looks* like a validated projection. */
export function assertNormalizedStatusProjectionShape(projection) {
  if (!isPlainObject(projection) || !Object.isFrozen(projection) || !VALIDATED_PROJECTIONS.has(projection)) {
    throw new Error('requires an already-validated management status projection: object was not produced by buildManagementStatusProjection');
  }
}

/** The bounded fields a non-programme role may revise on an existing projection. */
const REVISABLE_FIELDS = new Set([
  'currentEvent', 'lifecycleState', 'recentDecisions', 'nextAction', 'ownerAttentionRequired', 'controlMode',
]);

/**
 * Revise an existing persisted projection without re-deriving programme facts.
 *
 * The execution and assurance roles know the current lifecycle state and the
 * next required event, but they deliberately do not compute the plan, the queue
 * counts or the critical path -- those are the programme role's output. Rather
 * than let those fields go stale or invent them, this rebuilds a complete,
 * fully-validated projection from the last persisted payload plus the bounded
 * lifecycle fields the calling role legitimately owns.
 *
 * The result is validated exactly like a fresh projection, so a revision can
 * never widen what management publishes, and it dedupes on the same fingerprint
 * rule: a revision that changes nothing semantically produces the same
 * fingerprint and leaves the stored record alone.
 */
export function reviseManagementStatusProjection({ previous, changes = {}, updatedAt = null } = {}) {
  if (!isPlainObject(previous)) throw new Error('projection revision requires the previous payload object');
  if (!isPlainObject(changes)) throw new Error('projection revision changes must be an object');
  const unknown = Object.keys(changes).filter((key) => !REVISABLE_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`projection revision may only change lifecycle fields; refused: ${unknown.sort().join(', ')}`);
  }
  // Drop the derived fields so the builder recomputes them from scratch.
  const { schemaVersion, projectionFingerprint, updatedAt: previousUpdatedAt, ...carried } = previous;
  return buildManagementStatusProjection({ ...carried, ...changes, updatedAt });
}

/**
 * The semantic half of a projection, which is exactly what the store persists
 * and fingerprints. `updatedAt` is excluded so an unchanged project dedupes.
 */
export function statusProjectionPayload(projection) {
  assertNormalizedStatusProjectionShape(projection);
  const { updatedAt, ...payload } = projection;
  return Object.freeze(payload);
}
