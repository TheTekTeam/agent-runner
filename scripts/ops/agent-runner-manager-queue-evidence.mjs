#!/usr/bin/env node

/**
 * #266: pure, provider-neutral current-queue evidence snapshot for one
 * explicitly registered project. Constructible only alongside an
 * already-validated plan proposal (see agent-runner-manager-plan-proposal.mjs),
 * whose grounding fixes the exact repository, branch and source revision this
 * queue evidence must describe -- see
 * docs/ops/AGENT-RUNNER-MANAGER-QUEUE-CURATOR.md.
 *
 * This module never performs a GitHub call, a clone, a provider invocation or
 * any mutation: the caller is responsible for having already collected the
 * bounded facts validated here.
 */

import { assertNormalizedManagerPlanProposalShape } from './agent-runner-manager-plan-proposal.mjs';
import {
  assertBoundedSafeText,
  assertNoUnknownFields,
  contentFingerprint,
  freezeArray,
  isPlainObject,
  nonEmptyString,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGER_QUEUE_EVIDENCE_SCHEMA_VERSION = 'agent-runner-manager-queue-evidence/v1';

/** Ownership kinds a queue record may currently be held by. */
export const QUEUE_LEASE_KINDS = Object.freeze(['implementation', 'recovery']);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const LABEL_VALUE_PATTERN = /^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/i;
const EVIDENCE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EVIDENCE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CURATION_KEY_PATTERN = /^qc:[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const QUALIFIED_DEPENDENCY_PATTERN = /^([^\s/#]+\/[^\s/#]+)#([1-9][0-9]*)$/;

const MAX_CURATION_KEY_LENGTH = 140;
const MAX_ISSUES = 200;
const MAX_LABELS_PER_ISSUE = 20;
const MAX_DEPENDENCIES_PER_ISSUE = 20;
const MAX_LEASES = 20;
const MAX_PULL_REQUESTS = 50;
const MAX_TITLE = 200;
const MAX_SUPERSESSION_DEPTH = 16;

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'projectId',
  'repository',
  'branch',
  'sourceSha',
  'evidenceRevision',
  'evidenceTimestamp',
  'issues',
  'ownership',
]);

const ISSUE_FIELDS = new Set(['number', 'title', 'state', 'labels', 'curationKey', 'dependsOn', 'supersededBy']);
const OWNERSHIP_FIELDS = new Set(['activeLeases', 'openPullRequests']);
const LEASE_FIELDS = new Set(['issueNumber', 'kind', 'holder']);
const PULL_REQUEST_FIELDS = new Set(['number', 'issueNumber', 'headSha']);
const ISSUE_STATES = new Set(['open', 'closed']);

const VALIDATED_QUEUE_EVIDENCE = new WeakSet();

/**
 * The stable, deterministic key that links one proposed plan item to the one
 * GitHub issue curated for it. It is derived only from the registered project
 * id and the proposal's own issue id, so identical plan input always resolves
 * to the same queue record without consulting any external state.
 */
export function queueCurationKey(projectId, proposedIssueId) {
  if (!nonEmptyString(projectId) || !TOKEN_PATTERN.test(projectId)) {
    throw new Error('queueCurationKey requires a safe lowercase project id token');
  }
  if (!nonEmptyString(proposedIssueId) || !TOKEN_PATTERN.test(proposedIssueId)) {
    throw new Error('queueCurationKey requires a safe lowercase proposed issue id token');
  }
  const key = `qc:${projectId}:${proposedIssueId}`;
  if (key.length > MAX_CURATION_KEY_LENGTH) {
    throw new Error(`queueCurationKey must be at most ${MAX_CURATION_KEY_LENGTH} characters`);
  }
  return key;
}

/** Whitespace-collapsed, case-folded title used for deterministic identity matching. */
export function normalizeQueueTitle(title) {
  return String(title).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The proposal carries its repository as the canonical `owner/name` string;
 * the exact owner/name pair comes from the evidence snapshot it was built
 * from, which is the same object the registered profile was validated against.
 */
function proposalRepository(proposal) {
  return proposal.brief.evidence.repository;
}

function validateRepositoryMatch(repository, proposal, errors) {
  const expected = proposalRepository(proposal);
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
  if (`${owner}/${name}`.toLowerCase() !== expected.full.toLowerCase()) {
    errors.push(`repository must exactly match the proposal repository '${expected.full}'`);
    return null;
  }
  return Object.freeze({ owner: expected.owner, name: expected.name, full: expected.full });
}

function validateIssueLabels(labels, label, errors) {
  if (labels === undefined) return freezeArray([]);
  if (!Array.isArray(labels) || labels.length > MAX_LABELS_PER_ISSUE) {
    errors.push(`${label} must be an array of at most ${MAX_LABELS_PER_ISSUE} label strings`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  labels.forEach((value, index) => {
    if (!nonEmptyString(value) || !LABEL_VALUE_PATTERN.test(value)) {
      errors.push(`${label}[${index}] must be a safe label string`);
      return;
    }
    if (seen.has(value)) {
      errors.push(`${label}[${index}] duplicates an already-listed label`);
      return;
    }
    seen.add(value);
    normalized.push(value);
  });
  if (errors.length) return null;
  // Sorted so an incidental GitHub label ordering can never change the
  // normalized evidence, its fingerprint or any downstream comparison.
  return freezeArray([...normalized].sort());
}

/**
 * A dependency edge is either a bare issue number in this same repository or
 * an explicitly qualified `owner/repo#number` reference. A qualified reference
 * to any repository other than the registered one is refused outright: queue
 * curation is bounded to exactly one registered project.
 */
function validateDependsOn(dependsOn, repositoryFull, label, errors) {
  if (dependsOn === undefined) return freezeArray([]);
  if (!Array.isArray(dependsOn) || dependsOn.length > MAX_DEPENDENCIES_PER_ISSUE) {
    errors.push(`${label} must be an array of at most ${MAX_DEPENDENCIES_PER_ISSUE} dependency references`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  dependsOn.forEach((value, index) => {
    let number = null;
    if (Number.isInteger(value)) {
      if (value <= 0) {
        errors.push(`${label}[${index}] must be a positive issue number`);
        return;
      }
      number = value;
    } else if (nonEmptyString(value)) {
      const match = String(value).match(QUALIFIED_DEPENDENCY_PATTERN);
      if (!match) {
        errors.push(`${label}[${index}] must be an issue number or an "owner/repo#number" reference`);
        return;
      }
      if (match[1].toLowerCase() !== repositoryFull.toLowerCase()) {
        errors.push(`${label}[${index}] references repository '${match[1]}' outside the registered project repository '${repositoryFull}'`);
        return;
      }
      number = Number(match[2]);
    } else {
      errors.push(`${label}[${index}] must be an issue number or an "owner/repo#number" reference`);
      return;
    }
    if (seen.has(number)) {
      errors.push(`${label}[${index}] duplicates an already-listed dependency`);
      return;
    }
    seen.add(number);
    normalized.push(number);
  });
  if (errors.length) return null;
  return freezeArray([...normalized].sort((a, b) => a - b));
}

function validateIssues(issues, repositoryFull, errors) {
  if (!Array.isArray(issues) || issues.length > MAX_ISSUES) {
    errors.push(`issues must be an array of at most ${MAX_ISSUES} entries`);
    return null;
  }
  const seenNumbers = new Set();
  const seenCurationKeys = new Set();
  const normalized = [];
  issues.forEach((issue, index) => {
    const label = `issues[${index}]`;
    const before = errors.length;
    if (!isPlainObject(issue)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(issue, ISSUE_FIELDS, label, errors);
    const {
      number, title, state, labels, curationKey, dependsOn, supersededBy,
    } = issue;
    if (!Number.isInteger(number) || number <= 0) errors.push(`${label}.number must be a positive integer`);
    else if (seenNumbers.has(number)) errors.push(`${label}.number duplicates an already-listed issue`);
    // Real issue titles legitimately describe merges, deploys and closes;
    // only proposal-authored text is held to the write-action prohibition.
    assertBoundedSafeText(title, `${label}.title`, errors, { max: MAX_TITLE, allowWriteActionScan: false });
    if (!ISSUE_STATES.has(state)) errors.push(`${label}.state must be one of ${[...ISSUE_STATES].join(', ')}`);
    const normalizedLabels = validateIssueLabels(labels, `${label}.labels`, errors);
    let normalizedCurationKey = null;
    if (curationKey !== undefined && curationKey !== null) {
      if (!nonEmptyString(curationKey) || curationKey.length > MAX_CURATION_KEY_LENGTH || !CURATION_KEY_PATTERN.test(curationKey)) {
        errors.push(`${label}.curationKey must be a bounded "qc:<projectId>:<proposedIssueId>" key`);
      } else if (seenCurationKeys.has(curationKey)) {
        errors.push(`${label}.curationKey duplicates curation key '${curationKey}' already claimed by another issue`);
      } else {
        normalizedCurationKey = curationKey;
      }
    }
    const normalizedDependsOn = validateDependsOn(dependsOn, repositoryFull, `${label}.dependsOn`, errors);
    let normalizedSupersededBy = null;
    if (supersededBy !== undefined && supersededBy !== null) {
      if (!Number.isInteger(supersededBy) || supersededBy <= 0) errors.push(`${label}.supersededBy must be a positive issue number`);
      else if (supersededBy === number) errors.push(`${label}.supersededBy must not reference the issue itself`);
      else normalizedSupersededBy = supersededBy;
    }
    if (Number.isInteger(number) && normalizedDependsOn && normalizedDependsOn.includes(number)) {
      errors.push(`${label}.dependsOn must not depend on the issue itself`);
    }
    if (errors.length === before) {
      seenNumbers.add(number);
      if (normalizedCurationKey) seenCurationKeys.add(normalizedCurationKey);
      normalized.push(Object.freeze({
        number,
        title: title.trim(),
        state,
        labels: normalizedLabels,
        curationKey: normalizedCurationKey,
        dependsOn: normalizedDependsOn,
        supersededBy: normalizedSupersededBy,
      }));
    }
  });
  if (errors.length) return null;
  return freezeArray([...normalized].sort((a, b) => a.number - b.number));
}

function validateLeases(leases, errors) {
  if (leases === undefined) return freezeArray([]);
  if (!Array.isArray(leases) || leases.length > MAX_LEASES) {
    errors.push(`ownership.activeLeases must be an array of at most ${MAX_LEASES} entries`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  leases.forEach((lease, index) => {
    const label = `ownership.activeLeases[${index}]`;
    const before = errors.length;
    if (!isPlainObject(lease)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(lease, LEASE_FIELDS, label, errors);
    const { issueNumber, kind, holder } = lease;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) errors.push(`${label}.issueNumber must be a positive integer`);
    if (!QUEUE_LEASE_KINDS.includes(kind)) errors.push(`${label}.kind must be one of ${QUEUE_LEASE_KINDS.join(', ')}`);
    if (!nonEmptyString(holder) || !HOLDER_PATTERN.test(holder)) errors.push(`${label}.holder must be a bounded machine-safe owner identifier`);
    const key = `${issueNumber}:${kind}`;
    if (seen.has(key)) errors.push(`${label} duplicates an already-listed ${kind} lease on issue ${issueNumber}`);
    if (errors.length === before) {
      seen.add(key);
      normalized.push(Object.freeze({ issueNumber, kind, holder }));
    }
  });
  if (errors.length) return null;
  return freezeArray([...normalized].sort((a, b) => (a.issueNumber - b.issueNumber) || a.kind.localeCompare(b.kind)));
}

function validateOpenPullRequests(pulls, errors) {
  if (pulls === undefined) return freezeArray([]);
  if (!Array.isArray(pulls) || pulls.length > MAX_PULL_REQUESTS) {
    errors.push(`ownership.openPullRequests must be an array of at most ${MAX_PULL_REQUESTS} entries`);
    return null;
  }
  const seen = new Set();
  const normalized = [];
  pulls.forEach((pull, index) => {
    const label = `ownership.openPullRequests[${index}]`;
    const before = errors.length;
    if (!isPlainObject(pull)) {
      errors.push(`${label} must be an object`);
      return;
    }
    assertNoUnknownFields(pull, PULL_REQUEST_FIELDS, label, errors);
    const { number, issueNumber, headSha } = pull;
    if (!Number.isInteger(number) || number <= 0) errors.push(`${label}.number must be a positive integer`);
    else if (seen.has(number)) errors.push(`${label}.number duplicates an already-listed pull request`);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) errors.push(`${label}.issueNumber must be a positive integer`);
    let normalizedHeadSha = null;
    if (headSha !== undefined && headSha !== null) {
      if (!nonEmptyString(headSha) || !SHA_PATTERN.test(String(headSha).toLowerCase())) errors.push(`${label}.headSha must be a 40-character hex commit SHA`);
      else normalizedHeadSha = String(headSha).toLowerCase();
    }
    if (errors.length === before) {
      seen.add(number);
      normalized.push(Object.freeze({ number, issueNumber, headSha: normalizedHeadSha }));
    }
  });
  if (errors.length) return null;
  return freezeArray([...normalized].sort((a, b) => a.number - b.number));
}

function validateOwnership(ownership, errors) {
  if (!isPlainObject(ownership)) {
    errors.push('ownership must be an object with activeLeases and openPullRequests');
    return null;
  }
  assertNoUnknownFields(ownership, OWNERSHIP_FIELDS, 'ownership', errors);
  const activeLeases = validateLeases(ownership.activeLeases, errors);
  const openPullRequests = validateOpenPullRequests(ownership.openPullRequests, errors);
  if (errors.length) return null;
  return Object.freeze({ activeLeases, openPullRequests });
}

/**
 * Cross-record consistency. These are the states that cannot be detected by
 * validating any single record in isolation, and every one of them is a
 * fail-closed refusal rather than a silently tolerated inconsistency.
 */
function validateQueueConsistency(issues, ownership, errors) {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));

  for (const issue of issues) {
    for (const dependency of issue.dependsOn) {
      if (!byNumber.has(dependency)) {
        errors.push(`issue ${issue.number} depends on issue ${dependency}, which is not present in this project's queue evidence`);
      }
    }
    if (issue.supersededBy !== null && !byNumber.has(issue.supersededBy)) {
      errors.push(`issue ${issue.number} is superseded by issue ${issue.supersededBy}, which is not present in this project's queue evidence`);
    }
  }

  // Supersession must terminate: a cycle or an over-long chain is synthetic
  // state that no deterministic curation could resolve.
  for (const issue of issues) {
    if (issue.supersededBy === null) continue;
    const visited = new Set([issue.number]);
    let cursor = byNumber.get(issue.supersededBy) ?? null;
    let depth = 0;
    while (cursor && cursor.supersededBy !== null) {
      if (visited.has(cursor.number)) {
        errors.push(`issue ${issue.number} participates in a supersession cycle`);
        break;
      }
      visited.add(cursor.number);
      depth += 1;
      if (depth > MAX_SUPERSESSION_DEPTH) {
        errors.push(`issue ${issue.number} exceeds the bounded supersession chain depth of ${MAX_SUPERSESSION_DEPTH}`);
        break;
      }
      cursor = byNumber.get(cursor.supersededBy) ?? null;
    }
  }

  const leaseKindsByIssue = new Map();
  for (const lease of ownership.activeLeases) {
    if (!byNumber.has(lease.issueNumber)) {
      errors.push(`ownership.activeLeases references issue ${lease.issueNumber}, which is not present in this project's queue evidence`);
      continue;
    }
    const kinds = leaseKindsByIssue.get(lease.issueNumber) ?? new Set();
    kinds.add(lease.kind);
    leaseKindsByIssue.set(lease.issueNumber, kinds);
    const leasedIssue = byNumber.get(lease.issueNumber);
    if (leasedIssue.supersededBy !== null) {
      errors.push(`issue ${lease.issueNumber} is superseded but still holds an active ${lease.kind} lease`);
    }
    if (leasedIssue.state === 'closed') {
      errors.push(`issue ${lease.issueNumber} is closed but still holds an active ${lease.kind} lease`);
    }
  }
  for (const [issueNumber, kinds] of leaseKindsByIssue) {
    if (kinds.size > 1) {
      errors.push(`issue ${issueNumber} is held by both an implementation and a recovery lease at the same time`);
    }
  }

  const implementationLeases = ownership.activeLeases.filter((lease) => lease.kind === 'implementation');
  if (implementationLeases.length > 1) {
    errors.push(`the one-global-implementation-slot invariant is violated: ${implementationLeases.length} active implementation leases`);
  }

  for (const pull of ownership.openPullRequests) {
    if (!byNumber.has(pull.issueNumber)) {
      errors.push(`ownership.openPullRequests references issue ${pull.issueNumber}, which is not present in this project's queue evidence`);
    }
  }

  return errors.length === 0;
}

/**
 * Validate a raw current-queue evidence object against an already-validated
 * plan proposal. Fails closed (throws) on unknown/missing fields, ambiguous
 * repository/project/branch/source provenance, duplicate issue or curation-key
 * identity, dependency edges outside the registered project, dangling or
 * cyclic supersession, colliding implementation/recovery ownership and any
 * violation of the one-global-implementation-slot invariant.
 */
export function validateManagerQueueEvidence(input, { proposal } = {}) {
  assertNormalizedManagerPlanProposalShape(proposal);
  const errors = [];
  if (!proposal.brief.evidence.profile.enabled) {
    errors.push('queue evidence cannot be constructed for a disabled manager profile');
  }
  if (!isPlainObject(input)) throw new Error('Invalid agent runner manager queue evidence: queue evidence must be a JSON object');
  assertNoUnknownFields(input, TOP_LEVEL_FIELDS, 'queueEvidence', errors);
  for (const field of TOP_LEVEL_FIELDS) {
    if (!(field in input)) errors.push(`queueEvidence.${field} is required`);
  }
  if (errors.length) throw new Error(`Invalid agent runner manager queue evidence: ${errors.join('; ')}`);

  if (input.schemaVersion !== MANAGER_QUEUE_EVIDENCE_SCHEMA_VERSION) errors.push(`schemaVersion must equal "${MANAGER_QUEUE_EVIDENCE_SCHEMA_VERSION}"`);
  if (input.projectId !== proposal.projectId) errors.push(`projectId must exactly match the proposal projectId '${proposal.projectId}'`);

  const repository = validateRepositoryMatch(input.repository, proposal, errors);
  if (input.branch !== proposal.branch) errors.push(`branch must exactly match the proposal branch '${proposal.branch}'`);
  if (!nonEmptyString(input.sourceSha) || !SHA_PATTERN.test(String(input.sourceSha).toLowerCase())) {
    errors.push('sourceSha must be a 40-character hex commit SHA');
  } else if (String(input.sourceSha).toLowerCase() !== proposal.sourceSha) {
    errors.push(`sourceSha must exactly match the proposal sourceSha '${proposal.sourceSha}'`);
  }
  assertBoundedSafeText(input.evidenceRevision, 'evidenceRevision', errors, { max: 200, allowWriteActionScan: false });
  if (nonEmptyString(input.evidenceRevision) && !EVIDENCE_REVISION_PATTERN.test(input.evidenceRevision)) {
    errors.push('evidenceRevision must be a machine-safe revision identifier');
  }
  if (!nonEmptyString(input.evidenceTimestamp) || !EVIDENCE_TIMESTAMP_PATTERN.test(input.evidenceTimestamp)) {
    errors.push('evidenceTimestamp must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)');
  }

  const repositoryFull = repository?.full ?? proposalRepository(proposal).full;
  const issues = validateIssues(input.issues, repositoryFull, errors);
  const ownership = validateOwnership(input.ownership, errors);

  if (errors.length) throw new Error(`Invalid agent runner manager queue evidence: ${errors.join('; ')}`);

  validateQueueConsistency(issues, ownership, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager queue evidence: ${errors.join('; ')}`);

  const fingerprintPayload = Object.freeze({
    schemaVersion: input.schemaVersion,
    projectId: input.projectId,
    repository,
    branch: input.branch,
    sourceSha: input.sourceSha.toLowerCase(),
    evidenceRevision: input.evidenceRevision,
    evidenceTimestamp: input.evidenceTimestamp,
    issues,
    ownership,
  });
  const queueEvidenceFingerprint = contentFingerprint(fingerprintPayload);
  const normalized = Object.freeze({ ...fingerprintPayload, queueEvidenceFingerprint, proposal });
  VALIDATED_QUEUE_EVIDENCE.add(normalized);
  return normalized;
}

/**
 * Refuse anything that merely *looks* like validated queue evidence.
 * Provenance is checked against a `WeakSet` populated only by
 * `validateManagerQueueEvidence()` itself, so it cannot be forged by
 * constructing a look-alike frozen object.
 */
export function assertNormalizedManagerQueueEvidenceShape(queueEvidence) {
  if (!isPlainObject(queueEvidence) || !Object.isFrozen(queueEvidence) || !VALIDATED_QUEUE_EVIDENCE.has(queueEvidence)) {
    throw new Error('requires an already-validated manager queue evidence snapshot: object was not produced by validateManagerQueueEvidence');
  }
}
