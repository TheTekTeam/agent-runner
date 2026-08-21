#!/usr/bin/env node

/**
 * #267 Part C: the positive-allowlisted evidence contract the lifecycle
 * settlement consumes -- see docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-REVIEW.md.
 *
 * Only the bounded facts needed to decide lifecycle state are accepted:
 * worker-publication identity, pull-request metadata and a diff summary,
 * exact-head check results and bounded review findings. Everything else is
 * refused rather than redacted: no prompt, no provider output, no credential,
 * no environment dump, no local path, no command line, no raw log, no
 * unrestricted comment body and no monetary field can enter manager-visible
 * settlement state through this contract.
 *
 * Every identity in the evidence is bound to exactly one already-issued worker
 * authority. This module performs no GitHub call, no filesystem access, no
 * network access, no provider invocation and no mutation, reads no clock and
 * owns no scheduling.
 */

import { assertNormalizedWorkerAuthorityShape } from './agent-runner-manager-worker-authority.mjs';
import {
  assertBoundedSafeText,
  assertNoUnknownFields,
  contentFingerprint,
  freezeArray,
  isPlainObject,
  nonEmptyString,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGER_SETTLEMENT_EVIDENCE_SCHEMA_VERSION = 'agent-runner-manager-settlement-evidence/v1';

/** Bounded worker completion states. Prose is never one of them. */
export const PUBLICATION_COMPLETION_STATES = Object.freeze(['published', 'incomplete', 'failed', 'abandoned']);

/** Bounded pull-request states. */
export const PULL_REQUEST_STATES = Object.freeze(['open', 'closed', 'merged']);

/** Bounded check states. `neutral` and `cancelled` are ambiguous, never green. */
export const CHECK_STATES = Object.freeze(['success', 'failure', 'pending', 'cancelled', 'neutral', 'skipped']);

/** Bounded review outcomes. */
export const REVIEW_STATES = Object.freeze(['no-blockers', 'changes-requested', 'pending']);

/** Bounded review-finding severities. */
export const FINDING_SEVERITIES = Object.freeze(['blocking', 'advisory']);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TOKEN_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
// Deliberately the same bound the continuation ownership contract applies to an
// owning attempt identity, so a valid attempt id can always be reconciled
// against the workspace that owns it.
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CHECK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,119}$/;
const FINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// Repository-relative only: never absolute, never parent-relative, never a
// local-machine or worktree path.
const REPO_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const URL_PATTERN = /\b(?:[a-z][a-z0-9+.-]*):\/\//i;

const MAX_CHANGED_PATHS = 100;
const MAX_CHECKS = 40;
const MAX_FINDINGS = 40;
const MAX_SUMMARY = 300;
const MAX_VALIDATION_CHECKS = 20;

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'authorityKey',
  'authorityFingerprint',
  'attemptId',
  'projectId',
  'repository',
  'issueNumber',
  'branch',
  'baseSha',
  'evidenceRevision',
  'evidenceSequence',
  'evidenceTimestamp',
  'publication',
  'pullRequest',
  'ci',
  'review',
]);
const PUBLICATION_FIELDS = new Set([
  'attemptId', 'headSha', 'completionState', 'pullRequestNumber',
  'changedFileCount', 'changedPaths', 'insertions', 'deletions',
  'validationChecks', 'summary',
]);
const PULL_REQUEST_FIELDS = new Set([
  'number', 'branch', 'baseSha', 'headSha', 'state', 'draft',
  'mergeableState', 'changedFileCount', 'changedPaths', 'reviewDecision',
]);
const CI_FIELDS = new Set(['headSha', 'checks']);
const CHECK_FIELDS = new Set(['name', 'state', 'required', 'failureClass']);
const REVIEW_FIELDS = new Set(['pullRequestNumber', 'headSha', 'state', 'findings']);
const FINDING_FIELDS = new Set(['id', 'severity', 'category', 'summary', 'actionable']);
const VALIDATION_CHECK_FIELDS = new Set(['name', 'state']);

/**
 * Refused at any nesting depth: settlement evidence can never carry an
 * account-credit, balance or dollar-cap field, so no historical monetary field
 * can become a lifecycle input.
 */
const FORBIDDEN_FIELD_NAME_PATTERN = /^(?:account[-_]?credit|credit[-_]?balance|account[-_]?balance|balance|credits?|max[-_]?budget(?:[-_]?usd)?|budget[-_]?usd|budget|usd[-_]?cap|cost[-_]?cap|spend[-_]?cap|prompt|prompts|provider[-_]?response|provider[-_]?output|raw[-_]?output|transcript|stdout|stderr|logs?|env|environment|token|credential|secret|command|commands|command[-_]?line|worktree[-_]?path|local[-_]?path)$/i;

const VALIDATED_EVIDENCE = new WeakSet();

function assertNoForbiddenFieldNamesRecursive(value, path, errors, depth = 0) {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFieldNamesRecursive(item, `${path}[${index}]`, errors, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAME_PATTERN.test(key)) {
      errors.push(`${path}.${key} is not admissible settlement evidence: prompts, provider output, logs, environment, credentials, command lines, local paths and monetary fields are never manager-visible state`);
    }
    assertNoForbiddenFieldNamesRecursive(nested, `${path}.${key}`, errors, depth + 1);
  }
}

/**
 * A bounded authored summary. Everything `assertBoundedSafeText` refuses
 * (control characters, local paths, secret-shaped tokens, shell payloads, raw
 * prompt/log content) plus any URL: settlement state never carries an
 * arbitrary link for something else to fetch.
 */
function boundedSummary(value, label, errors, max = MAX_SUMMARY) {
  assertBoundedSafeText(value, label, errors, { max, allowWriteActionScan: false });
  if (nonEmptyString(value) && URL_PATTERN.test(value)) {
    errors.push(`${label} must not contain a URL`);
  }
}

function boundedCount(value, label, errors, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    errors.push(`${label} must be an integer between 0 and ${max}`);
    return null;
  }
  return value;
}

function validateChangedPaths(paths, label, errors) {
  if (paths === undefined) return freezeArray([]);
  if (!Array.isArray(paths) || paths.length > MAX_CHANGED_PATHS) {
    errors.push(`${label} must be an array of at most ${MAX_CHANGED_PATHS} repository-relative paths`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  paths.forEach((value, index) => {
    if (!nonEmptyString(value) || !REPO_PATH_PATTERN.test(value)) {
      errors.push(`${label}[${index}] must be a bounded repository-relative path`);
      return;
    }
    if (seen.has(value)) {
      errors.push(`${label}[${index}] duplicates an already-listed path`);
      return;
    }
    seen.add(value);
    normalized.push(value);
  });
  if (errors.length) return null;
  // Sorted so an incidental listing order can never change the normalized
  // evidence or its fingerprint.
  return freezeArray([...normalized].sort());
}

function validateValidationChecks(checks, label, errors) {
  if (checks === undefined) return freezeArray([]);
  if (!Array.isArray(checks) || checks.length > MAX_VALIDATION_CHECKS) {
    errors.push(`${label} must be an array of at most ${MAX_VALIDATION_CHECKS} validation results`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  checks.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    const before = errors.length;
    if (!isPlainObject(entry)) {
      errors.push(`${entryLabel} must be an object`);
      return;
    }
    assertNoUnknownFields(entry, VALIDATION_CHECK_FIELDS, entryLabel, errors);
    const { name, state } = entry;
    if (!nonEmptyString(name) || !CHECK_NAME_PATTERN.test(name)) errors.push(`${entryLabel}.name must be a bounded check name`);
    if (!CHECK_STATES.includes(state)) errors.push(`${entryLabel}.state must be one of ${CHECK_STATES.join(', ')}`);
    if (seen.has(name)) errors.push(`${entryLabel}.name duplicates an already-listed validation check`);
    if (errors.length === before) {
      seen.add(name);
      normalized.push(Object.freeze({ name, state }));
    }
  });
  if (errors.length) return null;
  return freezeArray([...normalized].sort((left, right) => left.name.localeCompare(right.name)));
}

function validatePublication(publication, errors) {
  if (publication === undefined || publication === null) return null;
  if (!isPlainObject(publication)) {
    errors.push('publication must be an object when present');
    return null;
  }
  assertNoUnknownFields(publication, PUBLICATION_FIELDS, 'publication', errors);
  const {
    attemptId, headSha, completionState, pullRequestNumber,
    changedFileCount, changedPaths, insertions, deletions, validationChecks, summary,
  } = publication;
  if (!nonEmptyString(attemptId) || !ATTEMPT_ID_PATTERN.test(attemptId)) errors.push('publication.attemptId must be a bounded machine-safe attempt identifier');
  if (!nonEmptyString(headSha) || !SHA_PATTERN.test(headSha)) errors.push('publication.headSha must be an exact 40-character lowercase commit SHA');
  if (!PUBLICATION_COMPLETION_STATES.includes(completionState)) {
    errors.push(`publication.completionState must be one of ${PUBLICATION_COMPLETION_STATES.join(', ')}`);
  }
  if (pullRequestNumber !== undefined && pullRequestNumber !== null && (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0)) {
    errors.push('publication.pullRequestNumber must be a positive integer when present');
  }
  const normalizedChangedPaths = validateChangedPaths(changedPaths, 'publication.changedPaths', errors);
  const normalizedCount = boundedCount(changedFileCount, 'publication.changedFileCount', errors, 10_000);
  const normalizedInsertions = boundedCount(insertions, 'publication.insertions', errors, 1_000_000);
  const normalizedDeletions = boundedCount(deletions, 'publication.deletions', errors, 1_000_000);
  const normalizedValidation = validateValidationChecks(validationChecks, 'publication.validationChecks', errors);
  boundedSummary(summary, 'publication.summary', errors);
  if (errors.length) return null;
  if (normalizedChangedPaths.length > 0 && normalizedChangedPaths.length > normalizedCount) {
    errors.push('publication.changedPaths must not list more paths than publication.changedFileCount reports');
    return null;
  }
  return Object.freeze({
    attemptId,
    headSha,
    completionState,
    pullRequestNumber: pullRequestNumber ?? null,
    changedFileCount: normalizedCount,
    changedPaths: normalizedChangedPaths,
    insertions: normalizedInsertions,
    deletions: normalizedDeletions,
    validationChecks: normalizedValidation,
    summary: summary.trim(),
  });
}

function validatePullRequest(pullRequest, errors) {
  if (pullRequest === undefined || pullRequest === null) return null;
  if (!isPlainObject(pullRequest)) {
    errors.push('pullRequest must be an object when present');
    return null;
  }
  assertNoUnknownFields(pullRequest, PULL_REQUEST_FIELDS, 'pullRequest', errors);
  const {
    number, branch, baseSha, headSha, state, draft, mergeableState,
    changedFileCount, changedPaths, reviewDecision,
  } = pullRequest;
  if (!Number.isInteger(number) || number <= 0) errors.push('pullRequest.number must be a positive integer');
  if (!nonEmptyString(branch)) errors.push('pullRequest.branch is required');
  if (!nonEmptyString(baseSha) || !SHA_PATTERN.test(baseSha)) errors.push('pullRequest.baseSha must be an exact 40-character lowercase commit SHA');
  if (!nonEmptyString(headSha) || !SHA_PATTERN.test(headSha)) errors.push('pullRequest.headSha must be an exact 40-character lowercase commit SHA');
  if (!PULL_REQUEST_STATES.includes(state)) errors.push(`pullRequest.state must be one of ${PULL_REQUEST_STATES.join(', ')}`);
  if (typeof draft !== 'boolean') errors.push('pullRequest.draft is required and must be a boolean');
  if (mergeableState !== undefined && mergeableState !== null && (!nonEmptyString(mergeableState) || !TOKEN_PATTERN.test(mergeableState))) {
    errors.push('pullRequest.mergeableState must be a bounded machine-safe token when present');
  }
  if (reviewDecision !== undefined && reviewDecision !== null && !REVIEW_STATES.includes(reviewDecision)) {
    errors.push(`pullRequest.reviewDecision must be one of ${REVIEW_STATES.join(', ')} when present`);
  }
  const normalizedChangedPaths = validateChangedPaths(changedPaths, 'pullRequest.changedPaths', errors);
  const normalizedCount = boundedCount(changedFileCount, 'pullRequest.changedFileCount', errors, 10_000);
  if (errors.length) return null;
  return Object.freeze({
    number,
    branch,
    baseSha,
    headSha,
    state,
    draft,
    mergeableState: mergeableState ?? null,
    changedFileCount: normalizedCount,
    changedPaths: normalizedChangedPaths,
    reviewDecision: reviewDecision ?? null,
  });
}

function validateCi(ci, errors) {
  if (ci === undefined || ci === null) return null;
  if (!isPlainObject(ci)) {
    errors.push('ci must be an object when present');
    return null;
  }
  assertNoUnknownFields(ci, CI_FIELDS, 'ci', errors);
  const { headSha, checks } = ci;
  if (!nonEmptyString(headSha) || !SHA_PATTERN.test(headSha)) errors.push('ci.headSha must be an exact 40-character lowercase commit SHA');
  if (!Array.isArray(checks) || checks.length > MAX_CHECKS) {
    errors.push(`ci.checks must be an array of at most ${MAX_CHECKS} check results`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  checks.forEach((check, index) => {
    const label = `ci.checks[${index}]`;
    const before = errors.length;
    if (!isPlainObject(check)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(check, CHECK_FIELDS, label, errors);
    const { name, state, required, failureClass } = check;
    if (!nonEmptyString(name) || !CHECK_NAME_PATTERN.test(name)) errors.push(`${label}.name must be a bounded workflow or check name`);
    if (!CHECK_STATES.includes(state)) errors.push(`${label}.state must be one of ${CHECK_STATES.join(', ')}`);
    if (typeof required !== 'boolean') errors.push(`${label}.required is required and must be a boolean`);
    if (failureClass !== undefined && failureClass !== null && (!nonEmptyString(failureClass) || !TOKEN_PATTERN.test(failureClass))) {
      errors.push(`${label}.failureClass must be a bounded machine-safe classification token when present`);
    }
    if (seen.has(name)) errors.push(`${label}.name duplicates an already-listed check`);
    if (errors.length === before) {
      seen.add(name);
      normalized.push(Object.freeze({ name, state, required, failureClass: failureClass ?? null }));
    }
  });
  if (errors.length) return null;
  return Object.freeze({
    headSha,
    checks: freezeArray([...normalized].sort((left, right) => left.name.localeCompare(right.name))),
  });
}

function validateReview(review, errors) {
  if (review === undefined || review === null) return null;
  if (!isPlainObject(review)) {
    errors.push('review must be an object when present');
    return null;
  }
  assertNoUnknownFields(review, REVIEW_FIELDS, 'review', errors);
  const { pullRequestNumber, headSha, state, findings } = review;
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) errors.push('review.pullRequestNumber must be a positive integer');
  if (!nonEmptyString(headSha) || !SHA_PATTERN.test(headSha)) errors.push('review.headSha must be an exact 40-character lowercase commit SHA');
  if (!REVIEW_STATES.includes(state)) errors.push(`review.state must be one of ${REVIEW_STATES.join(', ')}`);
  const rawFindings = findings === undefined ? [] : findings;
  if (!Array.isArray(rawFindings) || rawFindings.length > MAX_FINDINGS) {
    errors.push(`review.findings must be an array of at most ${MAX_FINDINGS} bounded findings`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  rawFindings.forEach((finding, index) => {
    const label = `review.findings[${index}]`;
    const before = errors.length;
    if (!isPlainObject(finding)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(finding, FINDING_FIELDS, label, errors);
    const { id, severity, category, summary, actionable } = finding;
    if (!nonEmptyString(id) || !FINDING_ID_PATTERN.test(id)) errors.push(`${label}.id must be a bounded machine-safe finding identifier`);
    if (!FINDING_SEVERITIES.includes(severity)) errors.push(`${label}.severity must be one of ${FINDING_SEVERITIES.join(', ')}`);
    if (!nonEmptyString(category) || !TOKEN_PATTERN.test(category)) errors.push(`${label}.category must be a bounded machine-safe category token`);
    if (typeof actionable !== 'boolean') errors.push(`${label}.actionable is required and must be a boolean`);
    boundedSummary(summary, `${label}.summary`, errors);
    if (seen.has(id)) errors.push(`${label}.id duplicates an already-listed finding`);
    if (errors.length === before) {
      seen.add(id);
      normalized.push(Object.freeze({ id, severity, category, summary: summary.trim(), actionable }));
    }
  });
  if (errors.length) return null;
  const normalizedFindings = freezeArray([...normalized].sort((left, right) => left.id.localeCompare(right.id)));
  if (state === 'changes-requested' && !normalizedFindings.some((finding) => finding.severity === 'blocking')) {
    errors.push("review.state 'changes-requested' requires at least one blocking finding: a review outcome is never inferred from prose");
    return null;
  }
  if (state === 'no-blockers' && normalizedFindings.some((finding) => finding.severity === 'blocking')) {
    errors.push("review.state 'no-blockers' contradicts a blocking finding");
    return null;
  }
  return Object.freeze({ pullRequestNumber, headSha, state, findings: normalizedFindings });
}

/**
 * Every cross-part identity rule. Exact-head binding lives here so a stale
 * publication, a check run against another commit or a review of an earlier
 * head can never reach settlement at all.
 */
function assertBoundIdentity(normalized, authority, errors) {
  const { publication, pullRequest, ci, review } = normalized;
  if (pullRequest && !publication) {
    errors.push('pullRequest evidence requires the worker publication it belongs to');
  }
  if ((ci || review) && !pullRequest) {
    errors.push('check and review evidence require the authorised pull request they were produced against');
  }
  if (publication && publication.attemptId !== normalized.attemptId) {
    errors.push(`publication.attemptId '${publication.attemptId}' is not the authorised attempt '${normalized.attemptId}'`);
  }
  if (publication && publication.headSha === normalized.baseSha && publication.completionState === 'published') {
    errors.push('publication.headSha equals the authorised base commit: a published attempt must advance the branch');
  }
  if (pullRequest) {
    if (pullRequest.branch !== authority.branch) {
      errors.push(`pullRequest.branch '${pullRequest.branch}' is not the authorised branch '${authority.branch}'`);
    }
    if (pullRequest.baseSha !== authority.baseSha) {
      errors.push(`pullRequest.baseSha '${pullRequest.baseSha}' is not the authorised base '${authority.baseSha}'`);
    }
    if (publication && publication.pullRequestNumber !== null && publication.pullRequestNumber !== pullRequest.number) {
      errors.push(`publication.pullRequestNumber ${publication.pullRequestNumber} is not the pull request the evidence describes (#${pullRequest.number})`);
    }
    if (publication && publication.headSha !== pullRequest.headSha) {
      errors.push(`publication.headSha '${publication.headSha}' is stale: the authorised pull request now points at '${pullRequest.headSha}'`);
    }
  }
  if (ci && pullRequest && ci.headSha !== pullRequest.headSha) {
    errors.push(`ci.headSha '${ci.headSha}' is not the exact current pull-request head '${pullRequest.headSha}': check evidence for another commit is never admissible`);
  }
  if (review && pullRequest) {
    if (review.pullRequestNumber !== pullRequest.number) {
      errors.push(`review.pullRequestNumber ${review.pullRequestNumber} is not the authorised pull request #${pullRequest.number}`);
    }
    if (review.headSha !== pullRequest.headSha) {
      errors.push(`review.headSha '${review.headSha}' is not the exact current pull-request head '${pullRequest.headSha}': a review of an earlier head is never admissible`);
    }
  }
}

/**
 * Validate and normalize one bounded settlement-evidence snapshot against the
 * exactly one worker authority it belongs to. Fails closed (throws) on unknown
 * fields, oversized or unsafe text, malformed identity, cross-project or
 * cross-repository identity, mismatched attempt/branch/base binding and any
 * evidence produced against a commit other than the exact current head.
 */
export function validateManagerSettlementEvidence(input, { authority } = {}) {
  assertNormalizedWorkerAuthorityShape(authority);
  const errors = [];
  if (!isPlainObject(input)) {
    throw new Error('Invalid agent runner manager settlement evidence: evidence must be an object');
  }
  assertNoForbiddenFieldNamesRecursive(input, 'evidence', errors);
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'evidence', errors);
  if (errors.length) throw new Error(`Invalid agent runner manager settlement evidence: ${errors.join('; ')}`);

  const {
    schemaVersion, authorityKey, authorityFingerprint, attemptId, projectId,
    repository, issueNumber, branch, baseSha, evidenceRevision, evidenceSequence,
    evidenceTimestamp,
  } = input;

  if (schemaVersion !== MANAGER_SETTLEMENT_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must equal "${MANAGER_SETTLEMENT_EVIDENCE_SCHEMA_VERSION}"`);
  }
  if (authorityKey !== authority.authorityKey) errors.push('authorityKey must exactly match the issued worker authority');
  if (authorityFingerprint !== authority.authorityFingerprint) errors.push('authorityFingerprint must exactly match the issued worker authority');
  if (projectId !== authority.projectId) errors.push(`projectId '${projectId}' is not the authorised registered project '${authority.projectId}'`);
  if (!isPlainObject(repository)) {
    errors.push('repository must be an object with owner and name');
  } else {
    assertNoUnknownFields(repository, new Set(['owner', 'name']), 'repository', errors);
    if (!nonEmptyString(repository.owner) || !nonEmptyString(repository.name)) {
      errors.push('repository.owner and repository.name are required');
    } else if (`${repository.owner}/${repository.name}`.toLowerCase() !== authority.repository.full.toLowerCase()) {
      errors.push(`repository must exactly match the authorised repository '${authority.repository.full}'`);
    }
  }
  if (issueNumber !== authority.issueNumber) errors.push(`issueNumber ${issueNumber} is not the authorised issue #${authority.issueNumber}`);
  if (branch !== authority.branch) errors.push(`branch '${branch}' is not the authorised branch '${authority.branch}'`);
  if (baseSha !== authority.baseSha) errors.push(`baseSha '${baseSha}' is not the authorised base commit '${authority.baseSha}'`);
  if (!nonEmptyString(attemptId) || !ATTEMPT_ID_PATTERN.test(attemptId)) errors.push('attemptId must be a bounded machine-safe attempt identifier');
  if (!nonEmptyString(evidenceRevision) || !REVISION_PATTERN.test(evidenceRevision)) errors.push('evidenceRevision must be a bounded machine-safe revision identifier');
  // A monotonic sequence supplied by the collector, not a clock reading: it is
  // the only ordering signal, so out-of-order replay is detectable without
  // this module ever reading time.
  if (!Number.isInteger(evidenceSequence) || evidenceSequence < 0) errors.push('evidenceSequence must be a non-negative integer');
  if (!nonEmptyString(evidenceTimestamp) || !TIMESTAMP_PATTERN.test(evidenceTimestamp)) {
    errors.push('evidenceTimestamp must be an ISO-8601 UTC timestamp');
  }
  if (errors.length) throw new Error(`Invalid agent runner manager settlement evidence: ${errors.join('; ')}`);

  const publication = validatePublication(input.publication, errors);
  const pullRequest = validatePullRequest(input.pullRequest, errors);
  const ci = validateCi(input.ci, errors);
  const review = validateReview(input.review, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager settlement evidence: ${errors.join('; ')}`);

  const bound = { attemptId, baseSha, publication, pullRequest, ci, review };
  assertBoundIdentity(bound, authority, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager settlement evidence: ${errors.join('; ')}`);

  const payload = Object.freeze({
    schemaVersion: MANAGER_SETTLEMENT_EVIDENCE_SCHEMA_VERSION,
    authorityKey: authority.authorityKey,
    authorityFingerprint: authority.authorityFingerprint,
    attemptId,
    projectId: authority.projectId,
    repository: authority.repository,
    issueNumber: authority.issueNumber,
    branch: authority.branch,
    baseSha: authority.baseSha,
    evidenceRevision,
    evidenceSequence,
    evidenceTimestamp,
    publication,
    pullRequest,
    ci,
    review,
  });
  const normalized = Object.freeze({ ...payload, evidenceFingerprint: contentFingerprint(payload) });
  VALIDATED_EVIDENCE.add(normalized);
  return normalized;
}

/**
 * Refuse anything that merely *looks* like validated settlement evidence:
 * provenance is checked against a `WeakSet` populated only by
 * `validateManagerSettlementEvidence()` itself.
 */
export function assertNormalizedSettlementEvidenceShape(evidence) {
  if (!isPlainObject(evidence) || !Object.isFrozen(evidence) || !VALIDATED_EVIDENCE.has(evidence)) {
    throw new Error('requires already-validated settlement evidence: object was not produced by validateManagerSettlementEvidence');
  }
}
