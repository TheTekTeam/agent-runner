#!/usr/bin/env node

/**
 * #268 role 1: programme reconciliation -- the one **mutating** Build Manager
 * role.
 *
 * It inherits the responsibilities of the external Programme Manager / queue
 * keeper: re-read authoritative evidence, keep the queue truthful, choose the
 * dependency-correct next work, and prepare exactly one worker authority when
 * every gate permits.
 *
 * The wake event is only a signal. This handler is given a `collectEvidence`
 * port and **must** call it: every decision below is computed from freshly
 * collected, independently validated evidence, never from anything embedded in
 * the event. A stale, replayed or out-of-order event therefore reconciles
 * against current truth and degrades into a no-op rather than acting on a stale
 * instruction.
 *
 * What this role reuses rather than reimplements:
 *   - #261 plan/brief evidence, via the validated proposal inside queue evidence;
 *   - #266 queue evidence, deterministic curation and the bounded mutation boundary;
 *   - #267 worker-authority issuance, including its quota-only admission, its
 *     duplicate-authority ledger reconciliation and the one-global-implementation
 *     -slot invariant.
 *
 * What it never does: consume the authority it issues, merge, close, deploy,
 * activate source, dispatch a worker, or touch a timer or service. None of
 * those are capabilities this role can be granted.
 */

import {
  assertResolvedRoleCapabilities,
  hasCapability,
} from './agent-runner-management-control-mode.mjs';
import { buildManagementRoleResult } from './agent-runner-management-role-result.mjs';
import { buildManagementStatusProjection } from './agent-runner-management-status-projection.mjs';
import { curateManagerQueue } from './agent-runner-manager-queue-curator.mjs';
import { assertNormalizedManagerQueueEvidenceShape } from './agent-runner-manager-queue-evidence.mjs';
import {
  applyQueueMutationTransaction,
  planQueueMutationTransaction,
} from './agent-runner-manager-queue-mutation.mjs';
import { issueManagerWorkerAuthority } from './agent-runner-manager-worker-authority.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_PROGRAMME_ROLE_SCHEMA_VERSION = 'agent-runner-management-programme-role/v1';

/** The complete bounded set of programme outcomes. */
export const PROGRAMME_OUTCOMES = Object.freeze([
  'execution-required',
  'assurance-required',
  'delayed-retry',
  'blocked',
  'owner-attention',
  'quiescent',
  'no-op',
]);

const DEFAULT_RETRY_DELAY_MS = 5 * 60_000;
const MIN_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;

const EVIDENCE_FIELDS = new Set([
  'sourceSha', 'queueEvidence', 'quotaAdmission', 'implementationSlot',
  'authorityLedger', 'execution', 'producer', 'candidateRequests',
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The bounded states the one global implementation slot may be proven to be in.
 * `ambiguous` exists so an unreadable or malformed lock can never be mistaken
 * for a free slot.
 */
export const IMPLEMENTATION_SLOT_STATES = Object.freeze(['free', 'occupied', 'ambiguous']);

function fail(message) {
  throw new Error(`Refusing agent runner programme reconciliation: ${message}`);
}

/**
 * Resolve the proven slot state. A collector that reports only the older
 * boolean is honoured for `occupied`, but a bare `false` is *not* accepted as
 * proof of a free slot -- it must say so explicitly.
 */
function resolveSlotState(collected) {
  const slot = collected.implementationSlot;
  if (!isPlainObject(slot)) return null;
  if (nonEmptyString(slot.state)) return slot.state;
  return slot.occupied === true ? 'occupied' : null;
}

function boundedDelay(value) {
  if (!Number.isInteger(value)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, value));
}

function delayedFrom(now, delayMs) {
  const base = Date.parse(now);
  if (!Number.isFinite(base)) fail('now must be a valid timestamp');
  return new Date(base + delayMs).toISOString();
}

/**
 * The deterministic next-work choice.
 *
 * Records are already sorted by curation key, so identical evidence always
 * selects the same record. Only a record that is present, ready, unprotected
 * and backed by a collected candidate request is eligible; #267 re-checks every
 * one of those conditions when the authority is actually issued.
 */
function selectNextWork(curation, candidateRequests) {
  const byKey = new Map(candidateRequests.map((request) => [request.curationKey, request]));
  for (const record of curation.records) {
    if (record.classification !== 'present') continue;
    if (record.readiness !== 'ready') continue;
    if (record.protection !== null) continue;
    if (record.issueNumber == null) continue;
    const request = byKey.get(record.curationKey);
    if (request) return Object.freeze({ record, request });
  }
  return null;
}

function validateCandidateRequests(input) {
  if (!Array.isArray(input)) fail('collected evidence candidateRequests must be an array');
  if (input.length > 50) fail('collected evidence candidateRequests exceeds the bounded limit');
  return input.map((request, index) => {
    if (!isPlainObject(request)) fail(`collected evidence candidateRequests[${index}] must be an object`);
    if (!nonEmptyString(request.curationKey)) fail(`collected evidence candidateRequests[${index}].curationKey is required`);
    return request;
  });
}

function validateCollectedEvidence(collected) {
  if (!isPlainObject(collected)) fail('collectEvidence must return an object');
  const unknown = Object.keys(collected).filter((key) => !EVIDENCE_FIELDS.has(key));
  if (unknown.length > 0) fail(`collected evidence contains unsupported field(s): ${unknown.sort().join(', ')}`);
  // Provenance, not shape: this must be a snapshot the accepted #266 validator
  // produced, so the handler cannot be fed a hand-built look-alike.
  assertNormalizedManagerQueueEvidenceShape(collected.queueEvidence);
  if (!nonEmptyString(collected.sourceSha) || !SHA_PATTERN.test(collected.sourceSha)) {
    fail('collected evidence sourceSha must be an exact 40-character lowercase commit SHA');
  }
  // The global slot is a tri-state. "Unprovable" must never read as "free":
  // an unreadable or malformed lock is ambiguous, and ambiguity blocks a new
  // authority just as firmly as an occupied slot does.
  if (!isPlainObject(collected.implementationSlot)) {
    fail('collected evidence implementationSlot must be an object');
  }
  if (!IMPLEMENTATION_SLOT_STATES.includes(resolveSlotState(collected))) {
    fail(`collected evidence implementationSlot.state must be one of: ${IMPLEMENTATION_SLOT_STATES.join(', ')}`);
  }
  if (!isPlainObject(collected.quotaAdmission)) fail('collected evidence quotaAdmission must be an object');
  return collected;
}

/**
 * Bind the wake event to the freshly collected evidence. A management event may
 * never widen the scope it was raised for, so a project or repository mismatch
 * fails closed instead of reconciling the wrong project.
 */
function assertIdentityBinding(event, queueEvidence) {
  if (queueEvidence.projectId !== event.projectId) {
    fail(`collected evidence is for project '${queueEvidence.projectId}' but the event is for '${event.projectId}'`);
  }
  if (queueEvidence.repository.full.toLowerCase() !== String(event.repository).toLowerCase()) {
    fail(`collected evidence is for repository '${queueEvidence.repository.full}' but the event is for '${event.repository}'`);
  }
}

/**
 * Attribute the occupied global implementation slot to exactly one authorised
 * attempt of *this* project.
 *
 * Ownership is read from durable evidence only: the live authority ledger, plus
 * whatever pull-request identity the queue evidence can prove. Exactly one live
 * authority attributes; none or several does not. Selecting an arbitrary ledger
 * record would reconcile the wrong attempt, so that is never done.
 */
function attributeSlotOwner(curation, collected) {
  const live = (collected.authorityLedger?.issued ?? [])
    .filter((entry) => entry.state === 'issued' || entry.state === 'consumed');
  if (live.length === 0) {
    // Something holds the slot but this project granted nothing, so it belongs
    // to another registered project or to work outside the control plane.
    return { attributed: false, reason: 'owned-by-another-project' };
  }
  if (live.length > 1) return { attributed: false, reason: 'ambiguous-owner' };

  const owner = live[0];
  const pulls = curation.queueEvidence.ownership.openPullRequests
    .filter((pull) => pull.issueNumber === owner.issueNumber);
  if (pulls.length > 1) return { attributed: false, reason: 'ambiguous-owner' };
  const pull = pulls[0] ?? null;
  return {
    attributed: true,
    issueNumber: owner.issueNumber,
    // Included only when positively known: an attempt before publication has
    // no pull request or head yet, and inventing one would fail closed later.
    pullRequestNumber: pull ? pull.number : null,
    headSha: pull ? pull.headSha : null,
  };
}

/**
 * Classify what publication actually achieved.
 *
 * A suppressed publication (shadow) is not a failure -- nothing was meant to be
 * published -- but it is also not an externally available authority, so it is
 * reported as `suppressed` and the decision records `mutationSuppressed`.
 */
function publicationState(publication, capabilities) {
  if (!hasCapability(capabilities, 'publishWorkerAuthority')) return 'suppressed';
  if (!isPlainObject(publication)) return 'pending';
  if (publication.outcome === 'published' || publication.outcome === 'already-published') return 'confirmed';
  if (publication.outcome === 'conflict') return 'conflict';
  return 'pending';
}

function publicationReason(issueOutcome, state) {
  if (state === 'suppressed') {
    return issueOutcome === 'duplicate-no-op' ? 'authority-duplicate-no-op' : 'authority-issued';
  }
  return issueOutcome === 'duplicate-no-op' ? 'authority-duplicate-no-op' : 'authority-published';
}

function countInProgress(curation) {
  const profile = curation.queueEvidence.proposal.brief.evidence.profile;
  const inProgressLabel = profile.labels.inProgress ?? null;
  const leased = new Set(curation.queueEvidence.ownership.activeLeases
    .filter((lease) => lease.kind === 'implementation')
    .map((lease) => lease.issueNumber));
  if (inProgressLabel) {
    for (const issue of curation.queueEvidence.issues) {
      if (issue.state === 'open' && issue.labels.includes(inProgressLabel)) leased.add(issue.number);
    }
  }
  return leased.size;
}

function buildMilestoneSummary(curation) {
  const proposal = curation.queueEvidence.proposal;
  return proposal.milestones.slice(0, 20).map((milestone) => {
    const records = curation.records.filter((record) => record.milestoneId === milestone.id);
    return {
      id: milestone.id,
      title: milestone.title,
      total: records.length,
      completed: records.filter((record) => record.readiness === 'completed').length,
      blocked: records.filter((record) => record.readiness === 'blocked').length,
    };
  });
}

const LIFECYCLE_BY_OUTCOME = Object.freeze({
  'execution-required': 'awaiting-execution',
  'assurance-required': 'planning',
  'delayed-retry': 'planning',
  blocked: 'blocked',
  'owner-attention': 'owner-attention',
  quiescent: 'quiescent',
  'no-op': 'quiescent',
});

const NEXT_ACTION_BY_OUTCOME = Object.freeze({
  'execution-required': 'execution-reconcile',
  'assurance-required': 'queue-assurance',
  'delayed-retry': 'delayed-retry',
  blocked: 'none',
  'owner-attention': 'owner-decision',
  quiescent: 'none',
  'no-op': 'none',
});

function buildProjection({ curation, outcome, event, controlMode, successors, recentDecisions, now }) {
  const profile = curation.queueEvidence.proposal.brief.evidence.profile;
  const primarySuccessor = successors.find((successor) => successor.eventType !== 'queue-assurance-required') ?? successors[0] ?? null;
  return buildManagementStatusProjection({
    projectId: curation.projectId,
    repository: curation.repository.full,
    objective: profile.objective,
    planRevision: curation.curationRevision,
    milestones: buildMilestoneSummary(curation),
    counts: {
      ready: curation.outcome.readyCount,
      // This project's own in-progress records only. The global slot may be
      // occupied by a different registered project, and reporting that here
      // would misattribute another project's work to this one.
      inProgress: countInProgress(curation),
      blocked: curation.outcome.blockedCount,
      review: curation.queueEvidence.ownership.openPullRequests.length,
      completed: curation.outcome.completedCount,
    },
    criticalPath: curation.records
      .filter((record) => record.readiness === 'ready' || record.readiness === 'blocked')
      .slice(0, 20)
      .map((record) => ({ curationKey: record.curationKey, issueNumber: record.issueNumber, readiness: record.readiness })),
    currentEvent: { eventId: event.eventId, eventType: event.eventType, state: 'claimed' },
    lifecycleState: LIFECYCLE_BY_OUTCOME[outcome] ?? 'idle',
    recentDecisions,
    risks: curation.queueEvidence.proposal.brief.risks.slice(0, 10),
    blockers: curation.queueEvidence.proposal.brief.blockers.slice(0, 10),
    nextAction: {
      classification: NEXT_ACTION_BY_OUTCOME[outcome] ?? 'none',
      eventType: primarySuccessor ? primarySuccessor.eventType : null,
      notBefore: primarySuccessor?.notBefore ?? null,
    },
    ownerAttentionRequired: outcome === 'owner-attention',
    controlMode,
    updatedAt: now,
  });
}

/**
 * Run one bounded programme reconciliation.
 *
 * Returns a validated role result; it never enqueues, settles or persists. The
 * generic controller owns all durable effects.
 */
export function runProgrammeReconciliation({
  event,
  capabilities,
  now,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  recentDecisions = [],
} = {}) {
  assertResolvedRoleCapabilities(capabilities, { role: 'programme' });
  if (!isPlainObject(event)) fail('event must be an object');
  if (!nonEmptyString(now)) fail('now must be an ISO-8601 timestamp');
  const delayMs = boundedDelay(retryDelayMs);
  const controlMode = capabilities.mode;
  const mutationSuppressed = capabilities.mutationSuppressed;

  // The authoritative re-read. Nothing below this line trusts the event body
  // for anything except identity.
  const collected = validateCollectedEvidence(capabilities.ports.collectEvidence({ event }));
  const { queueEvidence } = collected;
  const slotState = resolveSlotState(collected);
  assertIdentityBinding(event, queueEvidence);

  const curation = curateManagerQueue(queueEvidence);
  const profile = queueEvidence.proposal.brief.evidence.profile;
  const identity = {
    projectId: curation.projectId,
    repository: curation.repository.full,
  };

  const successors = [];
  let outcome;
  let reason;

  // ---- bounded queue mutation, through the accepted #266 boundary only ----
  let mutationStatus = 'none';
  if (curation.operations.length > 0 && profile.mutationAuthority.issueMutation) {
    const transaction = planQueueMutationTransaction(curation, { currentSourceSha: collected.sourceSha });
    if (hasCapability(capabilities, 'applyQueueMutation')) {
      const applied = applyQueueMutationTransaction(transaction, { client: capabilities.ports.applyQueueMutation() });
      mutationStatus = applied.status;
    } else {
      // Shadow: the dry-run transaction is computed and proven plannable, but
      // nothing is applied. This is the comparison evidence shadow mode exists
      // to produce.
      mutationStatus = 'suppressed';
    }
  }

  const escalated = curation.outcome.escalationCount > 0;
  const deferred = curation.outcome.deferredCount > 0;
  const mutationIncomplete = mutationStatus === 'failed' || mutationStatus === 'partially-applied';

  if (escalated) {
    // Genuine product ambiguity. This deliberately emits **no** successor: the
    // curator's own hint would name another programme reconciliation, and a
    // programme event whose only successor is another programme event is a
    // self-loop that no amount of re-reading can resolve. Owner attention is
    // projected instead, and a later material transition re-wakes the graph.
    outcome = 'owner-attention';
    reason = 'owner-decision-outstanding';
  } else if (mutationIncomplete) {
    outcome = 'delayed-retry';
    reason = 'mutation-incomplete';
    successors.push({ eventType: 'programme-reconcile-required', notBefore: delayedFrom(now, delayMs) });
  } else if (slotState === 'occupied') {
    // Work is already in flight globally. Follow it through rather than
    // selecting anything new: the one-global-implementation-slot invariant is
    // never widened here.
    //
    // An execution wake must name the attempt it belongs to, so the owner is
    // attributed from bounded ownership evidence. An unattributed wake would be
    // refused downstream as ambiguous and make no progress, so it is never
    // emitted: the graph waits for the identified evidence instead.
    const owner = attributeSlotOwner(curation, collected);
    if (owner.attributed) {
      outcome = 'execution-required';
      reason = 'implementation-slot-occupied';
      successors.push({
        eventType: 'execution-reconcile-required',
        issueNumber: owner.issueNumber,
        pullRequestNumber: owner.pullRequestNumber,
        sha: owner.headSha,
      });
    } else if (owner.reason === 'owned-by-another-project') {
      // The slot is held elsewhere. This project claims nothing and simply
      // waits for capacity rather than inventing an attempt of its own.
      outcome = 'delayed-retry';
      reason = 'implementation-slot-owned-elsewhere';
      successors.push({ eventType: 'programme-reconcile-required', notBefore: delayedFrom(now, delayMs) });
    } else if (owner.reason === 'ambiguous-owner') {
      // More than one candidate owner is a real discrepancy: hand it to the
      // read-only auditor rather than guessing which attempt is live.
      outcome = 'assurance-required';
      reason = 'implementation-slot-owner-ambiguous';
      successors.push({ eventType: 'queue-assurance-required' });
    } else {
      outcome = 'delayed-retry';
      reason = 'implementation-slot-owner-unattributed';
      successors.push({ eventType: 'programme-reconcile-required', notBefore: delayedFrom(now, delayMs) });
    }
  } else if (slotState === 'ambiguous') {
    // The slot could not be proven free. Issuing an authority here could put a
    // second implementation into a slot that is already held, so this fails
    // closed into a bounded delayed retry instead.
    outcome = 'delayed-retry';
    reason = 'implementation-slot-ambiguous';
    successors.push({ eventType: 'programme-reconcile-required', notBefore: delayedFrom(now, delayMs) });
  } else if (deferred) {
    outcome = 'delayed-retry';
    reason = 'active-ownership-collision';
    successors.push({ eventType: 'programme-reconcile-required', notBefore: delayedFrom(now, delayMs) });
  } else {
    const selection = selectNextWork(curation, validateCandidateRequests(collected.candidateRequests ?? []));
    if (!selection) {
      if (curation.outcome.semanticChange) {
        // The queue moved but nothing is runnable yet. Independent assurance is
        // the right successor: it re-reads the queue on its own evidence and can
        // wake programme reconciliation again if the change was not truthful.
        outcome = 'assurance-required';
        reason = 'queue-changed-no-runnable-work';
        successors.push({ eventType: 'queue-assurance-required' });
      } else {
        // Nothing changed and nothing is runnable. Terminate the chain: a later
        // material transition is what re-wakes the graph.
        outcome = 'quiescent';
        reason = 'no-runnable-work';
      }
    } else {
      const quotaState = collected.quotaAdmission.state;
      if (quotaState !== 'available') {
        // Quota headroom is the only admission signal. Unavailable and
        // ambiguous both fail closed into a bounded delayed retry: there is no
        // credit, balance, dollar-cap or paid-fallback path to fall back to.
        outcome = 'delayed-retry';
        reason = quotaState === 'ambiguous' ? 'quota-ambiguous' : 'quota-unavailable';
        successors.push({ eventType: 'programme-reconcile-required', notBefore: delayedFrom(now, delayMs) });
      } else if (!profile.mutationAuthority.authorityIssuance) {
        outcome = 'blocked';
        reason = 'authority-issuance-not-permitted';
      } else {
        // #267 re-enforces readiness, protection, ownership, the global slot
        // invariant, quota-only admission and duplicate-ledger reconciliation.
        const issued = issueManagerWorkerAuthority({
          curation,
          execution: collected.execution,
          request: selection.request,
          currentSourceSha: collected.sourceSha,
          producer: collected.producer,
          quotaAdmission: collected.quotaAdmission,
          ledger: collected.authorityLedger ?? { issued: [] },
        });
        identity.issueNumber = issued.authority.issueNumber;
        identity.sha = issued.authority.baseSha;

        let publication = null;
        if (hasCapability(capabilities, 'publishWorkerAuthority')) {
          // Publication only. This role never consumes the authority it mints:
          // consumption belongs to the worker domain and is not a capability
          // any management role can hold.
          publication = capabilities.ports.publishWorkerAuthority({ authority: issued.authority });
        }

        // An authority the worker cannot actually read is not an issued
        // authority. Reporting `execution-required` on an unresolved or
        // conflicting publication would strand the issue: the ledger would own
        // it, no consumable packet would exist, and the graph would believe the
        // work had been handed over.
        const state = publicationState(publication, capabilities);
        if (state === 'conflict') {
          outcome = 'owner-attention';
          reason = 'authority-publication-conflict';
          // Deliberately no successor: a conflicting immutable packet is never
          // overwritten, so only an owner can resolve it.
        } else if (state === 'pending') {
          outcome = 'delayed-retry';
          reason = 'authority-publication-pending';
          // Ownership and the publication intent are both retained, so recovery
          // retries the publication rather than re-issuing the authority.
          successors.push({ eventType: 'programme-reconcile-required', notBefore: delayedFrom(now, delayMs) });
        } else {
          outcome = 'execution-required';
          reason = publicationReason(issued.outcome, state);
          successors.push({ eventType: 'execution-reconcile-required', issueNumber: issued.authority.issueNumber, sha: issued.authority.baseSha });
        }
      }
    }
  }

  // A material queue change is independently audited by the read-only assurance
  // role. Assurance can never mutate, so this can never become a second
  // mutating authority.
  if (curation.outcome.semanticChange && mutationStatus !== 'suppressed' && outcome !== 'owner-attention' && outcome !== 'assurance-required') {
    successors.push({ eventType: 'queue-assurance-required' });
  }

  const projection = buildProjection({
    curation,
    outcome,
    event,
    controlMode,
    successors,
    recentDecisions,
    now,
  });

  return buildManagementRoleResult({
    role: 'programme',
    outcome,
    reason,
    settlementState: outcome === 'blocked' ? 'blocked' : 'settled',
    mutationSuppressed,
    identity,
    successors,
    projection,
  });
}
