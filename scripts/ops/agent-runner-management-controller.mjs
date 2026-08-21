#!/usr/bin/env node

/**
 * #268: the one generic management event controller.
 *
 * It claims due #289 events, binds each to exactly one registered project,
 * dispatches by allowlisted event type into the correct role capability
 * boundary, persists the bounded outcome, and settles the event together with
 * its successors in the ledger's single atomic transaction before waking again.
 *
 * Deliberate properties:
 *
 *  - **No business logic.** The dispatcher knows event types and roles. It does
 *    not know what a queue is, which issue should run, what a pull request
 *    means, or anything project-specific. Every decision belongs to a role
 *    handler, and every handler is injectable.
 *  - **No scheduler.** There is no timer, interval, sleep or recurrence here.
 *    One call processes the events that are due now and returns. Something
 *    external -- a wake, or the generic recovery scan -- decides when to call it.
 *  - **Persist, then settle, then wake.** Durability always completes before the
 *    best-effort wake, so a lost wake can never lose work: the event is still
 *    durably pending and generic recovery will find it.
 *  - **Fail closed.** An unknown event type, an unregistered project, a
 *    repository mismatch, an unknown control mode or a contended manager
 *    authority all stop the cycle or block the event rather than guessing.
 */

import {
  ROLE_BY_EVENT_TYPE,
  createAssuranceCapabilities,
  resolveManagementControlMode,
  resolveRoleCapabilities,
} from './agent-runner-management-control-mode.mjs';
import { ManagementControlStore } from './agent-runner-management-control-store.mjs';
import { assertManagementRoleResultShape } from './agent-runner-management-role-result.mjs';
import { statusProjectionPayload } from './agent-runner-management-status-projection.mjs';
import { runProgrammeReconciliation } from './agent-runner-management-programme-role.mjs';
import { runExecutionReconciliation } from './agent-runner-management-execution-role.mjs';
import { runQueueAssurance } from './agent-runner-management-assurance-role.mjs';
import { ManagementEventStore } from './agent-runner-management-events.mjs';
import { projectFromRegistryById } from './agent-runner-project-registry.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_CONTROLLER_SCHEMA_VERSION = 'agent-runner-management-controller/v1';

/**
 * The causal-chain bound this controller degrades at.
 *
 * It sits deliberately below the #289 ledger's own hard limit so a long retry
 * chain settles as an explicit, auditable `causal-depth-exhausted` block rather
 * than throwing inside the ledger transaction and leaving the event to churn
 * through lease expiry until it dead-letters.
 */
export const MAX_SUCCESSOR_CAUSAL_DEPTH = 48;

/** The accepted role handlers. Injectable so tests can drive the dispatcher in isolation. */
export const DEFAULT_ROLE_HANDLERS = Object.freeze({
  programme: runProgrammeReconciliation,
  execution: runExecutionReconciliation,
  assurance: runQueueAssurance,
});

const DEFAULT_MAX_EVENTS = 10;
const MAX_MAX_EVENTS = 100;

function boundedMaxEvents(value) {
  if (!Number.isInteger(value) || value < 1) return DEFAULT_MAX_EVENTS;
  return Math.min(MAX_MAX_EVENTS, value);
}

function summary(fields) {
  return Object.freeze({ schemaVersion: MANAGEMENT_CONTROLLER_SCHEMA_VERSION, ...fields });
}

function callWake(wake, payload) {
  if (typeof wake !== 'function') return Object.freeze({ attempted: false, ok: true });
  try {
    wake(Object.freeze(payload));
    return Object.freeze({ attempted: true, ok: true });
  } catch {
    // A wake is best effort by definition: the event is already durable, so a
    // failed wake degrades to recovery latency rather than lost work.
    return Object.freeze({ attempted: true, ok: false });
  }
}

/**
 * Bind one event to exactly one registered project.
 *
 * The #289 ledger already refuses to enqueue an event for an unregistered
 * project, so this is defence in depth against a registry that changed after
 * enqueue -- a project that was deregistered, or whose canonical repository
 * moved, must stop being managed rather than continue against stale identity.
 */
function bindRegisteredProject(registry, event) {
  const project = projectFromRegistryById(registry, event.projectId);
  if (!project || typeof project.githubRepo !== 'string') {
    return { ok: false, reason: 'project-not-registered' };
  }
  if (project.githubRepo.toLowerCase() !== event.repository.toLowerCase()) {
    return { ok: false, reason: 'repository-identity-mismatch' };
  }
  return { ok: true, project };
}

/**
 * Observations are operational evidence, never a correctness dependency. A
 * failure to record one must not turn into a failure to manage, so this is the
 * only place in the controller that deliberately swallows an error.
 */
function recordObservationSafely(controlStore, observation) {
  try {
    controlStore.recordObservation(observation);
  } catch {
    // Intentionally ignored: losing one bounded observation is strictly better
    // than aborting a cycle that has already settled durable state.
  }
}

function recentDecisionsFor(controlStore, projectId) {
  return controlStore.listDecisions({ projectId, limit: 5 }).map((decision) => ({
    eventId: decision.eventId,
    role: decision.role,
    outcome: decision.outcome,
    recordedAt: decision.recordedAt,
  }));
}

/**
 * Process one bounded batch of due management events.
 *
 * Returns a bounded summary. Never throws for an ordinary refusal: a refusal is
 * reported, recorded and returned so a controller process cannot crash-loop.
 */
export async function runManagementControlCycle({
  eventStore,
  controlStore,
  registry,
  scope = 'global',
  mode = null,
  controllerId,
  claimToken,
  handlers = DEFAULT_ROLE_HANDLERS,
  resolvePorts,
  now = () => new Date().toISOString(),
  wake = null,
  maxEvents = DEFAULT_MAX_EVENTS,
  leaseMs,
  managerLockScope = 'manager-authority',
  managerLockLeaseMs,
  retryDelayMs,
} = {}) {
  if (!(eventStore instanceof ManagementEventStore)) throw new Error('management controller requires a ManagementEventStore');
  if (!(controlStore instanceof ManagementControlStore)) throw new Error('management controller requires a ManagementControlStore');
  if (!isPlainObject(registry)) throw new Error('management controller requires the canonical project registry');
  if (!nonEmptyString(controllerId)) throw new Error('management controller requires a bounded controllerId');
  if (!nonEmptyString(claimToken)) throw new Error('management controller requires a claim token');
  if (typeof resolvePorts !== 'function') throw new Error('management controller requires a resolvePorts factory');
  const bound = boundedMaxEvents(maxEvents);
  const timestamp = typeof now === 'function' ? now() : now;

  // ---- control mode: the first and strongest gate ----
  const configured = mode ?? controlStore.getControlMode(scope).mode;
  const resolvedMode = resolveManagementControlMode({ mode: configured });
  controlStore.recordObservation({
    signal: 'control-mode-resolved',
    controlMode: resolvedMode.ok ? resolvedMode.mode : null,
    detail: resolvedMode.ok ? 'resolved' : resolvedMode.reason,
    now: timestamp,
  });
  if (!resolvedMode.ok || !resolvedMode.processing) {
    return summary({
      ran: false,
      mode: resolvedMode.mode,
      refusal: resolvedMode.ok ? `mode-${resolvedMode.mode}` : resolvedMode.reason,
      processed: 0,
      results: Object.freeze([]),
    });
  }

  // ---- one mutating manager authority ----
  // Only a mutating cycle takes the lock. Shadow deliberately does not, because
  // shadow cannot mutate and must never contend with, or fence out, the
  // authority that can.
  let lockHeld = false;
  if (resolvedMode.mutating) {
    const lock = controlStore.acquireManagerLock({
      scope: managerLockScope, holder: controllerId, role: 'programme', leaseMs: managerLockLeaseMs, now: timestamp,
    });
    if (!lock.acquired) {
      controlStore.recordObservation({ signal: 'manager-lock-refused', controlMode: resolvedMode.mode, detail: 'manager-authority-held', now: timestamp });
      return summary({ ran: false, mode: resolvedMode.mode, refusal: 'manager-authority-held', processed: 0, results: Object.freeze([]) });
    }
    lockHeld = true;
    controlStore.recordObservation({ signal: 'manager-lock-acquired', controlMode: resolvedMode.mode, detail: 'acquired', now: timestamp });
  }

  const results = [];
  let immediateSuccessors = 0;
  try {
    for (let processed = 0; processed < bound; processed += 1) {
      const cycleNow = typeof now === 'function' ? now() : now;
      const event = eventStore.claimNext({ claimToken, leaseMs, now: cycleNow });
      if (!event) break;
      controlStore.recordObservation({
        signal: 'event-claimed',
        projectId: event.projectId,
        repository: event.repository,
        eventId: event.eventId,
        eventType: event.eventType,
        controlMode: resolvedMode.mode,
        detail: 'claimed',
        now: cycleNow,
      });
      let outcome;
      try {
        // eslint-disable-next-line no-await-in-loop -- events are processed strictly in order under one claim at a time
        outcome = await processClaimedEvent({
          event,
          eventStore,
          controlStore,
          registry,
          resolvedMode,
          handlers,
          resolvePorts,
          claimToken,
          now: cycleNow,
          retryDelayMs,
        });
      } catch (error) {
        // Backstop: one project's event can never corrupt the cycle for another.
        // The event stays claimed and generic recovery retries it under the
        // ledger's own bounded attempt budget.
        recordObservationSafely(controlStore, {
          signal: 'handler-failed',
          projectId: event.projectId,
          repository: event.repository,
          eventId: event.eventId,
          eventType: event.eventType,
          controlMode: resolvedMode.mode,
          detail: 'cycle-guarded-failure',
          now: cycleNow,
        });
        outcome = Object.freeze({
          eventId: event.eventId,
          eventType: event.eventType,
          role: null,
          outcome: 'cycle-guarded-failure',
          settled: false,
          refused: false,
          failureMessage: error instanceof Error ? error.message : 'event processing failed',
          immediateSuccessors: 0,
        });
      }
      results.push(outcome);
      immediateSuccessors += outcome.immediateSuccessors;
    }
  } finally {
    if (lockHeld) {
      controlStore.releaseManagerLock({ scope: managerLockScope, holder: controllerId });
      controlStore.recordObservation({ signal: 'manager-lock-released', controlMode: resolvedMode.mode, detail: 'released', now: timestamp });
    }
  }

  // Durability has already completed for every event above, so this wake is
  // purely a latency optimisation: it asks the controller to run again promptly
  // because a successor is already due.
  const wakeResult = immediateSuccessors > 0
    ? callWake(wake, { schemaVersion: 1, reason: 'management-successor-due', dueCount: immediateSuccessors })
    : Object.freeze({ attempted: false, ok: true });

  return summary({
    ran: true,
    mode: resolvedMode.mode,
    refusal: null,
    processed: results.length,
    immediateSuccessors,
    wake: wakeResult,
    results: Object.freeze(results),
  });
}

/**
 * Block one claimed event without running a handler. Used for every fail-closed
 * refusal so the event leaves the queue with an auditable reason instead of
 * being retried forever.
 */
function blockEvent({ eventStore, controlStore, event, claimToken, reason, mode, now }) {
  eventStore.settle(event.eventId, { claimToken, state: 'blocked', outcome: reason, successors: [], now });
  controlStore.recordObservation({
    signal: 'handler-refused',
    projectId: event.projectId,
    repository: event.repository,
    eventId: event.eventId,
    eventType: event.eventType,
    controlMode: mode,
    detail: reason,
    now,
  });
  return Object.freeze({ eventId: event.eventId, eventType: event.eventType, role: null, outcome: reason, settled: true, refused: true, immediateSuccessors: 0 });
}

async function processClaimedEvent({
  event, eventStore, controlStore, registry, resolvedMode, handlers, resolvePorts, claimToken, now, retryDelayMs,
}) {
  // ---- allowlisted event type ----
  const role = ROLE_BY_EVENT_TYPE[event.eventType] ?? null;
  if (!role) {
    // `delayed-event-ready` and anything else the ledger accepts but this
    // dispatcher has no role for is refused rather than guessed at.
    return blockEvent({ eventStore, controlStore, event, claimToken, reason: 'unknown-event-type', mode: resolvedMode.mode, now });
  }
  const handler = handlers[role];
  if (typeof handler !== 'function') {
    return blockEvent({ eventStore, controlStore, event, claimToken, reason: 'role-handler-unavailable', mode: resolvedMode.mode, now });
  }

  // ---- exactly one registered project ----
  const binding = bindRegisteredProject(registry, event);
  if (!binding.ok) {
    return blockEvent({ eventStore, controlStore, event, claimToken, reason: binding.reason, mode: resolvedMode.mode, now });
  }

  controlStore.recordObservation({
    signal: 'handler-started',
    projectId: event.projectId,
    repository: event.repository,
    eventId: event.eventId,
    eventType: event.eventType,
    role,
    controlMode: resolvedMode.mode,
    detail: 'started',
    now,
  });

  let result;
  try {
    // Evidence collection is the only asynchronous step. It is awaited here and
    // handed to the handler as an already-resolved port, which keeps every role
    // transition a synchronous, deterministic, replayable function.
    const ports = await resolvePorts({ role, event, mode: resolvedMode.mode, project: binding.project });
    if (!isPlainObject(ports) || typeof ports.collectEvidence !== 'function') {
      throw new Error('resolvePorts must supply a collectEvidence port');
    }
    const collected = await ports.collectEvidence({ event, role });
    const resolvedPorts = { ...ports, collectEvidence: () => collected };
    const capabilities = role === 'assurance'
      ? createAssuranceCapabilities({ mode: resolvedMode.mode, readers: resolvedPorts })
      : resolveRoleCapabilities({ role, mode: resolvedMode.mode, ports: resolvedPorts });

    result = assertManagementRoleResultShape(handler({
      event,
      capabilities,
      now,
      retryDelayMs,
      recentDecisions: recentDecisionsFor(controlStore, event.projectId),
    }));
  } catch (error) {
    // The event stays claimed. Its lease will expire, the generic recovery scan
    // will requeue it, and the ledger's own attempt bound will eventually
    // dead-letter it. That is a bounded retry with no hot loop and no crash.
    controlStore.recordObservation({
      signal: 'handler-failed',
      projectId: event.projectId,
      repository: event.repository,
      eventId: event.eventId,
      eventType: event.eventType,
      role,
      controlMode: resolvedMode.mode,
      detail: 'handler-failed',
      now,
    });
    return Object.freeze({
      eventId: event.eventId,
      eventType: event.eventType,
      role,
      outcome: 'handler-failed',
      settled: false,
      refused: false,
      failureMessage: error instanceof Error ? error.message : 'handler failed',
      immediateSuccessors: 0,
    });
  }

  // ---- bounded causal depth ----
  let successors = result.successors;
  let settlementState = result.settlementState;
  let outcome = result.outcome;
  if (successors.length > 0 && event.causalDepth >= MAX_SUCCESSOR_CAUSAL_DEPTH) {
    successors = [];
    settlementState = 'blocked';
    outcome = 'causal-depth-exhausted';
  }

  // ---- atomic settlement plus successors ----
  //
  // The ledger's settlement is *the* control transaction: it persists the
  // bounded result (state and outcome) and enqueues every successor in one
  // atomic write. It therefore runs before the derived operator evidence below.
  //
  // The ordering matters for a specific failure mode. Writing the derived
  // decision row first would, if settlement then failed, leave an orphaned
  // decision behind; the retry after lease expiry would recompute a decision
  // from newer evidence, collide with that row's contradiction guard, and the
  // event would fail every attempt until it dead-lettered. Settling first means
  // a failed evidence write costs one audit row, never a poisoned event.
  let settlement;
  try {
    settlement = eventStore.settle(event.eventId, {
      claimToken,
      state: settlementState,
      outcome,
      successors: successors.map((successor) => ({
        eventType: successor.eventType,
        issueNumber: successor.issueNumber ?? undefined,
        pullRequestNumber: successor.pullRequestNumber ?? undefined,
        sha: successor.sha ?? undefined,
        notBefore: successor.notBefore ?? undefined,
        correlationId: successor.correlationId ?? undefined,
      })),
      now,
    });
  } catch (error) {
    // The event remains claimed and recovery will retry it. One event that
    // cannot settle must never abort the cycle for other projects.
    recordObservationSafely(controlStore, {
      signal: 'handler-failed',
      projectId: event.projectId,
      repository: event.repository,
      eventId: event.eventId,
      eventType: event.eventType,
      role,
      controlMode: resolvedMode.mode,
      detail: 'settlement-failed',
      now,
    });
    return Object.freeze({
      eventId: event.eventId,
      eventType: event.eventType,
      role,
      outcome: 'settlement-failed',
      settled: false,
      refused: false,
      failureMessage: error instanceof Error ? error.message : 'settlement failed',
      immediateSuccessors: 0,
    });
  }

  // ---- derived operator evidence ----
  controlStore.recordDecision({
    eventId: event.eventId,
    projectId: result.identity.projectId,
    repository: result.identity.repository,
    role: result.role,
    eventType: event.eventType,
    controlMode: resolvedMode.mode,
    outcome,
    reason: result.reason,
    mutationSuppressed: result.mutationSuppressed,
    issueNumber: result.identity.issueNumber,
    pullRequestNumber: result.identity.pullRequestNumber,
    sha: result.identity.sha,
    correlationId: event.correlationId,
    successorCount: successors.length,
  }, { now });

  for (const finding of result.findings) {
    controlStore.recordFinding({
      eventId: event.eventId,
      projectId: result.identity.projectId,
      repository: result.identity.repository,
      findingClass: finding.findingClass,
      severity: finding.severity,
      issueNumber: finding.issueNumber,
      pullRequestNumber: finding.pullRequestNumber,
      sha: finding.sha,
      correlationId: event.correlationId,
    }, { now });
    controlStore.recordObservation({
      signal: 'assurance-finding',
      projectId: result.identity.projectId,
      repository: result.identity.repository,
      eventId: event.eventId,
      eventType: event.eventType,
      role,
      controlMode: resolvedMode.mode,
      detail: finding.findingClass,
      now,
    });
  }

  if (result.projection) {
    const recorded = controlStore.recordProjection({
      projectId: result.projection.projectId,
      repository: result.projection.repository,
      fingerprint: result.projection.projectionFingerprint,
      payload: statusProjectionPayload(result.projection),
      now,
    });
    controlStore.recordObservation({
      signal: recorded.changed ? 'projection-revised' : 'projection-unchanged',
      projectId: result.projection.projectId,
      repository: result.projection.repository,
      eventId: event.eventId,
      role,
      controlMode: resolvedMode.mode,
      detail: recorded.changed ? `revision-${recorded.revision}` : 'unchanged',
      now,
    });
  }

  const created = settlement.successors.filter((entry) => entry.inserted);
  const coalesced = settlement.successors.filter((entry) => entry.coalesced || entry.duplicate);
  for (const entry of coalesced) {
    controlStore.recordObservation({
      signal: entry.duplicate ? 'event-duplicate' : 'event-coalesced',
      projectId: event.projectId,
      repository: event.repository,
      eventId: entry.event.eventId,
      eventType: entry.event.eventType,
      role,
      controlMode: resolvedMode.mode,
      detail: 'coalesced',
      now,
    });
  }
  if (created.length > 0) {
    controlStore.recordObservation({
      signal: 'successors-created',
      projectId: event.projectId,
      repository: event.repository,
      eventId: event.eventId,
      eventType: event.eventType,
      role,
      controlMode: resolvedMode.mode,
      detail: `count-${created.length}`,
      now,
    });
  }
  const delayed = created.filter((entry) => Date.parse(entry.event.notBefore) > Date.parse(now));
  if (delayed.length > 0) {
    controlStore.recordObservation({
      signal: 'retry-scheduled',
      projectId: event.projectId,
      repository: event.repository,
      eventId: delayed[0].event.eventId,
      eventType: delayed[0].event.eventType,
      role,
      controlMode: resolvedMode.mode,
      detail: 'delayed',
      now,
    });
  }

  controlStore.recordObservation({
    signal: 'handler-outcome',
    projectId: result.identity.projectId,
    repository: result.identity.repository,
    eventId: event.eventId,
    eventType: event.eventType,
    role,
    controlMode: resolvedMode.mode,
    detail: outcome,
    now,
  });

  return Object.freeze({
    eventId: event.eventId,
    eventType: event.eventType,
    role,
    outcome,
    reason: result.reason,
    settled: true,
    refused: false,
    settlementState,
    mutationSuppressed: result.mutationSuppressed,
    successorEventIds: Object.freeze(created.map((entry) => entry.event.eventId)),
    coalescedSuccessors: coalesced.length,
    immediateSuccessors: created.length - delayed.length,
  });
}
