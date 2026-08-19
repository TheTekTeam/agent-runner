#!/usr/bin/env node

/**
 * #261: pure, provider-neutral project-evidence snapshot. Constructible only
 * from an explicitly registered, already-validated manager profile (see
 * agent-runner-manager-profile-schema.mjs) -- see
 * docs/ops/AGENT-RUNNER-MANAGER-PLANNER.md. This module never performs a
 * GitHub call, a clone or a provider invocation itself: the caller is
 * responsible for having already collected the bounded facts this module
 * validates and normalizes.
 */

import { assertNormalizedManagerProfileShape } from './agent-runner-manager-profile-schema.mjs';
import {
  assertBoundedSafeText,
  assertBoundedSafeTextArray,
  assertNoUnknownFields,
  contentFingerprint,
  freezeArray,
  isPlainObject,
  nonEmptyString,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION = 'agent-runner-manager-project-evidence/v1';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const FRESHNESS_VALUES = new Set(['current', 'stale', 'unknown']);
const LABEL_VALUE_PATTERN = /^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/i;
const EVIDENCE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const MAX_INSTRUCTION_DOCUMENTS = 20;
const MAX_TOOL_ITEMS = 20;
const MAX_TOOL_ITEM_LENGTH = 60;
const MAX_ACCEPTANCE_COMMANDS = 10;
const MAX_ISSUES = 25;
const MAX_PULL_REQUESTS = 25;
const MAX_LABEL_ITEMS = 15;
const MAX_TITLE = 200;

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'projectId',
  'repository',
  'branch',
  'sourceSha',
  'evidenceRevision',
  'evidenceTimestamp',
  'instructionDocuments',
  'tooling',
  'acceptanceCommands',
  'openIssues',
  'openPullRequests',
]);

const VALIDATED_EVIDENCE = new WeakSet();

function validateRepositoryMatch(repository, profile, errors) {
  if (!isPlainObject(repository)) {
    errors.push('repository must be an object with owner and name');
    return null;
  }
  assertNoUnknownFields(repository, new Set(['owner', 'name']), 'repository', errors);
  const { owner, name } = repository;
  if (!nonEmptyString(owner) || !nonEmptyString(name)) {
    errors.push('repository.owner and repository.name are required');
    return null;
  }
  if (`${owner}/${name}`.toLowerCase() !== profile.repository.full.toLowerCase()) {
    errors.push(`repository must exactly match the registered profile repository '${profile.repository.full}'`);
    return null;
  }
  return Object.freeze({ owner, name, full: profile.repository.full });
}

function validateInstructionDocuments(documents, profile, errors) {
  if (!Array.isArray(documents) || documents.length === 0 || documents.length > MAX_INSTRUCTION_DOCUMENTS) {
    errors.push(`instructionDocuments must be an array with between 1 and ${MAX_INSTRUCTION_DOCUMENTS} entries`);
    return null;
  }
  const allowedPaths = new Set(profile.instructionPaths);
  const seenPaths = new Set();
  const normalized = [];
  documents.forEach((document, index) => {
    const label = `instructionDocuments[${index}]`;
    const before = errors.length;
    if (!isPlainObject(document)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(document, new Set(['path', 'sha256', 'freshness']), label, errors);
    const { path, sha256, freshness } = document;
    if (!nonEmptyString(path) || !allowedPaths.has(path)) errors.push(`${label}.path must be one of the profile's declared instructionPaths`);
    else if (seenPaths.has(path)) errors.push(`${label}.path duplicates an already-listed instruction document`);
    if (!nonEmptyString(sha256) || !SHA256_HEX_PATTERN.test(String(sha256).toLowerCase())) errors.push(`${label}.sha256 must be a 64-character hex digest`);
    if (!FRESHNESS_VALUES.has(freshness)) errors.push(`${label}.freshness must be one of ${[...FRESHNESS_VALUES].join(', ')}`);
    if (errors.length === before) {
      seenPaths.add(path);
      normalized.push(Object.freeze({ path, sha256: sha256.toLowerCase(), freshness }));
    }
  });
  if (errors.length) return null;
  return freezeArray(normalized);
}

function validateToolingList(list, label, errors) {
  return assertBoundedSafeTextArray(list ?? [], label, errors, {
    max: MAX_TOOL_ITEMS,
    itemMax: MAX_TOOL_ITEM_LENGTH,
    allowWriteActionScan: false,
  });
}

function validateTooling(tooling, errors) {
  if (!isPlainObject(tooling)) {
    errors.push('tooling must be an object');
    return null;
  }
  assertNoUnknownFields(tooling, new Set(['languages', 'packageManagers', 'buildTools', 'workflows']), 'tooling', errors);
  const languages = validateToolingList(tooling.languages, 'tooling.languages', errors);
  const packageManagers = validateToolingList(tooling.packageManagers, 'tooling.packageManagers', errors);
  const buildTools = validateToolingList(tooling.buildTools, 'tooling.buildTools', errors);
  const workflows = validateToolingList(tooling.workflows, 'tooling.workflows', errors);
  if (errors.length) return null;
  return Object.freeze({ languages, packageManagers, buildTools, workflows });
}

/**
 * Acceptance commands are never arbitrary caller-supplied strings: every
 * entry must exactly match one of the profile's own configured
 * `validation.requiredChecks`, so an evidence snapshot cannot smuggle in an
 * unbounded shell command under this field.
 */
function validateAcceptanceCommands(commands, profile, errors) {
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_ACCEPTANCE_COMMANDS) {
    errors.push(`acceptanceCommands must be a non-empty array of at most ${MAX_ACCEPTANCE_COMMANDS} entries`);
    return null;
  }
  const allowed = new Set(profile.validation.requiredChecks);
  const seen = new Set();
  const normalized = [];
  commands.forEach((command, index) => {
    if (!nonEmptyString(command) || !allowed.has(command)) {
      errors.push(`acceptanceCommands[${index}] must exactly match one of the profile's configured validation.requiredChecks`);
      return;
    }
    if (seen.has(command)) {
      errors.push(`acceptanceCommands[${index}] duplicates an already-listed command`);
      return;
    }
    seen.add(command);
    normalized.push(command);
  });
  if (errors.length) return null;
  return freezeArray(normalized);
}

function validateSummaryLabels(labels, label, errors) {
  if (labels === undefined) return freezeArray([]);
  if (!Array.isArray(labels) || labels.length > MAX_LABEL_ITEMS) {
    errors.push(`${label} must be an array of at most ${MAX_LABEL_ITEMS} strings`);
    return null;
  }
  const normalized = [];
  labels.forEach((value, index) => {
    if (!nonEmptyString(value) || !LABEL_VALUE_PATTERN.test(value)) {
      errors.push(`${label}[${index}] must be a safe label string`);
      return;
    }
    normalized.push(value);
  });
  if (errors.length) return null;
  return freezeArray(normalized);
}

function validateOpenIssues(issues, errors) {
  if (!Array.isArray(issues) || issues.length > MAX_ISSUES) {
    errors.push(`openIssues must be an array of at most ${MAX_ISSUES} entries`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  issues.forEach((issue, index) => {
    const label = `openIssues[${index}]`;
    const before = errors.length;
    if (!isPlainObject(issue)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(issue, new Set(['number', 'title', 'labels']), label, errors);
    const { number, title, labels } = issue;
    if (!Number.isInteger(number) || number <= 0) errors.push(`${label}.number must be a positive integer`);
    else if (seen.has(number)) errors.push(`${label}.number duplicates an already-listed issue`);
    assertBoundedSafeText(title, `${label}.title`, errors, { max: MAX_TITLE, allowWriteActionScan: false });
    const normalizedLabels = validateSummaryLabels(labels, `${label}.labels`, errors);
    if (errors.length === before) {
      seen.add(number);
      normalized.push(Object.freeze({ number, title: title.trim(), labels: normalizedLabels }));
    }
  });
  if (errors.length) return null;
  return freezeArray(normalized);
}

function validateOpenPullRequests(pulls, errors) {
  if (!Array.isArray(pulls) || pulls.length > MAX_PULL_REQUESTS) {
    errors.push(`openPullRequests must be an array of at most ${MAX_PULL_REQUESTS} entries`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  pulls.forEach((pull, index) => {
    const label = `openPullRequests[${index}]`;
    const before = errors.length;
    if (!isPlainObject(pull)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(pull, new Set(['number', 'title', 'headSha', 'labels']), label, errors);
    const { number, title, headSha, labels } = pull;
    if (!Number.isInteger(number) || number <= 0) errors.push(`${label}.number must be a positive integer`);
    else if (seen.has(number)) errors.push(`${label}.number duplicates an already-listed pull request`);
    assertBoundedSafeText(title, `${label}.title`, errors, { max: MAX_TITLE, allowWriteActionScan: false });
    if (headSha !== undefined && !SHA_PATTERN.test(String(headSha).toLowerCase())) errors.push(`${label}.headSha must be a 40-character hex commit SHA`);
    const normalizedLabels = validateSummaryLabels(labels, `${label}.labels`, errors);
    if (errors.length === before) {
      seen.add(number);
      normalized.push(Object.freeze({
        number,
        title: title.trim(),
        headSha: headSha ? headSha.toLowerCase() : null,
        labels: normalizedLabels,
      }));
    }
  });
  if (errors.length) return null;
  return freezeArray(normalized);
}

/**
 * Validate a raw evidence object against an already-validated manager
 * profile. Fails closed (throws) on unknown fields, missing fields,
 * ambiguous repository/branch/profile provenance, and any evidence for a
 * disabled profile -- a disabled project is never live-evidenced, matching
 * its zero mutation authority. Never mutates GitHub, the filesystem or any
 * other external system.
 */
export function validateManagerProjectEvidence(input, { profile } = {}) {
  assertNormalizedManagerProfileShape(profile);
  const errors = [];
  if (!profile.enabled) errors.push('evidence cannot be constructed for a disabled manager profile');
  if (!isPlainObject(input)) throw new Error('Invalid agent runner manager project evidence: evidence must be a JSON object');
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'evidence', errors);
  for (const field of TOP_LEVEL_FIELDS) {
    if (!(field in input)) errors.push(`evidence.${field} is required`);
  }
  if (errors.length) throw new Error(`Invalid agent runner manager project evidence: ${errors.join('; ')}`);

  if (input.schemaVersion !== MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION) errors.push(`schemaVersion must equal "${MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION}"`);
  if (input.projectId !== profile.projectId) errors.push(`projectId must exactly match the registered profile projectId '${profile.projectId}'`);

  const repository = validateRepositoryMatch(input.repository, profile, errors);
  if (!nonEmptyString(input.branch) || !profile.branches.allowed.includes(input.branch)) {
    errors.push("branch must be one of the profile's declared branches.allowed");
  }
  if (!nonEmptyString(input.sourceSha) || !SHA_PATTERN.test(String(input.sourceSha).toLowerCase())) {
    errors.push('sourceSha must be a 40-character hex commit SHA');
  }
  if (!nonEmptyString(input.evidenceRevision) || input.evidenceRevision.length > 200) {
    errors.push('evidenceRevision is required and must be at most 200 characters');
  }
  if (!nonEmptyString(input.evidenceTimestamp) || !EVIDENCE_TIMESTAMP_PATTERN.test(input.evidenceTimestamp)) {
    errors.push('evidenceTimestamp must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)');
  }

  const instructionDocuments = validateInstructionDocuments(input.instructionDocuments, profile, errors);
  const tooling = validateTooling(input.tooling, errors);
  const acceptanceCommands = validateAcceptanceCommands(input.acceptanceCommands, profile, errors);
  const openIssues = validateOpenIssues(input.openIssues, errors);
  const openPullRequests = validateOpenPullRequests(input.openPullRequests, errors);

  if (errors.length) throw new Error(`Invalid agent runner manager project evidence: ${errors.join('; ')}`);

  const fingerprintPayload = Object.freeze({
    schemaVersion: input.schemaVersion,
    projectId: input.projectId,
    repository,
    branch: input.branch,
    sourceSha: input.sourceSha.toLowerCase(),
    evidenceRevision: input.evidenceRevision,
    evidenceTimestamp: input.evidenceTimestamp,
    instructionDocuments,
    tooling,
    acceptanceCommands,
    openIssues,
    openPullRequests,
  });
  const evidenceFingerprint = contentFingerprint(fingerprintPayload);
  const normalized = Object.freeze({ ...fingerprintPayload, evidenceFingerprint, profile });
  VALIDATED_EVIDENCE.add(normalized);
  return normalized;
}

/**
 * Refuse anything that merely *looks* like validated evidence (same
 * strategy as `assertNormalizedManagerProfileShape`): provenance is
 * checked against a `WeakSet` populated only by
 * `validateManagerProjectEvidence()` itself, so it cannot be forged by
 * constructing a look-alike frozen object.
 */
export function assertNormalizedManagerProjectEvidenceShape(evidence) {
  if (!isPlainObject(evidence) || !Object.isFrozen(evidence) || !VALIDATED_EVIDENCE.has(evidence)) {
    throw new Error('requires an already-validated manager project evidence snapshot: object was not produced by validateManagerProjectEvidence');
  }
}
