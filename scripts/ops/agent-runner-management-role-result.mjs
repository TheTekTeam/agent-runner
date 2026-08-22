#!/usr/bin/env node

/**
 * #268: the one bounded result shape every management role handler returns.
 *
 * A role handler never enqueues, never settles and never persists anything
 * itself. It returns this bounded value and the generic event controller does
 * the durable work. That split is what keeps the roles pure and deterministic,
 * and what lets a handler be replayed in a test without a database.
 *
 * The successor descriptors here carry **identity only**. There is deliberately
 * no field in which a handler could place an instruction for the next handler:
 * a successor says "reconciliation of this kind is required for this identity",
 * and the handler that later claims it re-reads authoritative evidence from
 * scratch. Stale, replayed and out-of-order events therefore degrade into
 * harmless no-op reconciliations rather than stale commands.
 */

import {
  assertNoUnknownFields,
  freezeArray,
  isPlainObject,
  nonEmptyString,
} from './agent-runner-manager-planner-safety.mjs';
import { assertNormalizedStatusProjectionShape } from './agent-runner-management-status-projection.mjs';

export const MANAGEMENT_ROLE_RESULT_SCHEMA_VERSION = 'agent-runner-management-role-result/v1';

/** The successor event types a role handler may request. */
export const SUCCESSOR_EVENT_TYPES = Object.freeze([
  'programme-reconcile-required',
  'execution-reconcile-required',
  'queue-assurance-required',
]);

/** The bounded settlement states a role result may resolve to. */
export const ROLE_SETTLEMENT_STATES = Object.freeze(['settled', 'blocked']);

const RESULT_FIELDS = new Set([
  'role', 'outcome', 'reason', 'settlementState', 'mutationSuppressed',
  'successors', 'projection', 'findings', 'identity',
]);
const SUCCESSOR_FIELDS = new Set(['eventType', 'issueNumber', 'pullRequestNumber', 'sha', 'notBefore', 'correlationId']);
const IDENTITY_FIELDS = new Set(['projectId', 'repository', 'issueNumber', 'pullRequestNumber', 'sha']);
const FINDING_FIELDS = new Set(['findingClass', 'severity', 'issueNumber', 'pullRequestNumber', 'sha']);

const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const MAX_SUCCESSORS = 4;
const MAX_FINDINGS = 20;

const SUCCESSOR_TYPE_SET = new Set(SUCCESSOR_EVENT_TYPES);

const VALIDATED_RESULTS = new WeakSet();

function requiredToken(value, label, errors) {
  if (!nonEmptyString(value) || !TOKEN_PATTERN.test(value)) {
    errors.push(`${label} must be a bounded machine-safe token`);
    return null;
  }
  return value;
}

function optionalPositiveInteger(value, label, errors) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
    errors.push(`${label} must be a bounded positive integer when present`);
    return null;
  }
  return value;
}

function optionalSha(value, label, errors) {
  if (value == null) return null;
  if (!nonEmptyString(value) || !SHA_PATTERN.test(value.toLowerCase())) {
    errors.push(`${label} must be an exact 40-character commit SHA when present`);
    return null;
  }
  return value.toLowerCase();
}

function validateIdentity(identity, errors) {
  if (!isPlainObject(identity)) {
    errors.push('identity must be an object');
    return null;
  }
  assertNoUnknownFields(identity, IDENTITY_FIELDS, 'identity', errors);
  if (!nonEmptyString(identity.projectId) || !ID_PATTERN.test(identity.projectId)) {
    errors.push('identity.projectId must be a bounded registered project identifier');
  }
  if (!nonEmptyString(identity.repository) || !REPOSITORY_PATTERN.test(identity.repository)) {
    errors.push('identity.repository must be a bounded "owner/name" identity');
  }
  return Object.freeze({
    projectId: identity.projectId,
    repository: identity.repository,
    issueNumber: optionalPositiveInteger(identity.issueNumber, 'identity.issueNumber', errors),
    pullRequestNumber: optionalPositiveInteger(identity.pullRequestNumber, 'identity.pullRequestNumber', errors),
    sha: optionalSha(identity.sha, 'identity.sha', errors),
  });
}

function validateSuccessors(successors, errors) {
  if (!Array.isArray(successors)) {
    errors.push('successors must be an array');
    return freezeArray([]);
  }
  if (successors.length > MAX_SUCCESSORS) {
    errors.push(`successors must contain at most ${MAX_SUCCESSORS} entries: a role transition may never fan out into an event storm`);
    return freezeArray([]);
  }
  const seen = new Set();
  return freezeArray(successors.map((successor, index) => {
    const label = `successors[${index}]`;
    if (!isPlainObject(successor)) {
      errors.push(`${label} must be an object`);
      return Object.freeze({ eventType: 'invalid' });
    }
    assertNoUnknownFields(successor, SUCCESSOR_FIELDS, label, errors);
    if (!nonEmptyString(successor.eventType) || !SUCCESSOR_TYPE_SET.has(successor.eventType)) {
      errors.push(`${label}.eventType must be one of: ${SUCCESSOR_EVENT_TYPES.join(', ')}`);
    }
    if (successor.notBefore != null && !TIMESTAMP_PATTERN.test(String(successor.notBefore))) {
      errors.push(`${label}.notBefore must be an ISO-8601 UTC timestamp when present`);
    }
    if (successor.correlationId != null && !ID_PATTERN.test(String(successor.correlationId))) {
      errors.push(`${label}.correlationId must be a bounded identifier when present`);
    }
    const normalized = Object.freeze({
      eventType: successor.eventType,
      issueNumber: optionalPositiveInteger(successor.issueNumber, `${label}.issueNumber`, errors),
      pullRequestNumber: optionalPositiveInteger(successor.pullRequestNumber, `${label}.pullRequestNumber`, errors),
      sha: optionalSha(successor.sha, `${label}.sha`, errors),
      notBefore: successor.notBefore ?? null,
      correlationId: successor.correlationId ?? null,
    });
    // Two identical successors would be coalesced by the ledger anyway; asking
    // for them is a handler defect worth surfacing rather than silently eating.
    const key = JSON.stringify(normalized);
    if (seen.has(key)) errors.push(`${label} duplicates an earlier successor`);
    seen.add(key);
    return normalized;
  }));
}

function validateFindings(findings, errors) {
  if (!Array.isArray(findings)) {
    errors.push('findings must be an array');
    return freezeArray([]);
  }
  if (findings.length > MAX_FINDINGS) errors.push(`findings must contain at most ${MAX_FINDINGS} entries`);
  return freezeArray(findings.slice(0, MAX_FINDINGS).map((finding, index) => {
    const label = `findings[${index}]`;
    if (!isPlainObject(finding)) {
      errors.push(`${label} must be an object`);
      return Object.freeze({ findingClass: 'invalid', severity: 'informational' });
    }
    assertNoUnknownFields(finding, FINDING_FIELDS, label, errors);
    return Object.freeze({
      findingClass: requiredToken(finding.findingClass, `${label}.findingClass`, errors) ?? 'invalid',
      severity: requiredToken(finding.severity, `${label}.severity`, errors) ?? 'informational',
      issueNumber: optionalPositiveInteger(finding.issueNumber, `${label}.issueNumber`, errors),
      pullRequestNumber: optionalPositiveInteger(finding.pullRequestNumber, `${label}.pullRequestNumber`, errors),
      sha: optionalSha(finding.sha, `${label}.sha`, errors),
    });
  }));
}

/**
 * Validate one bounded role result. Throws on anything outside the allowlist so
 * a handler defect surfaces at the boundary rather than as a malformed durable
 * event or a partially-written decision record.
 */
export function buildManagementRoleResult(input) {
  if (!isPlainObject(input)) throw new Error('Invalid agent runner management role result: input must be an object');
  const errors = [];
  assertNoUnknownFields(input, RESULT_FIELDS, 'result', errors);

  const role = requiredToken(input.role, 'result.role', errors);
  const outcome = requiredToken(input.outcome, 'result.outcome', errors);
  const reason = requiredToken(input.reason, 'result.reason', errors);
  const settlementState = input.settlementState ?? 'settled';
  if (!ROLE_SETTLEMENT_STATES.includes(settlementState)) {
    errors.push(`result.settlementState must be one of: ${ROLE_SETTLEMENT_STATES.join(', ')}`);
  }
  if (typeof input.mutationSuppressed !== 'boolean') errors.push('result.mutationSuppressed must be a boolean');
  const identity = validateIdentity(input.identity, errors);
  const successors = validateSuccessors(input.successors ?? [], errors);
  const findings = validateFindings(input.findings ?? [], errors);
  if (input.projection != null) assertNormalizedStatusProjectionShape(input.projection);
  if (errors.length) throw new Error(`Invalid agent runner management role result: ${errors.join('; ')}`);

  const result = Object.freeze({
    schemaVersion: MANAGEMENT_ROLE_RESULT_SCHEMA_VERSION,
    role,
    outcome,
    reason,
    settlementState,
    mutationSuppressed: input.mutationSuppressed,
    identity,
    successors,
    findings,
    projection: input.projection ?? null,
  });
  VALIDATED_RESULTS.add(result);
  return result;
}

/** Refuse anything that merely *looks* like a role result. */
export function assertManagementRoleResultShape(result) {
  if (!isPlainObject(result) || !Object.isFrozen(result) || !VALIDATED_RESULTS.has(result)) {
    throw new Error('requires a validated management role result: object was not produced by buildManagementRoleResult');
  }
  return result;
}
