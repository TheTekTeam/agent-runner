#!/usr/bin/env node

/**
 * #268: durable management-event production from material state transitions.
 *
 * This is the boundary between "something really changed in the world" and "the
 * management graph should wake". It exists so that the normal management
 * lifecycle is driven by causality rather than by a clock.
 *
 * Three rules make this safe:
 *
 *  1. **A producer may wake the manager; it may never author a decision.** Every
 *     transition below maps to a typed wake event carrying identity only. There
 *     is no field in which a producer could say what to do -- the handler that
 *     claims the event re-reads authoritative evidence and decides for itself.
 *
 *  2. **Unchanged evidence produces nothing, structurally.** A transition is
 *     accepted only with an `evidenceFingerprint`. If it equals the previous
 *     fingerprint for that transition, no event is produced at all. Cosmetic
 *     GitHub updates, repeated polls, unchanged queue evidence and repeated
 *     status reads therefore cannot generate events -- not because a caller
 *     remembered to pass a flag, but because their semantic fingerprint did not
 *     move.
 *
 *  3. **Production is deterministic, deduplicated, bounded and idempotent.** The
 *     #289 ledger fingerprints and coalesces on the way in, so replaying the
 *     same transition set is a no-op rather than a second wake.
 *
 * The one time-dependent seam -- a delayed event becoming due -- is deliberately
 * *not* a producer. It belongs to the generic recovery scan re-exported at the
 * bottom of this module, because nothing new has happened in the world: an
 * event that already exists has merely become eligible.
 */

import {
  ManagementEventStore,
  enqueueManagementEventAndWake,
  recoverDueManagementEvents,
} from './agent-runner-management-events.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_PRODUCER_SCHEMA_VERSION = 'agent-runner-management-producers/v1';

/**
 * Every material transition that may wake management, and the typed event each
 * one raises. A transition kind not in this table is refused: production is a
 * positive allowlist, never an open door.
 *
 * Transitions that change *what should run next* wake programme reconciliation.
 * Transitions that change *how the already-authorised attempt is progressing*
 * wake execution reconciliation.
 */
export const MANAGEMENT_EVENT_PRODUCERS = Object.freeze({
  // Accepted GitHub event-batch settlement whose semantic evidence moved.
  'github-evidence-settled': 'programme-reconcile-required',
  // A dependency became accepted, closed or otherwise runnable.
  'dependency-readiness-changed': 'programme-reconcile-required',
  // Accepted merge evidence: a programme fact, never an instruction to merge.
  'merge-evidence-accepted': 'programme-reconcile-required',
  // The source-activation controller applied or refused an exact authority.
  'source-activation-settled': 'programme-reconcile-required',
  // The global implementation slot became free: the next dependency-correct
  // work can be chosen immediately rather than at the next hourly pass.
  'implementation-slot-freed': 'programme-reconcile-required',
  // A read-only assurance pass found a correctable discrepancy.
  'assurance-discrepancy': 'programme-reconcile-required',

  // Worker ownership materially changed (claim/start).
  'worker-ownership-changed': 'execution-reconcile-required',
  // The worker reached a terminal result.
  'worker-terminal-result': 'execution-reconcile-required',
  // An implementation attempt published.
  'implementation-published': 'execution-reconcile-required',
  // A pull request was published from an authorised attempt.
  'pull-request-published': 'execution-reconcile-required',
  // The authorised pull request's head moved.
  'pull-request-head-changed': 'execution-reconcile-required',
  // Required exact-head checks reached a terminal state.
  'required-checks-terminal': 'execution-reconcile-required',
  // Review reached an actionable state.
  'review-actionable': 'execution-reconcile-required',
  // The global implementation slot became occupied.
  'implementation-slot-occupied': 'execution-reconcile-required',
});

/** Bounded reasons a transition produced no event. */
export const PRODUCER_SUPPRESSION_REASONS = Object.freeze([
  'unchanged-evidence',
  'cosmetic-change',
]);

const TRANSITION_FIELDS = new Set([
  'kind', 'projectId', 'repository', 'issueNumber', 'pullRequestNumber', 'sha',
  'correlationId', 'evidenceFingerprint', 'previousEvidenceFingerprint', 'notBefore', 'deadlineAt',
]);

const FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TRANSITIONS = 100;

function fail(message) {
  throw new Error(`Refusing agent runner management event production: ${message}`);
}

/**
 * A deterministic correlation identity when the caller does not supply one.
 * Derived only from the transition kind and its evidence fingerprint, so the
 * same material transition always correlates to the same chain.
 */
function derivedCorrelationId(transition) {
  const suffix = transition.evidenceFingerprint.replace(/^sha256:/, '').slice(0, 32);
  return `${transition.kind}-${suffix}`.slice(0, 128);
}

function validateTransition(transition, index) {
  if (!isPlainObject(transition)) fail(`transitions[${index}] must be an object`);
  const unknown = Object.keys(transition).filter((key) => !TRANSITION_FIELDS.has(key));
  if (unknown.length > 0) fail(`transitions[${index}] contains unsupported field(s): ${unknown.sort().join(', ')}`);
  const eventType = MANAGEMENT_EVENT_PRODUCERS[transition.kind];
  if (!eventType) fail(`transitions[${index}] has an unrecognised transition kind: ${String(transition.kind ?? '')}`);
  if (!nonEmptyString(transition.projectId) || !ID_PATTERN.test(transition.projectId)) {
    fail(`transitions[${index}].projectId must be a bounded registered project identifier`);
  }
  if (!nonEmptyString(transition.repository)) fail(`transitions[${index}].repository is required`);
  // The fingerprint is mandatory: without it there is no way to know whether
  // anything actually changed, and a producer that cannot prove change must not
  // be able to wake the manager at all.
  if (!nonEmptyString(transition.evidenceFingerprint) || !FINGERPRINT_PATTERN.test(transition.evidenceFingerprint)) {
    fail(`transitions[${index}].evidenceFingerprint must be a bounded semantic evidence fingerprint`);
  }
  if (transition.previousEvidenceFingerprint != null
    && (!nonEmptyString(transition.previousEvidenceFingerprint) || !FINGERPRINT_PATTERN.test(transition.previousEvidenceFingerprint))) {
    fail(`transitions[${index}].previousEvidenceFingerprint must be a bounded semantic evidence fingerprint when present`);
  }
  return eventType;
}

/**
 * Turn a bounded set of material transitions into durable management events.
 *
 * Durability always completes before the best-effort wake, and every enqueue
 * goes through the #289 ledger so deduplication, coalescing and delayed
 * eligibility are the ledger's, not reimplemented here.
 */
export function produceManagementEvents({ store, transitions = [], wake = null, now = null } = {}) {
  if (!(store instanceof ManagementEventStore)) fail('a ManagementEventStore is required');
  if (!Array.isArray(transitions)) fail('transitions must be an array');
  if (transitions.length > MAX_TRANSITIONS) fail(`transitions exceed the bounded limit of ${MAX_TRANSITIONS}`);

  const produced = [];
  const suppressed = [];
  transitions.forEach((transition, index) => {
    const eventType = validateTransition(transition, index);

    // The structural no-event rule. Identical semantic evidence cannot wake the
    // manager, however many times it is observed.
    if (transition.previousEvidenceFingerprint != null
      && transition.previousEvidenceFingerprint === transition.evidenceFingerprint) {
      suppressed.push(Object.freeze({ kind: transition.kind, reason: 'unchanged-evidence' }));
      return;
    }

    const result = enqueueManagementEventAndWake({
      store,
      wake,
      now,
      event: {
        eventType,
        projectId: transition.projectId,
        repository: transition.repository,
        issueNumber: transition.issueNumber ?? undefined,
        pullRequestNumber: transition.pullRequestNumber ?? undefined,
        sha: transition.sha ?? undefined,
        correlationId: transition.correlationId ?? derivedCorrelationId(transition),
        notBefore: transition.notBefore ?? undefined,
        deadlineAt: transition.deadlineAt ?? undefined,
      },
    });
    produced.push(Object.freeze({
      kind: transition.kind,
      eventType,
      eventId: result.event.eventId,
      inserted: result.inserted,
      duplicate: result.duplicate,
      coalesced: result.coalesced,
    }));
  });

  return Object.freeze({
    schemaVersion: MANAGEMENT_PRODUCER_SCHEMA_VERSION,
    produced: Object.freeze(produced),
    suppressed: Object.freeze(suppressed),
    insertedCount: produced.filter((entry) => entry.inserted).length,
    coalescedCount: produced.filter((entry) => entry.coalesced).length,
    duplicateCount: produced.filter((entry) => entry.duplicate).length,
    suppressedCount: suppressed.length,
  });
}

/**
 * The generic recovery seam.
 *
 * This is the *only* time-driven mechanism in the control plane, and it is
 * deliberately transport/recovery infrastructure with no management business
 * logic: it recovers events due after a restart or a lost wake, expires stale
 * leases, and makes delayed `not_before` events eligible. It decides nothing
 * about which issue runs, which project has priority, what authority to issue,
 * whether a pull request is acceptable, or whether a queue should change --
 * every one of those belongs to a role handler.
 */
export function recoverDueManagementWork({ store, wake = null, now = null, limit = 100 } = {}) {
  if (!(store instanceof ManagementEventStore)) fail('a ManagementEventStore is required');
  return recoverDueManagementEvents({ store, wake, now, limit });
}
