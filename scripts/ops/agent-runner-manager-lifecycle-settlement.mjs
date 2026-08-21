#!/usr/bin/env node

/**
 * #267 Parts D-G: the bounded, deterministic settlement transition that turns
 * validated exact-head evidence into exactly one lifecycle class, plus the
 * separately validated same-pull-request continuation transition -- see
 * docs/ops/AGENT-RUNNER-MANAGER-AUTHORITY-REVIEW.md.
 *
 * A settlement is a pure function of its evidence. It never schedules a
 * worker, never enqueues a management event, never invokes a provider, never
 * integrates or closes anything, never deploys and never activates a source.
 * It returns a bounded lifecycle result that #268 may later consume, and it
 * embeds no timer, recurrence, sleep or poll assumption and reads no clock, so
 * `agent-runner-management-events.mjs` (#289) remains the single owner of the
 * durable ledger, dedupe, leases, delayed events and wake primitives.
 *
 * Completion is never inferred from prose, from a branch existing, from a
 * commit existing, from a pull request existing on its own, or from a check
 * result produced against any commit other than the exact current head.
 */

import {
  MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER,
  managerAuthorityKey,
} from './agent-runner-manager-authority.mjs';
import {
  assertNormalizedSettlementEvidenceShape,
} from './agent-runner-manager-settlement-evidence.mjs';
import {
  AUTHORITY_PRODUCER_DOMAIN,
  assertNormalizedWorkerAuthorityShape,
} from './agent-runner-manager-worker-authority.mjs';
import {
  assertNoUnknownFields,
  contentFingerprint,
  freezeArray,
  isPlainObject,
  nonEmptyString,
  stableJson,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGER_LIFECYCLE_SETTLEMENT_SCHEMA_VERSION = 'agent-runner-manager-lifecycle-settlement/v1';
export const MANAGER_CONTINUATION_AUTHORITY_SCHEMA_VERSION = 'agent-runner-manager-continuation-authority/v1';

/**
 * The complete bounded set of lifecycle classes a settlement may report. There
 * is deliberately no class that integrates, closes, deploys or activates
 * anything: those remain separately disabled capabilities.
 */
export const LIFECYCLE_CLASSES = Object.freeze([
  'continue-execution',
  'programme-reconcile',
  'assurance-required',
  'delayed-retry',
  'blocked',
  'owner-attention',
  'no-op',
]);

/**
 * The only successors a later event controller may derive from one settlement.
 * These names mirror the #289 management-event types (and #266's hint set) so
 * #268 can bind them without translation, but this module never enqueues one.
 */
export const SETTLEMENT_SUCCESSOR_HINTS = Object.freeze([
  'none',
  'execution-reconcile-required',
  'programme-reconcile-required',
  'queue-assurance-required',
  'delayed-retry',
]);

/** A correction is always continued on the already-authorised pull request. */
export const CONTINUATION_KINDS = Object.freeze(['same-pull-request']);

const SUCCESSOR_BY_CLASS = Object.freeze({
  'continue-execution': 'execution-reconcile-required',
  'programme-reconcile': 'programme-reconcile-required',
  'assurance-required': 'queue-assurance-required',
  'delayed-retry': 'delayed-retry',
  blocked: 'programme-reconcile-required',
  'owner-attention': 'programme-reconcile-required',
  'no-op': 'none',
});

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const PRODUCER_FIELDS = new Set(['type', 'domain', 'id']);
const CONTINUATION_REQUEST_FIELDS = new Set(['pullRequestNumber', 'branch', 'headSha']);
const OWNERSHIP_FIELDS = new Set(['activeLeases', 'openPullRequests', 'workspace']);
const LEASE_FIELDS = new Set(['issueNumber', 'kind', 'holder']);
const OWNERSHIP_PR_FIELDS = new Set(['number', 'issueNumber', 'headSha']);
const WORKSPACE_FIELDS = new Set(['branch', 'ownerAttemptId']);
const SETTLE_FIELDS = new Set(['evidence', 'previousSettlement']);
const CONTINUATION_FIELDS = new Set(['authority', 'settlement', 'producer', 'request', 'ownership']);

const VALIDATED_SETTLEMENTS = new WeakSet();
const VALIDATED_CONTINUATIONS = new WeakSet();

function requiredChecks(evidence) {
  return evidence.ci ? evidence.ci.checks.filter((check) => check.required) : [];
}

function blockingFindings(evidence) {
  return evidence.review ? evidence.review.findings.filter((finding) => finding.severity === 'blocking') : [];
}

/**
 * The fixed, documented precedence. It is expressed as an ordered rule list so
 * identical evidence always yields an identical class, and so the ordering
 * between two simultaneously true conditions is explicit rather than emergent.
 *
 * Ordering rationale, highest first: a pull request that is no longer open is
 * a programme fact, not an implementation defect; an abandoned attempt or a
 * blocking finding the implementation cannot decide needs an owner; a failed
 * publication is a deterministic prerequisite failure; only then is the
 * exact-head check and review evidence read.
 */
const SETTLEMENT_RULES = Object.freeze([
  Object.freeze({
    lifecycleClass: 'no-op',
    reason: 'no-worker-publication',
    when: (evidence) => evidence.publication === null,
  }),
  Object.freeze({
    lifecycleClass: 'programme-reconcile',
    reason: 'authorised-pull-request-no-longer-open',
    when: (evidence) => evidence.pullRequest !== null && evidence.pullRequest.state !== 'open',
  }),
  Object.freeze({
    lifecycleClass: 'owner-attention',
    reason: 'worker-attempt-abandoned',
    when: (evidence) => evidence.publication.completionState === 'abandoned',
  }),
  Object.freeze({
    lifecycleClass: 'owner-attention',
    reason: 'non-actionable-blocking-finding',
    when: (evidence) => blockingFindings(evidence).some((finding) => finding.actionable === false),
  }),
  Object.freeze({
    lifecycleClass: 'blocked',
    reason: 'worker-publication-failed',
    when: (evidence) => evidence.publication.completionState === 'failed',
  }),
  Object.freeze({
    lifecycleClass: 'blocked',
    reason: 'no-authorised-pull-request-evidence',
    when: (evidence) => evidence.pullRequest === null && evidence.publication.completionState === 'published',
  }),
  Object.freeze({
    lifecycleClass: 'delayed-retry',
    reason: 'attempt-incomplete-without-pull-request',
    when: (evidence) => evidence.pullRequest === null,
  }),
  Object.freeze({
    lifecycleClass: 'continue-execution',
    reason: 'attempt-incomplete-on-authorised-pull-request',
    when: (evidence) => evidence.publication.completionState === 'incomplete',
  }),
  Object.freeze({
    lifecycleClass: 'delayed-retry',
    reason: 'exact-head-check-evidence-missing',
    when: (evidence) => evidence.ci === null,
  }),
  Object.freeze({
    lifecycleClass: 'continue-execution',
    reason: 'required-check-failed-at-exact-head',
    when: (evidence) => requiredChecks(evidence).some((check) => check.state === 'failure'),
  }),
  Object.freeze({
    lifecycleClass: 'assurance-required',
    reason: 'ambiguous-required-check-state',
    when: (evidence) => requiredChecks(evidence).some((check) => check.state === 'cancelled' || check.state === 'neutral'),
  }),
  Object.freeze({
    lifecycleClass: 'delayed-retry',
    reason: 'required-check-pending-at-exact-head',
    when: (evidence) => requiredChecks(evidence).some((check) => check.state === 'pending'),
  }),
  Object.freeze({
    lifecycleClass: 'delayed-retry',
    reason: 'no-required-check-reported-at-exact-head',
    when: (evidence) => requiredChecks(evidence).length === 0,
  }),
  Object.freeze({
    lifecycleClass: 'continue-execution',
    reason: 'actionable-review-defect',
    when: (evidence) => evidence.review !== null && evidence.review.state === 'changes-requested',
  }),
  Object.freeze({
    lifecycleClass: 'assurance-required',
    reason: 'independent-assurance-outstanding',
    when: (evidence) => evidence.review === null || evidence.review.state === 'pending',
  }),
  Object.freeze({
    lifecycleClass: 'assurance-required',
    reason: 'exact-head-evidence-terminal-green',
    when: (evidence) => evidence.review.state === 'no-blockers',
  }),
  // Terminal catch-all so every evidence shape resolves to exactly one class.
  Object.freeze({
    lifecycleClass: 'no-op',
    reason: 'no-semantic-change',
    when: () => true,
  }),
]);

/**
 * The bounded defect set a continuation must correct, derived only from
 * already-validated evidence: failing required checks at the exact head,
 * actionable blocking review findings, and an explicitly incomplete attempt.
 * No prose and no free text from the worker reaches this list.
 */
function continuationDefects(evidence) {
  const defects = [];
  if (evidence.publication.completionState === 'incomplete') {
    defects.push({ source: 'publication', id: evidence.publication.attemptId, classification: 'attempt-incomplete' });
  }
  for (const check of requiredChecks(evidence)) {
    if (check.state === 'failure') {
      defects.push({ source: 'ci', id: check.name, classification: check.failureClass ?? 'required-check-failed' });
    }
  }
  for (const finding of blockingFindings(evidence)) {
    if (finding.actionable) {
      defects.push({ source: 'review', id: finding.id, classification: finding.category });
    }
  }
  return freezeArray(
    [...defects]
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
      .map((defect) => Object.freeze(defect)),
  );
}

function buildContinuation(evidence) {
  const defects = continuationDefects(evidence);
  if (defects.length === 0) return null;
  return Object.freeze({
    kind: 'same-pull-request',
    projectId: evidence.projectId,
    repository: evidence.repository,
    issueNumber: evidence.issueNumber,
    pullRequestNumber: evidence.pullRequest.number,
    branch: evidence.branch,
    baseSha: evidence.baseSha,
    headSha: evidence.pullRequest.headSha,
    attemptId: evidence.attemptId,
    defects,
  });
}

/**
 * Reconcile new evidence against the settlement that already stands for this
 * authority. Identical evidence is an idempotent no-change replay; evidence
 * that contradicts or precedes what has already been settled fails closed
 * rather than silently rewriting lifecycle history.
 */
function reconcileReplay(evidence, previousSettlement) {
  if (previousSettlement === null || previousSettlement === undefined) return false;
  assertNormalizedLifecycleSettlementShape(previousSettlement);
  if (previousSettlement.authorityFingerprint !== evidence.authorityFingerprint) {
    throw new Error('Invalid agent runner manager lifecycle settlement: previousSettlement belongs to a different worker authority');
  }
  if (previousSettlement.attemptId !== evidence.attemptId) {
    throw new Error('Invalid agent runner manager lifecycle settlement: previousSettlement belongs to a different attempt');
  }
  if (previousSettlement.evidenceFingerprint === evidence.evidenceFingerprint) return true;
  if (evidence.evidenceSequence < previousSettlement.evidenceSequence) {
    throw new Error(
      `Invalid agent runner manager lifecycle settlement: evidence sequence ${evidence.evidenceSequence} precedes the already-settled sequence ${previousSettlement.evidenceSequence}; out-of-order evidence is never settled`,
    );
  }
  if (evidence.evidenceSequence === previousSettlement.evidenceSequence) {
    throw new Error(
      `Invalid agent runner manager lifecycle settlement: sequence ${evidence.evidenceSequence} was already settled with different evidence; conflicting replay is never settled`,
    );
  }
  return false;
}

function finalize(evidence, lifecycleClass, reason, continuation) {
  const payload = Object.freeze({
    schemaVersion: MANAGER_LIFECYCLE_SETTLEMENT_SCHEMA_VERSION,
    lifecycleClass,
    reason,
    projectId: evidence.projectId,
    repository: evidence.repository,
    issueNumber: evidence.issueNumber,
    branch: evidence.branch,
    baseSha: evidence.baseSha,
    authorityKey: evidence.authorityKey,
    authorityFingerprint: evidence.authorityFingerprint,
    attemptId: evidence.attemptId,
    pullRequestNumber: evidence.pullRequest ? evidence.pullRequest.number : null,
    headSha: evidence.pullRequest ? evidence.pullRequest.headSha : (evidence.publication ? evidence.publication.headSha : null),
    evidenceRevision: evidence.evidenceRevision,
    evidenceSequence: evidence.evidenceSequence,
    evidenceFingerprint: evidence.evidenceFingerprint,
    continuation,
    successorHint: SUCCESSOR_BY_CLASS[lifecycleClass],
    successorReason: reason,
  });
  const settlement = Object.freeze({ ...payload, settlementFingerprint: contentFingerprint(payload) });
  VALIDATED_SETTLEMENTS.add(settlement);
  return settlement;
}

/**
 * Settle one bounded evidence snapshot into exactly one lifecycle class.
 *
 * Without `previousSettlement` this is a pure function of the evidence:
 * identical evidence always yields an identical settlement and an identical
 * `settlementFingerprint`. With a `previousSettlement`, replaying the exact
 * same evidence yields a `no-op` no-change settlement instead of repeating the
 * work, while conflicting or out-of-order evidence fails closed.
 */
export function settleManagerLifecycle(input) {
  if (!isPlainObject(input)) {
    throw new Error('Invalid agent runner manager lifecycle settlement: input must be an object');
  }
  const errors = [];
  assertNoUnknownFields(input, SETTLE_FIELDS, 'input', errors);
  if (errors.length) throw new Error(`Invalid agent runner manager lifecycle settlement: ${errors.join('; ')}`);

  const { evidence, previousSettlement = null } = input;
  assertNormalizedSettlementEvidenceShape(evidence);

  if (reconcileReplay(evidence, previousSettlement)) {
    return finalize(evidence, 'no-op', 'replayed-settled-evidence', null);
  }

  const rule = SETTLEMENT_RULES.find((candidate) => candidate.when(evidence));
  const continuation = rule.lifecycleClass === 'continue-execution' ? buildContinuation(evidence) : null;
  if (rule.lifecycleClass === 'continue-execution' && continuation === null) {
    // A continuation with no bounded defect to correct would be unbounded
    // work: fail safe to independent assurance instead.
    return finalize(evidence, 'assurance-required', 'continuation-without-bounded-defect', null);
  }
  return finalize(evidence, rule.lifecycleClass, rule.reason, continuation);
}

/**
 * Refuse anything that merely *looks* like a settlement: provenance is checked
 * against a `WeakSet` populated only by `settleManagerLifecycle()` itself.
 */
export function assertNormalizedLifecycleSettlementShape(settlement) {
  if (!isPlainObject(settlement) || !Object.isFrozen(settlement) || !VALIDATED_SETTLEMENTS.has(settlement)) {
    throw new Error('requires an already-validated lifecycle settlement: object was not produced by settleManagerLifecycle');
  }
}

function validateContinuationProducer(producer, errors) {
  if (!isPlainObject(producer)) {
    errors.push('producer must be an object identifying the authorising manager transition');
    return null;
  }
  assertNoUnknownFields(producer, PRODUCER_FIELDS, 'producer', errors);
  if (producer.type !== MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER) {
    errors.push(`producer.type must be '${MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER}'`);
  }
  // A continuation is a separately validated *manager* transition. The worker
  // that produced the defect evidence can never mint its own continuation.
  if (producer.domain !== AUTHORITY_PRODUCER_DOMAIN) {
    errors.push(`producer.domain must be '${AUTHORITY_PRODUCER_DOMAIN}': a worker may never mint its own continuation authority`);
  }
  if (!nonEmptyString(producer.id) || !IDENTITY_PATTERN.test(producer.id)) {
    errors.push('producer.id must be a bounded machine-safe producer identity');
  }
  return errors.length ? null : Object.freeze({ type: producer.type, domain: producer.domain, id: producer.id });
}

/**
 * The bounded ownership facts a continuation must be reconciled against. This
 * is identity only: lease kinds, issue and pull-request numbers, the exact
 * head and the owning attempt. No local path, no worktree path and no recovery
 * handle is ever accepted here.
 */
function validateOwnership(ownership, errors) {
  if (ownership === undefined || ownership === null) {
    return Object.freeze({ activeLeases: freezeArray([]), openPullRequests: freezeArray([]), workspace: null });
  }
  if (!isPlainObject(ownership)) {
    errors.push('ownership must be an object when present');
    return null;
  }
  assertNoUnknownFields(ownership, OWNERSHIP_FIELDS, 'ownership', errors);
  const leases = [];
  const rawLeases = ownership.activeLeases ?? [];
  if (!Array.isArray(rawLeases)) {
    errors.push('ownership.activeLeases must be an array');
  } else {
    rawLeases.forEach((lease, index) => {
      const label = `ownership.activeLeases[${index}]`;
      if (!isPlainObject(lease)) {
        errors.push(`${label} must be an object`);
        return;
      }
      assertNoUnknownFields(lease, LEASE_FIELDS, label, errors);
      if (!Number.isInteger(lease.issueNumber) || lease.issueNumber <= 0) errors.push(`${label}.issueNumber must be a positive integer`);
      if (!['implementation', 'recovery'].includes(lease.kind)) errors.push(`${label}.kind must be implementation or recovery`);
      if (!nonEmptyString(lease.holder) || !IDENTITY_PATTERN.test(lease.holder)) errors.push(`${label}.holder must be a bounded machine-safe owner identity`);
      leases.push(Object.freeze({ issueNumber: lease.issueNumber, kind: lease.kind, holder: lease.holder }));
    });
  }
  const pulls = [];
  const rawPulls = ownership.openPullRequests ?? [];
  if (!Array.isArray(rawPulls)) {
    errors.push('ownership.openPullRequests must be an array');
  } else {
    rawPulls.forEach((pull, index) => {
      const label = `ownership.openPullRequests[${index}]`;
      if (!isPlainObject(pull)) {
        errors.push(`${label} must be an object`);
        return;
      }
      assertNoUnknownFields(pull, OWNERSHIP_PR_FIELDS, label, errors);
      if (!Number.isInteger(pull.number) || pull.number <= 0) errors.push(`${label}.number must be a positive integer`);
      if (!Number.isInteger(pull.issueNumber) || pull.issueNumber <= 0) errors.push(`${label}.issueNumber must be a positive integer`);
      if (!nonEmptyString(pull.headSha) || !SHA_PATTERN.test(pull.headSha)) errors.push(`${label}.headSha must be an exact 40-character lowercase commit SHA`);
      pulls.push(Object.freeze({ number: pull.number, issueNumber: pull.issueNumber, headSha: pull.headSha }));
    });
  }
  let workspace = null;
  if (ownership.workspace !== undefined && ownership.workspace !== null) {
    if (!isPlainObject(ownership.workspace)) {
      errors.push('ownership.workspace must be an object when present');
    } else {
      assertNoUnknownFields(ownership.workspace, WORKSPACE_FIELDS, 'ownership.workspace', errors);
      if (!nonEmptyString(ownership.workspace.branch)) errors.push('ownership.workspace.branch is required');
      if (!nonEmptyString(ownership.workspace.ownerAttemptId) || !IDENTITY_PATTERN.test(ownership.workspace.ownerAttemptId)) {
        errors.push('ownership.workspace.ownerAttemptId must be a bounded machine-safe attempt identity');
      }
      workspace = Object.freeze({ branch: ownership.workspace.branch, ownerAttemptId: ownership.workspace.ownerAttemptId });
    }
  }
  if (errors.length) return null;
  return Object.freeze({ activeLeases: freezeArray(leases), openPullRequests: freezeArray(pulls), workspace });
}

/**
 * Prove the continuation still targets exactly the same repository, issue,
 * pull request, branch, base and exact head that the settlement bound, and
 * that nothing else has taken ownership in the meantime.
 */
function assertContinuationIdentity({ authority, settlement, continuation, request, ownership }, errors) {
  if (settlement.authorityFingerprint !== authority.authorityFingerprint) {
    errors.push('settlement does not belong to the supplied worker authority');
  }
  if (continuation.repository.full !== authority.repository.full) errors.push('continuation repository identity changed');
  if (continuation.issueNumber !== authority.issueNumber) errors.push('continuation issue binding changed');
  if (continuation.branch !== authority.branch) errors.push('continuation branch identity changed');
  if (continuation.baseSha !== authority.baseSha) errors.push('continuation base commit changed');

  if (request !== undefined && request !== null) {
    if (!isPlainObject(request)) {
      errors.push('request must be an object when present');
      return;
    }
    assertNoUnknownFields(request, CONTINUATION_REQUEST_FIELDS, 'request', errors);
    // A correction is continued on the authorised pull request. Naming any
    // other pull request, branch or head is a replacement attempt, never a
    // continuation.
    if (request.pullRequestNumber !== undefined && request.pullRequestNumber !== continuation.pullRequestNumber) {
      errors.push(`request.pullRequestNumber ${request.pullRequestNumber} would replace the authorised pull request #${continuation.pullRequestNumber}`);
    }
    if (request.branch !== undefined && request.branch !== continuation.branch) {
      errors.push(`request.branch '${request.branch}' would replace the authorised branch '${continuation.branch}'`);
    }
    if (request.headSha !== undefined && request.headSha !== continuation.headSha) {
      errors.push(`request.headSha '${request.headSha}' is not the exact current pull-request head '${continuation.headSha}'`);
    }
  }

  for (const lease of ownership.activeLeases) {
    if (lease.kind === 'recovery' && lease.issueNumber === continuation.issueNumber) {
      errors.push(`issue #${continuation.issueNumber} is recovery-owned: a continuation can never take recovery-owned work`);
    }
    if (lease.kind === 'implementation' && lease.issueNumber !== continuation.issueNumber) {
      errors.push(`the one-global-implementation-slot invariant refuses this continuation: issue #${lease.issueNumber} holds the active implementation lease`);
    }
  }
  const issuePulls = ownership.openPullRequests.filter((pull) => pull.issueNumber === continuation.issueNumber);
  for (const pull of issuePulls) {
    if (pull.number !== continuation.pullRequestNumber) {
      errors.push(`issue #${continuation.issueNumber} also owns open pull request #${pull.number}: pull-request ownership is ambiguous`);
    } else if (pull.headSha !== continuation.headSha) {
      errors.push(`open pull request #${pull.number} now points at '${pull.headSha}', not the settled head '${continuation.headSha}'`);
    }
  }
  if (ownership.workspace) {
    if (ownership.workspace.branch !== continuation.branch) {
      errors.push(`the owning workspace is bound to branch '${ownership.workspace.branch}', not the authorised '${continuation.branch}'`);
    }
    if (ownership.workspace.ownerAttemptId !== continuation.attemptId) {
      errors.push(`the owning workspace belongs to attempt '${ownership.workspace.ownerAttemptId}', not the settled attempt '${continuation.attemptId}'`);
    }
  }
}

/**
 * Authorise one bounded continuation of the already-authorised pull request.
 *
 * This is a separately validated manager transition, not a worker decision: it
 * requires a `continue-execution` settlement carrying bounded defect evidence,
 * a producer in the manager authority domain, and unambiguous ownership of the
 * same repository, issue, pull request, branch, base and exact current head.
 * It never creates a replacement pull request or branch, and it starts
 * nothing.
 */
export function authorizeManagerContinuation(input) {
  if (!isPlainObject(input)) {
    throw new Error('Invalid agent runner manager continuation authority: input must be an object');
  }
  const errors = [];
  assertNoUnknownFields(input, CONTINUATION_FIELDS, 'input', errors);
  if (errors.length) throw new Error(`Invalid agent runner manager continuation authority: ${errors.join('; ')}`);

  const { authority, settlement, producer, request = null, ownership } = input;
  assertNormalizedWorkerAuthorityShape(authority);
  assertNormalizedLifecycleSettlementShape(settlement);

  if (settlement.lifecycleClass !== 'continue-execution' || settlement.continuation === null) {
    throw new Error(
      `Invalid agent runner manager continuation authority: settlement class '${settlement.lifecycleClass}' does not authorise a continuation`,
    );
  }

  const normalizedProducer = validateContinuationProducer(producer, errors);
  const normalizedOwnership = validateOwnership(ownership, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager continuation authority: ${errors.join('; ')}`);

  const continuation = settlement.continuation;
  assertContinuationIdentity({ authority, settlement, continuation, request, ownership: normalizedOwnership }, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager continuation authority: ${errors.join('; ')}`);

  const identityPayload = Object.freeze({
    schemaVersion: MANAGER_CONTINUATION_AUTHORITY_SCHEMA_VERSION,
    kind: continuation.kind,
    projectId: continuation.projectId,
    repository: continuation.repository,
    issueNumber: continuation.issueNumber,
    pullRequestNumber: continuation.pullRequestNumber,
    branch: continuation.branch,
    baseSha: continuation.baseSha,
    headSha: continuation.headSha,
    attemptId: continuation.attemptId,
    parentAuthorityKey: authority.authorityKey,
    parentAuthorityFingerprint: authority.authorityFingerprint,
    producer: normalizedProducer,
  });
  const continuationRevision = `mwc:${contentFingerprint(identityPayload).slice('sha256:'.length, 'sha256:'.length + 32)}`;

  const fingerprintPayload = Object.freeze({
    ...identityPayload,
    continuationRevision,
    adapter: authority.adapter,
    capabilityProfile: authority.capabilityProfile,
    model: authority.model,
    effort: authority.effort,
    validation: authority.validation,
    stopConditions: authority.stopConditions,
    defects: continuation.defects,
    settlementFingerprint: settlement.settlementFingerprint,
    evidenceFingerprint: settlement.evidenceFingerprint,
  });
  const continuationFingerprint = contentFingerprint(fingerprintPayload);
  const normalized = Object.freeze({
    ...fingerprintPayload,
    continuationFingerprint,
    continuationAuthorityKey: managerAuthorityKey(continuationRevision, continuationFingerprint),
  });
  VALIDATED_CONTINUATIONS.add(normalized);
  return normalized;
}

/**
 * Refuse anything that merely *looks* like a continuation authority:
 * provenance is checked against a `WeakSet` populated only by
 * `authorizeManagerContinuation()` itself.
 */
export function assertNormalizedContinuationAuthorityShape(continuation) {
  if (!isPlainObject(continuation) || !Object.isFrozen(continuation) || !VALIDATED_CONTINUATIONS.has(continuation)) {
    throw new Error('requires an already-validated continuation authority: object was not produced by authorizeManagerContinuation');
  }
}

/** Stable, deterministic serialization: identical inputs always yield identical bytes. */
export function serializeManagerLifecycleSettlement(settlement) {
  assertNormalizedLifecycleSettlementShape(settlement);
  return stableJson(settlement);
}
