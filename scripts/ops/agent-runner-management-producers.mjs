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
 *  2. **Unchanged evidence produces nothing, and the suppression is durable and
 *     producer-owned.** Every transition carries an `evidenceFingerprint`. The
 *     last fingerprint that was successfully turned into a durable event is
 *     persisted per bounded producer scope in the existing controller database,
 *     so suppression does not depend on a caller remembering what it last saw,
 *     does not lapse when the previous event settles, and cannot be defeated by
 *     correlating the same observation differently. Cosmetic GitHub updates,
 *     repeated polls, unchanged queue evidence and repeated status reads
 *     therefore cannot generate events.
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
  normalizeManagementEvent,
  recoverDueManagementEvents,
} from './agent-runner-management-events.mjs';
import { ManagementControlStore } from './agent-runner-management-control-store.mjs';
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
  'correlationId', 'evidenceFingerprint', 'notBefore', 'deadlineAt',
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
  return eventType;
}

function callWake(wake, payload) {
  if (typeof wake !== 'function') return Object.freeze({ attempted: false, ok: true });
  try {
    wake(Object.freeze(payload));
    return Object.freeze({ attempted: true, ok: true });
  } catch {
    // Best effort by definition: the event is already durable, so a failed wake
    // degrades to recovery latency rather than lost work.
    return Object.freeze({ attempted: true, ok: false });
  }
}

/**
 * Turn a bounded set of material transitions into durable management events.
 *
 * Each transition is processed under the ledger's own single transaction, in
 * which the event is enqueued **and** the producer's semantic fingerprint is
 * advanced. That ordering is the whole point:
 *
 *  - the fingerprint is never marked accepted before its event is durably
 *    stored, because both writes commit together or not at all;
 *  - a failed enqueue rolls the fingerprint back, so a transient failure can
 *    never permanently suppress required work;
 *  - a crash between the two is impossible rather than merely unlikely.
 *
 * Durability always completes before the best-effort wake.
 */
export function produceManagementEvents({
  eventStore, controlStore, transitions = [], wake = null, now = null,
} = {}) {
  if (!(eventStore instanceof ManagementEventStore)) fail('a ManagementEventStore is required');
  if (!(controlStore instanceof ManagementControlStore)) fail('a ManagementControlStore is required');
  // The shared connection is what makes the two writes one transaction. Without
  // it the fingerprint and the event could diverge, so this fails closed rather
  // than silently degrading to a weaker guarantee.
  if (controlStore.db !== eventStore.db) {
    fail('the management event store and control store must share one connection for durable producer dedupe (use openManagementStores)');
  }
  if (!Array.isArray(transitions)) fail('transitions must be an array');
  if (transitions.length > MAX_TRANSITIONS) fail(`transitions exceed the bounded limit of ${MAX_TRANSITIONS}`);

  const timestamp = now ?? eventStore.now();
  const produced = [];
  const suppressed = [];
  const due = [];

  transitions.forEach((transition, index) => {
    const eventType = validateTransition(transition, index);
    const scopeKey = ManagementControlStore.producerScopeKey({
      producerKind: transition.kind,
      projectId: transition.projectId,
      repository: transition.repository,
      issueNumber: transition.issueNumber ?? null,
      pullRequestNumber: transition.pullRequestNumber ?? null,
    });

    const event = normalizeManagementEvent({
      eventType,
      projectId: transition.projectId,
      repository: transition.repository,
      issueNumber: transition.issueNumber ?? undefined,
      pullRequestNumber: transition.pullRequestNumber ?? undefined,
      sha: transition.sha ?? undefined,
      correlationId: transition.correlationId ?? derivedCorrelationId(transition),
      notBefore: transition.notBefore ?? undefined,
      deadlineAt: transition.deadlineAt ?? undefined,
    }, { registry: eventStore.registry, now: timestamp });

    // The durable no-event rule, evaluated **inside** the write transaction.
    //
    // `BEGIN IMMEDIATE` takes the write lock first, so the comparison, the
    // enqueue and the fingerprint advance are one serialized unit. Reading the
    // persisted fingerprint before the transaction would leave a
    // time-of-check/time-of-use window in which two overlapping production
    // processes both saw the old value and both enqueued -- so the read
    // deliberately happens here and nowhere else.
    const result = eventStore.runInTransaction(() => {
      const persisted = controlStore.getProducerState(scopeKey);
      if (persisted && persisted.evidenceFingerprint === transition.evidenceFingerprint) {
        return null;
      }
      const enqueued = eventStore.enqueueInTransaction(event, { now: timestamp });
      // Only reached when the enqueue above succeeded; a throw unwinds both.
      controlStore.advanceProducerStateInTransaction({
        scopeKey,
        producerKind: transition.kind,
        projectId: transition.projectId,
        repository: transition.repository,
        issueNumber: transition.issueNumber ?? null,
        pullRequestNumber: transition.pullRequestNumber ?? null,
        evidenceFingerprint: transition.evidenceFingerprint,
        eventId: enqueued.event.eventId,
        now: timestamp,
      });
      return enqueued;
    });

    if (result === null) {
      suppressed.push(Object.freeze({ kind: transition.kind, reason: 'unchanged-evidence', scopeKey }));
      return;
    }

    produced.push(Object.freeze({
      kind: transition.kind,
      eventType,
      eventId: result.event.eventId,
      scopeKey,
      inserted: result.inserted,
      duplicate: result.duplicate,
      coalesced: result.coalesced,
    }));
    if (result.event.state === 'pending' && Date.parse(result.event.notBefore) <= Date.parse(timestamp)) {
      due.push(result.event.eventId);
    }
  });

  // One wake for the whole batch, after every event is durable.
  const wakeResult = due.length > 0
    ? callWake(wake, { schemaVersion: 1, reason: 'management-event-due', dueCount: due.length })
    : Object.freeze({ attempted: false, ok: true });

  return Object.freeze({
    schemaVersion: MANAGEMENT_PRODUCER_SCHEMA_VERSION,
    produced: Object.freeze(produced),
    suppressed: Object.freeze(suppressed),
    insertedCount: produced.filter((entry) => entry.inserted).length,
    coalescedCount: produced.filter((entry) => entry.coalesced).length,
    duplicateCount: produced.filter((entry) => entry.duplicate).length,
    suppressedCount: suppressed.length,
    dueCount: due.length,
    wake: wakeResult,
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
