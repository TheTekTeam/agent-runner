#!/usr/bin/env node

/**
 * #268 role 2: execution reconciliation -- deterministic lifecycle
 * follow-through for work that has **already** been selected and authorised.
 *
 * It inherits the responsibilities of the external Execution Manager: bind
 * evidence to the exact issued authority, reconcile publication, pull-request
 * identity, exact-head checks and actionable review state, authorise a bounded
 * same-pull-request continuation when one is warranted, and -- crucially --
 * wake programme reconciliation the moment the lifecycle frees the global
 * implementation slot, rather than waiting for an hourly pass.
 *
 * This role selects no new work. It cannot: `publishWorkerAuthority` and
 * `applyQueueMutation` are not capabilities the execution role can be granted,
 * so it is structurally unable to authorise an implementation or curate a
 * queue. It also never merges, closes, deploys, activates source or approves
 * its own review evidence -- none of those are capabilities of any role.
 *
 * Every lifecycle decision is delegated to the accepted #267 transitions
 * (`settleManagerLifecycle`, `authorizeManagerContinuation`), which own the
 * fixed precedence, the same-pull-request rule and the one-global-slot
 * invariant. Nothing about that precedence is re-derived here.
 */

import {
  assertResolvedRoleCapabilities,
  hasCapability,
} from './agent-runner-management-control-mode.mjs';
import { buildManagementRoleResult } from './agent-runner-management-role-result.mjs';
import { reviseManagementStatusProjection } from './agent-runner-management-status-projection.mjs';
import {
  authorizeManagerContinuation,
  settleManagerLifecycle,
} from './agent-runner-manager-lifecycle-settlement.mjs';
import { assertNormalizedSettlementEvidenceShape } from './agent-runner-manager-settlement-evidence.mjs';
import { assertNormalizedWorkerAuthorityShape } from './agent-runner-manager-worker-authority.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_EXECUTION_ROLE_SCHEMA_VERSION = 'agent-runner-management-execution-role/v1';

/** The complete bounded set of execution outcomes, mirroring the #267 lifecycle classes. */
export const EXECUTION_OUTCOMES = Object.freeze([
  'continue-execution',
  'programme-reconcile',
  'assurance-required',
  'delayed-retry',
  'blocked',
  'owner-attention',
  'no-op',
]);

/**
 * The accepted #267 successor hints, translated into the #289 event types this
 * controller enqueues. `delayed-retry` is the only hint that needs a decision
 * here: it becomes a delayed event of this same role, gated by `not_before`.
 */
const SUCCESSOR_EVENT_BY_HINT = Object.freeze({
  none: null,
  'execution-reconcile-required': 'execution-reconcile-required',
  'programme-reconcile-required': 'programme-reconcile-required',
  'queue-assurance-required': 'queue-assurance-required',
  'delayed-retry': 'execution-reconcile-required',
});

/**
 * Lifecycle classes after which the global implementation slot is no longer
 * being progressed by this attempt, so programme reconciliation must be woken
 * promptly to reassess what runs next.
 */
const SLOT_FREEING_CLASSES = Object.freeze(['programme-reconcile', 'blocked', 'owner-attention']);

const PROJECTION_LIFECYCLE_BY_CLASS = Object.freeze({
  'continue-execution': 'implementation-active',
  'programme-reconcile': 'awaiting-execution',
  'assurance-required': 'awaiting-review',
  'delayed-retry': 'awaiting-checks',
  blocked: 'blocked',
  'owner-attention': 'owner-attention',
  'no-op': 'quiescent',
});

const NEXT_ACTION_BY_CLASS = Object.freeze({
  'continue-execution': 'execution-reconcile',
  'programme-reconcile': 'programme-reconcile',
  'assurance-required': 'queue-assurance',
  'delayed-retry': 'delayed-retry',
  blocked: 'programme-reconcile',
  'owner-attention': 'owner-decision',
  'no-op': 'none',
});

const DEFAULT_RETRY_DELAY_MS = 5 * 60_000;
const MIN_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;

const EVIDENCE_FIELDS = new Set([
  'authority', 'settlementEvidence', 'previousSettlement', 'ownership',
  'continuationRequest', 'producer', 'projectionContext',
]);

function fail(message) {
  throw new Error(`Refusing agent runner execution reconciliation: ${message}`);
}

function boundedDelay(value) {
  if (!Number.isInteger(value)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, value));
}

function validateCollectedEvidence(collected) {
  if (!isPlainObject(collected)) fail('collectEvidence must return an object');
  const unknown = Object.keys(collected).filter((key) => !EVIDENCE_FIELDS.has(key));
  if (unknown.length > 0) fail(`collected evidence contains unsupported field(s): ${unknown.sort().join(', ')}`);
  // Provenance checks: both must have been produced by the accepted #267
  // validators, so a hand-built look-alike cannot drive a lifecycle decision.
  assertNormalizedWorkerAuthorityShape(collected.authority);
  assertNormalizedSettlementEvidenceShape(collected.settlementEvidence);
  return collected;
}

/**
 * Bind the wake event to the exact authority the evidence belongs to.
 *
 * The event may only ever narrow to identity it was raised for. A project,
 * repository or issue mismatch is a fail-closed refusal, never a reconciliation
 * of some other attempt.
 */
function assertIdentityBinding(event, authority) {
  if (authority.projectId !== event.projectId) {
    fail(`authority is for project '${authority.projectId}' but the event is for '${event.projectId}'`);
  }
  if (authority.repository.full.toLowerCase() !== String(event.repository).toLowerCase()) {
    fail(`authority is for repository '${authority.repository.full}' but the event is for '${event.repository}'`);
  }
  if (event.issueNumber != null && event.issueNumber !== authority.issueNumber) {
    fail(`authority is for issue #${authority.issueNumber} but the event is for issue #${event.issueNumber}`);
  }
}

function buildProjection({ projectionContext, settlement, event, controlMode, recentDecisions, now, successors }) {
  if (!isPlainObject(projectionContext)) return null;
  const primary = successors[0] ?? null;
  return reviseManagementStatusProjection({
    previous: projectionContext,
    changes: {
      currentEvent: { eventId: event.eventId, eventType: event.eventType, state: 'claimed' },
      lifecycleState: PROJECTION_LIFECYCLE_BY_CLASS[settlement.lifecycleClass] ?? 'idle',
      recentDecisions,
      nextAction: {
        classification: NEXT_ACTION_BY_CLASS[settlement.lifecycleClass] ?? 'none',
        eventType: primary ? primary.eventType : null,
        notBefore: primary?.notBefore ?? null,
      },
      ownerAttentionRequired: settlement.lifecycleClass === 'owner-attention',
      controlMode,
    },
    updatedAt: now,
  });
}

/**
 * Run one bounded execution reconciliation.
 *
 * Returns a validated role result; it never enqueues, settles or persists.
 */
export function runExecutionReconciliation({
  event,
  capabilities,
  now,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  recentDecisions = [],
} = {}) {
  assertResolvedRoleCapabilities(capabilities, { role: 'execution' });
  if (!isPlainObject(event)) fail('event must be an object');
  if (!nonEmptyString(now)) fail('now must be an ISO-8601 timestamp');
  const delayMs = boundedDelay(retryDelayMs);

  // The authoritative re-read. The event says "this attempt's evidence
  // changed"; it never says what the evidence is or what to do about it.
  const collected = validateCollectedEvidence(capabilities.ports.collectEvidence({ event }));
  const { authority, settlementEvidence } = collected;
  assertIdentityBinding(event, authority);

  // #267 owns the fixed precedence. A replayed identical evidence snapshot
  // settles as an explicit no-op rather than repeating the work.
  const settlement = settleManagerLifecycle({
    evidence: settlementEvidence,
    previousSettlement: collected.previousSettlement ?? null,
  });

  const successors = [];
  const successorType = SUCCESSOR_EVENT_BY_HINT[settlement.successorHint] ?? null;
  if (successorType) {
    const delayed = settlement.successorHint === 'delayed-retry';
    successors.push({
      eventType: successorType,
      issueNumber: authority.issueNumber,
      pullRequestNumber: settlementEvidence.pullRequest ? settlementEvidence.pullRequest.number : null,
      sha: settlementEvidence.pullRequest ? settlementEvidence.pullRequest.headSha : null,
      notBefore: delayed ? new Date(Date.parse(now) + delayMs).toISOString() : null,
    });
  }

  // The slot-freed wake. When the lifecycle stops progressing this attempt the
  // programme role must reassess immediately; #267's own successor hint already
  // names programme reconciliation for each of these classes, so this asserts
  // that rather than adding a second competing successor.
  if (SLOT_FREEING_CLASSES.includes(settlement.lifecycleClass) && successorType !== 'programme-reconcile-required') {
    successors.push({ eventType: 'programme-reconcile-required', issueNumber: authority.issueNumber });
  }

  // ---- bounded same-pull-request continuation ----
  let reason = settlement.successorReason;
  if (settlement.lifecycleClass === 'continue-execution') {
    if (hasCapability(capabilities, 'publishContinuationAuthority')) {
      // A separately validated *manager* transition. The worker domain can
      // never mint this: #267 requires a manager-domain producer and refuses a
      // replacement pull request or branch outright.
      const continuation = authorizeManagerContinuation({
        authority,
        settlement,
        producer: collected.producer,
        request: collected.continuationRequest ?? null,
        ownership: collected.ownership ?? null,
      });
      capabilities.ports.publishContinuationAuthority({ continuation });
      reason = 'continuation-authorised';
    } else {
      reason = 'continuation-suppressed';
    }
  }

  const projection = buildProjection({
    projectionContext: collected.projectionContext ?? null,
    settlement,
    event,
    controlMode: capabilities.mode,
    recentDecisions,
    now,
    successors,
  });

  return buildManagementRoleResult({
    role: 'execution',
    outcome: settlement.lifecycleClass,
    reason,
    settlementState: settlement.lifecycleClass === 'blocked' ? 'blocked' : 'settled',
    mutationSuppressed: capabilities.mutationSuppressed,
    identity: {
      projectId: authority.projectId,
      repository: authority.repository.full,
      issueNumber: authority.issueNumber,
      pullRequestNumber: settlementEvidence.pullRequest ? settlementEvidence.pullRequest.number : null,
      sha: settlementEvidence.pullRequest ? settlementEvidence.pullRequest.headSha : null,
    },
    successors,
    projection,
  });
}
