#!/usr/bin/env node

/**
 * #266: the bounded queue-mutation transaction. `planQueueMutationTransaction`
 * is the last fail-closed gate before any GitHub write: it re-validates a
 * dry-run curation against the registered repository, the accepted manager
 * profile, the allowed label mapping, the per-recurrence mutation bounds and
 * the exact source revision the evidence was taken at.
 * `applyQueueMutationTransaction` then applies only those already-validated,
 * idempotent, attributable operations through an injected mutation port.
 *
 * This module owns no transport. It performs no GitHub call, no provider
 * invocation, no dispatch and no scheduling of its own; the caller supplies a
 * client implementing the documented port (see
 * docs/ops/AGENT-RUNNER-MANAGER-QUEUE-CURATOR.md), so no second GitHub
 * mutation path is introduced here.
 */

import { assertNormalizedManagerQueueCurationShape } from './agent-runner-manager-queue-curator.mjs';
import {
  assertBoundedSafeText,
  contentFingerprint,
  freezeArray,
  isPlainObject,
  nonEmptyString,
  stableJson,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGER_QUEUE_MUTATION_SCHEMA_VERSION = 'agent-runner-manager-queue-mutation/v1';

export const QUEUE_CURATION_MARKER = '<!-- agent-runner:queue-curation -->';
export const QUEUE_DEPENDENCY_BLOCK_START = '<!-- agent-runner:queue-dependencies:start -->';
export const QUEUE_DEPENDENCY_BLOCK_END = '<!-- agent-runner:queue-dependencies:end -->';

/** The only mutation kinds this transaction may ever carry. */
export const QUEUE_MUTATION_KINDS = Object.freeze(['create-issue', 'update-labels', 'update-dependencies']);

const CREATE_ENDPOINT_PATTERN = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues$/;
const UPDATE_ENDPOINT_PATTERN = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MAX_TITLE = 160;
const MAX_BODY = 4_000;
const MAX_SCOPE = 300;
const MAX_CRITERION = 300;
const MAX_ACCEPTANCE_CRITERIA = 10;
const MAX_DEPENDENCY_ENTRIES = 20;
const MAX_LABELS_PER_MUTATION = 20;

const APPLIED_TRANSACTIONS = new WeakSet();
const VALIDATED_TRANSACTIONS = new WeakSet();

function repositoryEndpointBase(repository) {
  return `/repos/${repository.owner}/${repository.name}`;
}

function dependencyLines(dependsOn) {
  if (dependsOn.length === 0) return ['- none'];
  return dependsOn.map((issueNumber) => `- #${issueNumber}`);
}

/**
 * The managed dependency block. It is deterministic, delimited by stable
 * markers and contains nothing but issue references, so a client can replace
 * exactly this block and never touch human-authored body text.
 */
export function renderQueueDependencyBlock(dependsOn) {
  return [
    QUEUE_DEPENDENCY_BLOCK_START,
    '## Depends on',
    '',
    ...dependencyLines(dependsOn),
    QUEUE_DEPENDENCY_BLOCK_END,
  ].join('\n');
}

/**
 * Deterministic issue body for a curated issue. Every line is either a stable
 * marker or already-validated bounded planner prose: the body never carries a
 * command, a payload, a credential, a raw prompt/log or a machine-local path.
 */
export function renderQueueIssueBody(bodySections, { curationRevision }) {
  return [
    QUEUE_CURATION_MARKER,
    `<!-- agent-runner:queue-curation-key: ${bodySections.curationKey} -->`,
    `<!-- agent-runner:queue-curation-revision: ${curationRevision} -->`,
    '',
    '## Scope',
    '',
    bodySections.scope,
    '',
    '## Acceptance criteria',
    '',
    ...bodySections.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    '',
    renderQueueDependencyBlock(bodySections.dependsOn),
    '',
    `<!-- agent-runner:queue-curation-milestone: ${bodySections.milestoneId} -->`,
  ].join('\n');
}

function assertMutationAuthority(profile, errors) {
  if (!profile.enabled) errors.push('manager profile is disabled and carries no queue mutation authority');
  if (profile.mutationAuthority.issueMutation !== true) {
    errors.push('manager profile does not authorise issue mutation');
  }
  // Queue curation never merges, closes, deploys or activates source. Those
  // authorities are deliberately *not* consulted here: `QUEUE_MUTATION_KINDS`
  // is the only thing that can reach the mutation port, so holding one of
  // them neither widens nor narrows what a curation may do.
}

function assertOperationText(operation, errors) {
  const label = `operation ${operation.kind} ${operation.curationKey}`;
  if (operation.kind !== 'create-issue') return;
  assertBoundedSafeText(operation.title, `${label}.title`, errors, { max: MAX_TITLE });
  assertBoundedSafeText(operation.bodySections.scope, `${label}.scope`, errors, { max: MAX_SCOPE });
  if (operation.bodySections.acceptanceCriteria.length === 0
    || operation.bodySections.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA) {
    errors.push(`${label}.acceptanceCriteria must contain between 1 and ${MAX_ACCEPTANCE_CRITERIA} entries`);
  }
  operation.bodySections.acceptanceCriteria.forEach((criterion, index) => {
    assertBoundedSafeText(criterion, `${label}.acceptanceCriteria[${index}]`, errors, { max: MAX_CRITERION });
  });
  if (operation.bodySections.dependsOn.length > MAX_DEPENDENCY_ENTRIES) {
    errors.push(`${label}.dependsOn must contain at most ${MAX_DEPENDENCY_ENTRIES} entries`);
  }
}

function assertLabelsAllowed(labels, allowedLabels, label, errors) {
  if (!Array.isArray(labels) || labels.length > MAX_LABELS_PER_MUTATION) {
    errors.push(`${label} must be a bounded label array`);
    return;
  }
  for (const value of labels) {
    if (!allowedLabels.has(value)) {
      errors.push(`${label} contains '${value}', which is not one of the manager profile's declared queue labels`);
    }
  }
}

/**
 * Collision guard applied at the mutation edge as well as during curation: an
 * operation may never target work that is currently leased, recovery-owned or
 * carrying an open pull request, even if a curation somehow proposed one.
 */
function assertNoActiveOwnershipCollision(curation, errors) {
  const queueEvidence = curation.queueEvidence;
  const leased = new Map(queueEvidence.ownership.activeLeases.map((lease) => [lease.issueNumber, lease.kind]));
  const withOpenPullRequest = new Set(queueEvidence.ownership.openPullRequests.map((pull) => pull.issueNumber));
  const profile = queueEvidence.proposal.brief.evidence.profile;
  const ownershipLabels = ['inProgress', 'done']
    .map((state) => profile.labels[state] ?? null)
    .filter((value) => value !== null);
  const labelsByIssue = new Map(queueEvidence.issues.map((issue) => [issue.number, issue.labels]));

  for (const operation of curation.operations) {
    if (operation.issueNumber === null) continue;
    if (leased.has(operation.issueNumber)) {
      errors.push(`operation ${operation.kind} targets issue #${operation.issueNumber}, which holds an active ${leased.get(operation.issueNumber)} lease`);
    }
    if (withOpenPullRequest.has(operation.issueNumber)) {
      errors.push(`operation ${operation.kind} targets issue #${operation.issueNumber}, which already has an open pull request`);
    }
    const labels = labelsByIssue.get(operation.issueNumber) ?? [];
    for (const ownershipLabel of ownershipLabels) {
      if (labels.includes(ownershipLabel)) {
        errors.push(`operation ${operation.kind} targets issue #${operation.issueNumber}, which is already owned downstream by label '${ownershipLabel}'`);
      }
    }
  }
}

function normalizeOperation(operation, { repository, curationRevision, allowedLabels, errors }) {
  const base = repositoryEndpointBase(repository);
  if (!QUEUE_MUTATION_KINDS.includes(operation.kind)) {
    errors.push(`operation kind '${operation.kind}' is outside the queue-curation mutation allowlist`);
    return null;
  }

  if (operation.kind === 'create-issue') {
    const endpoint = `${base}/issues`;
    if (!CREATE_ENDPOINT_PATTERN.test(endpoint)) {
      errors.push('issue creation endpoint is not allowlisted');
      return null;
    }
    assertLabelsAllowed(operation.labels, allowedLabels, `operation create-issue ${operation.curationKey}.labels`, errors);
    const body = renderQueueIssueBody(operation.bodySections, { curationRevision });
    if (body.length > MAX_BODY) {
      errors.push(`operation create-issue ${operation.curationKey} renders a body of ${body.length} characters, exceeding the ${MAX_BODY}-character bound`);
      return null;
    }
    return Object.freeze({
      kind: operation.kind,
      curationKey: operation.curationKey,
      proposedIssueId: operation.proposedIssueId,
      issueNumber: null,
      endpoint,
      request: Object.freeze({
        title: operation.title,
        body,
        labels: operation.labels,
      }),
    });
  }

  const endpoint = `${base}/issues/${operation.issueNumber}`;
  if (!UPDATE_ENDPOINT_PATTERN.test(endpoint)) {
    errors.push(`issue mutation endpoint for issue #${operation.issueNumber} is not allowlisted`);
    return null;
  }

  if (operation.kind === 'update-labels') {
    assertLabelsAllowed(operation.addLabels, allowedLabels, `operation update-labels ${operation.curationKey}.addLabels`, errors);
    assertLabelsAllowed(operation.removeLabels, allowedLabels, `operation update-labels ${operation.curationKey}.removeLabels`, errors);
    if (operation.resultingLabels.length > MAX_LABELS_PER_MUTATION) {
      errors.push(`operation update-labels ${operation.curationKey} would set more than ${MAX_LABELS_PER_MUTATION} labels`);
    }
    return Object.freeze({
      kind: operation.kind,
      curationKey: operation.curationKey,
      proposedIssueId: operation.proposedIssueId,
      issueNumber: operation.issueNumber,
      endpoint,
      request: Object.freeze({ labels: operation.resultingLabels }),
    });
  }

  if (operation.dependsOn.length > MAX_DEPENDENCY_ENTRIES) {
    errors.push(`operation update-dependencies ${operation.curationKey} exceeds the ${MAX_DEPENDENCY_ENTRIES}-entry dependency bound`);
    return null;
  }
  return Object.freeze({
    kind: operation.kind,
    curationKey: operation.curationKey,
    proposedIssueId: operation.proposedIssueId,
    issueNumber: operation.issueNumber,
    endpoint,
    request: Object.freeze({
      dependsOn: operation.dependsOn,
      dependencyBlock: renderQueueDependencyBlock(operation.dependsOn),
      blockStartMarker: QUEUE_DEPENDENCY_BLOCK_START,
      blockEndMarker: QUEUE_DEPENDENCY_BLOCK_END,
    }),
  });
}

/**
 * Validate a dry-run curation into an applyable transaction, or fail closed.
 * `currentSourceSha` is required: it is the caller's freshly observed source
 * revision, and a mismatch means the curation was computed against evidence
 * that is no longer current, so the whole transaction is refused rather than
 * applied against drifted state. It guards source drift specifically; drift in
 * the GitHub queue itself is guarded by recomputing the curation from fresh
 * queue evidence, which is cheap because the curation is a pure function.
 */
export function planQueueMutationTransaction(curation, { currentSourceSha } = {}) {
  assertNormalizedManagerQueueCurationShape(curation);
  const profile = curation.queueEvidence.proposal.brief.evidence.profile;
  const errors = [];

  assertMutationAuthority(profile, errors);

  if (curation.repository.full.toLowerCase() !== profile.repository.full.toLowerCase()) {
    errors.push(`curation repository '${curation.repository.full}' does not match the registered profile repository '${profile.repository.full}'`);
  }
  if (curation.projectId !== profile.projectId) {
    errors.push(`curation projectId '${curation.projectId}' does not match the registered profile projectId '${profile.projectId}'`);
  }
  if (!profile.branches.allowed.includes(curation.branch)) {
    errors.push(`curation branch '${curation.branch}' is not one of the profile's declared branches.allowed`);
  }
  if (!SHA_PATTERN.test(curation.sourceSha)) errors.push('curation sourceSha must be a 40-character hex commit SHA');
  if (!nonEmptyString(currentSourceSha) || !SHA_PATTERN.test(String(currentSourceSha).toLowerCase())) {
    errors.push('currentSourceSha is required and must be a 40-character hex commit SHA proving the curation is still current');
  } else if (String(currentSourceSha).toLowerCase() !== curation.sourceSha) {
    errors.push(`curation was computed at source revision '${curation.sourceSha}' but the current source revision is '${String(currentSourceSha).toLowerCase()}'`);
  }

  const bound = profile.mutationBounds.maxIssueMutationsPerRecurrence;
  if (curation.operations.length > bound) {
    errors.push(`curation proposes ${curation.operations.length} issue mutations, exceeding the manager profile bound of ${bound} per recurrence`);
  }

  assertNoActiveOwnershipCollision(curation, errors);
  for (const operation of curation.operations) {
    assertOperationText(operation, errors);
  }
  if (errors.length) throw new Error(`Refusing agent runner queue mutation transaction: ${errors.join('; ')}`);

  const allowedLabels = new Set(curation.curatableLabels);
  const operations = curation.operations
    .map((operation) => normalizeOperation(operation, {
      repository: curation.repository,
      curationRevision: curation.curationRevision,
      allowedLabels,
      errors,
    }))
    .filter(Boolean);
  if (errors.length) throw new Error(`Refusing agent runner queue mutation transaction: ${errors.join('; ')}`);

  const attribution = Object.freeze({
    projectId: curation.projectId,
    repository: curation.repository.full,
    branch: curation.branch,
    sourceSha: curation.sourceSha,
    curationRevision: curation.curationRevision,
    curationFingerprint: curation.curationFingerprint,
  });
  const fingerprintPayload = Object.freeze({
    schemaVersion: MANAGER_QUEUE_MUTATION_SCHEMA_VERSION,
    attribution,
    mutationBound: bound,
    operations: freezeArray(operations),
  });
  const transaction = Object.freeze({
    ...fingerprintPayload,
    transactionFingerprint: contentFingerprint(fingerprintPayload),
    outcome: curation.outcome,
    curation,
  });
  VALIDATED_TRANSACTIONS.add(transaction);
  return transaction;
}

export function assertValidatedQueueMutationTransactionShape(transaction) {
  if (!isPlainObject(transaction) || !Object.isFrozen(transaction) || !VALIDATED_TRANSACTIONS.has(transaction)) {
    throw new Error('requires an already-validated queue mutation transaction: object was not produced by planQueueMutationTransaction');
  }
}

function assertClientPort(client, transaction) {
  if (!isPlainObject(client)) throw new Error('queue mutation client is required');
  const required = new Set(transaction.operations.map((operation) => operation.kind));
  const methodByKind = {
    'create-issue': 'createIssue',
    'update-labels': 'updateIssueLabels',
    'update-dependencies': 'updateIssueDependencies',
  };
  for (const kind of required) {
    if (typeof client[methodByKind[kind]] !== 'function') {
      throw new Error(`queue mutation client must implement ${methodByKind[kind]}() to apply a ${kind} operation`);
    }
  }
  return methodByKind;
}

function boundedFailure(operation, error) {
  const code = typeof error?.code === 'string' && ERROR_CODE_PATTERN.test(error.code)
    ? error.code
    : 'queue-mutation-failed';
  return Object.freeze({
    kind: operation.kind,
    curationKey: operation.curationKey,
    issueNumber: operation.issueNumber,
    code,
  });
}

/**
 * Apply an already-validated transaction through the injected port. Every
 * operation is individually idempotent and attributable, and the operations
 * are applied in the transaction's deterministic order.
 *
 * GitHub offers no multi-issue atomicity, so a mid-transaction failure is
 * reported honestly as `partially-applied` with the exact remaining
 * operations, rather than being retried here or silently swallowed. Because
 * each operation is idempotent and the curation is a pure function of its
 * evidence, recomputing and re-applying after fresh evidence converges on the
 * same queue state.
 */
export function applyQueueMutationTransaction(transaction, { client } = {}) {
  assertValidatedQueueMutationTransactionShape(transaction);
  if (APPLIED_TRANSACTIONS.has(transaction)) {
    throw new Error('queue mutation transaction has already been applied; recompute a fresh curation from current evidence instead of replaying it');
  }
  const methodByKind = assertClientPort(client, transaction);
  APPLIED_TRANSACTIONS.add(transaction);

  const applied = [];
  let failure = null;
  for (const operation of transaction.operations) {
    try {
      const response = client[methodByKind[operation.kind]]({
        endpoint: operation.endpoint,
        curationKey: operation.curationKey,
        issueNumber: operation.issueNumber,
        attribution: transaction.attribution,
        ...operation.request,
      });
      let createdIssueNumber = null;
      if (operation.kind === 'create-issue') {
        createdIssueNumber = isPlainObject(response) ? response.number : null;
        if (!Number.isInteger(createdIssueNumber) || createdIssueNumber <= 0) {
          const error = new Error('queue mutation client returned no created issue number');
          error.code = 'queue-mutation-unverifiable';
          throw error;
        }
      }
      applied.push(Object.freeze({
        kind: operation.kind,
        curationKey: operation.curationKey,
        issueNumber: operation.issueNumber ?? createdIssueNumber,
      }));
    } catch (error) {
      failure = boundedFailure(operation, error);
      break;
    }
  }

  const pending = transaction.operations
    .slice(applied.length)
    .map((operation) => Object.freeze({
      kind: operation.kind,
      curationKey: operation.curationKey,
      issueNumber: operation.issueNumber,
    }));

  let status;
  if (failure === null) status = transaction.operations.length === 0 ? 'noop' : 'applied';
  else status = applied.length === 0 ? 'failed' : 'partially-applied';

  const outcome = failure === null
    ? transaction.outcome
    : Object.freeze({
      ...transaction.outcome,
      successorHint: 'delayed-retry',
      successorReason: 'mutation-incomplete',
    });

  return Object.freeze({
    schemaVersion: MANAGER_QUEUE_MUTATION_SCHEMA_VERSION,
    status,
    attribution: transaction.attribution,
    parity: Object.freeze({
      plannedOperationCount: transaction.operations.length,
      appliedOperationCount: applied.length,
      matchesDryRun: failure === null && applied.length === transaction.operations.length,
      transactionFingerprint: transaction.transactionFingerprint,
      curationFingerprint: transaction.attribution.curationFingerprint,
    }),
    appliedOperations: freezeArray(applied),
    pendingOperations: freezeArray(pending),
    failure,
    outcome,
  });
}

/** Stable, deterministic serialization of a validated transaction. */
export function serializeQueueMutationTransaction(transaction) {
  assertValidatedQueueMutationTransactionShape(transaction);
  const { curation, ...serializable } = transaction;
  return stableJson(serializable);
}
