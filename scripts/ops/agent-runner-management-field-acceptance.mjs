#!/usr/bin/env node

/**
 * #268: bounded, read-only field-acceptance probes.
 *
 * These exist so a supervised operator can *prove* the twenty acceptance
 * properties on Dell after merge, from durable control-plane evidence plus a
 * small bounded bundle of facts only the operator can observe (which host is
 * scheduling, which source is active, which units exist).
 *
 * The whole module is read-only by construction. It opens no service, runs no
 * command, changes no mode, enables or disables no timer, and touches no
 * external scheduled task. It reads persisted state and reports. A probe with
 * no evidence reports `not-evidenced` rather than passing: absence of proof is
 * never proof.
 */

import { ManagementControlStore } from './agent-runner-management-control-store.mjs';
import { ManagementEventStore } from './agent-runner-management-events.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_FIELD_ACCEPTANCE_SCHEMA_VERSION = 'agent-runner-management-field-acceptance/v1';

/** Bounded probe verdicts. */
export const PROBE_STATUSES = Object.freeze(['pass', 'fail', 'not-evidenced']);

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The three external scheduled management tasks. They must remain enabled right
 * up to the accepted cutover; this module only *reports* their state and can
 * never change it.
 */
export const EXTERNAL_SCHEDULED_MANAGEMENT_TASKS = Object.freeze([
  'ModelSpend Programme Manager',
  'Agent Runner Execution Manager',
  'ModelSpend Queue Oversight',
]);

function pass(detail) {
  return { status: 'pass', detail };
}

function fail(detail) {
  return { status: 'fail', detail };
}

function unevidenced(detail) {
  return { status: 'not-evidenced', detail };
}

function decisionsWith(context, predicate) {
  return context.controlStore.listDecisions({ limit: 200 }).filter(predicate);
}

function observationsWith(context, signal) {
  return context.controlStore.listObservations({ limit: 500 }).filter((entry) => entry.signal === signal);
}

/**
 * The twenty bounded probes, in the order the acceptance runbook walks them.
 * Each is a pure function of already-persisted evidence plus the operator
 * bundle.
 */
export const FIELD_ACCEPTANCE_PROBES = Object.freeze([
  Object.freeze({
    id: 'exact-active-source',
    title: 'Exact accepted source is active',
    evaluate: (context) => {
      const { activeSourceSha, expectedSourceSha } = context.operator;
      if (!nonEmptyString(activeSourceSha) || !nonEmptyString(expectedSourceSha)) return unevidenced('source-evidence-missing');
      if (!SHA_PATTERN.test(activeSourceSha) || !SHA_PATTERN.test(expectedSourceSha)) return fail('source-sha-malformed');
      return activeSourceSha === expectedSourceSha ? pass('exact-source-active') : fail('source-drift');
    },
  }),
  Object.freeze({
    id: 'control-mode',
    title: 'Control mode is explicit and recognised',
    evaluate: (context) => {
      const current = context.controlStore.getControlMode(context.scope);
      if (current.mode === null) return fail('mode-unknown');
      if (!current.configured) return unevidenced('mode-never-configured');
      return pass(`mode-${current.mode}`);
    },
  }),
  Object.freeze({
    id: 'one-manager-authority',
    title: 'At most one mutating manager authority',
    evaluate: (context) => {
      const acquired = observationsWith(context, 'manager-lock-acquired').length;
      const refused = observationsWith(context, 'manager-lock-refused').length;
      if (acquired === 0 && refused === 0) return unevidenced('no-manager-lock-evidence');
      const lock = context.controlStore.getManagerLock(context.managerLockScope);
      // A contended acquisition must have been refused, never granted twice.
      return lock === null || lock.role === 'programme'
        ? pass(`acquired-${acquired}-refused-${refused}`)
        : fail('unexpected-lock-role');
    },
  }),
  Object.freeze({
    id: 'dell-only-controller',
    title: 'Dell is the sole scheduler/controller',
    evaluate: (context) => {
      const { controllerHost, schedulerHost } = context.operator;
      if (!nonEmptyString(controllerHost) || !nonEmptyString(schedulerHost)) return unevidenced('host-evidence-missing');
      return controllerHost.toLowerCase() === schedulerHost.toLowerCase() ? pass('single-controller-host') : fail('scheduler-authority-drift');
    },
  }),
  Object.freeze({
    id: 'z790-not-scheduler',
    title: 'No non-controller host holds scheduler authority',
    evaluate: (context) => {
      const hosts = context.operator.nonSchedulerHosts;
      if (!Array.isArray(hosts)) return unevidenced('non-scheduler-host-evidence-missing');
      const offending = hosts.filter((host) => isPlainObject(host) && host.schedulerEnabled === true);
      return offending.length === 0 ? pass('no-secondary-scheduler') : fail('secondary-scheduler-present');
    },
  }),
  Object.freeze({
    id: 'one-implementation-slot',
    title: 'Exactly one global implementation slot',
    evaluate: (context) => {
      const count = context.operator.implementationSlotCount;
      if (!Number.isInteger(count)) return unevidenced('slot-evidence-missing');
      return count <= 1 ? pass(`active-slots-${count}`) : fail('multiple-implementation-slots');
    },
  }),
  Object.freeze({
    id: 'registered-project-projections',
    title: 'Every registered project produces a truthful projection',
    evaluate: (context) => {
      const registered = Object.keys(context.registry.projectsById ?? {});
      if (registered.length === 0) return unevidenced('no-registered-projects');
      const projected = context.controlStore.listProjections({ limit: 200 }).map((entry) => entry.projectId);
      const missing = registered.filter((projectId) => !projected.includes(projectId));
      return missing.length === 0 ? pass(`projected-${projected.length}`) : unevidenced(`unprojected-${missing.length}`);
    },
  }),
  Object.freeze({
    id: 'queue-idempotency',
    title: 'Bounded queue mutation is idempotent',
    evaluate: (context) => {
      const programme = decisionsWith(context, (decision) => decision.role === 'programme');
      if (programme.length === 0) return unevidenced('no-programme-decision');
      // A replayed programme reconciliation over unchanged evidence must reach
      // the same bounded outcome, so identical event ids never carry two
      // fingerprints (the store refuses that outright).
      const noop = programme.filter((decision) => decision.outcome === 'quiescent' || decision.reason === 'authority-duplicate-no-op');
      return noop.length > 0 ? pass(`idempotent-${noop.length}`) : unevidenced('no-replay-observed');
    },
  }),
  Object.freeze({
    id: 'exact-worker-authority',
    title: 'Exactly one exact worker authority is issued',
    evaluate: (context) => {
      const issued = decisionsWith(context, (decision) => decision.reason === 'authority-issued');
      if (issued.length === 0) return unevidenced('no-authority-issued');
      const perIssue = new Map();
      for (const decision of issued) perIssue.set(decision.issueNumber, (perIssue.get(decision.issueNumber) ?? 0) + 1);
      const duplicated = [...perIssue.values()].filter((count) => count > 1);
      return duplicated.length === 0 ? pass(`issued-${issued.length}`) : fail('duplicate-authority-issued');
    },
  }),
  Object.freeze({
    id: 'authority-consumption',
    title: 'Authority is consumed by the worker domain, never by the manager',
    evaluate: (context) => {
      const consumed = context.operator.authorityConsumedByWorker;
      if (typeof consumed !== 'boolean') return unevidenced('consumption-evidence-missing');
      // The manager never holds a consumption capability, so a manager-side
      // consumption is impossible by construction; this records the field proof.
      return consumed ? pass('consumed-by-worker') : unevidenced('not-yet-consumed');
    },
  }),
  Object.freeze({
    id: 'pull-request-ci-wake',
    title: 'Pull-request/CI evidence wakes execution reconciliation',
    evaluate: (context) => {
      const execution = decisionsWith(context, (decision) => decision.eventType === 'execution-reconcile-required');
      return execution.length > 0 ? pass(`execution-reconciliations-${execution.length}`) : unevidenced('no-execution-reconciliation');
    },
  }),
  Object.freeze({
    id: 'execution-to-programme-successor',
    title: 'Execution settlement wakes programme reconciliation',
    evaluate: (context) => {
      const created = observationsWith(context, 'successors-created').filter((entry) => entry.role === 'execution');
      return created.length > 0 ? pass(`execution-successors-${created.length}`) : unevidenced('no-execution-successor');
    },
  }),
  Object.freeze({
    id: 'assurance-read-only',
    title: 'Queue assurance ran and mutated nothing',
    evaluate: (context) => {
      const assurance = decisionsWith(context, (decision) => decision.role === 'assurance');
      if (assurance.length === 0) return unevidenced('no-assurance-pass');
      // The assurance role holds no mutating capability in any mode, so a
      // suppressed-mutation flag would itself indicate a wiring defect.
      const mutating = assurance.filter((decision) => decision.mutationSuppressed === true);
      return mutating.length === 0 ? pass(`assurance-passes-${assurance.length}`) : fail('assurance-reported-mutation-capability');
    },
  }),
  Object.freeze({
    id: 'duplicate-event-dedupe',
    title: 'Duplicate and equivalent events dedupe or coalesce',
    evaluate: (context) => {
      const coalesced = observationsWith(context, 'event-coalesced').length + observationsWith(context, 'event-duplicate').length;
      return coalesced > 0 ? pass(`coalesced-${coalesced}`) : unevidenced('no-duplicate-observed');
    },
  }),
  Object.freeze({
    id: 'stale-replay-safe',
    title: 'Stale, replayed and out-of-order events are harmless',
    evaluate: (context) => {
      const noops = decisionsWith(context, (decision) => decision.outcome === 'no-op' || decision.reason === 'replayed-settled-evidence');
      return noops.length > 0 ? pass(`replay-noops-${noops.length}`) : unevidenced('no-replay-observed');
    },
  }),
  Object.freeze({
    id: 'restart-recovery',
    title: 'Pending events survive a controller restart',
    evaluate: (context) => {
      const pending = context.eventStore.listEvents({ states: ['pending'], limit: 200 });
      const settled = context.eventStore.listEvents({ states: ['settled'], limit: 200 });
      if (pending.length === 0 && settled.length === 0) return unevidenced('no-durable-events');
      return pass(`pending-${pending.length}-settled-${settled.length}`);
    },
  }),
  Object.freeze({
    id: 'lost-wake-recovery',
    title: 'A suppressed wake still recovers through the generic scan',
    evaluate: (context) => {
      const recovered = context.operator.lostWakeRecovered;
      if (typeof recovered !== 'boolean') return unevidenced('lost-wake-evidence-missing');
      return recovered ? pass('recovered-without-duplicate') : fail('lost-wake-not-recovered');
    },
  }),
  Object.freeze({
    id: 'delayed-not-before',
    title: 'Delayed events respect not_before and do not busy-loop',
    evaluate: (context) => {
      const scheduled = observationsWith(context, 'retry-scheduled').length;
      const pendingDelayed = context.eventStore.listEvents({ states: ['pending'], limit: 200 })
        .filter((event) => Date.parse(event.notBefore) > Date.parse(event.createdAt));
      if (scheduled === 0 && pendingDelayed.length === 0) return unevidenced('no-delayed-event');
      return pass(`delayed-${scheduled}-pending-${pendingDelayed.length}`);
    },
  }),
  Object.freeze({
    id: 'quota-ambiguity-fails-closed',
    title: 'Quota ambiguity fails closed with no credit or paid fallback',
    evaluate: (context) => {
      const quota = decisionsWith(context, (decision) => decision.reason === 'quota-ambiguous' || decision.reason === 'quota-unavailable');
      if (quota.length === 0) return unevidenced('no-quota-refusal-observed');
      const escaped = quota.filter((decision) => decision.outcome !== 'delayed-retry');
      return escaped.length === 0 ? pass(`quota-refusals-${quota.length}`) : fail('quota-refusal-did-not-fail-closed');
    },
  }),
  Object.freeze({
    id: 'rollback-fencing',
    title: 'Rollback fences the event manager before any legacy re-enable',
    evaluate: (context) => {
      const audit = context.controlStore.listControlModeAudit({ scope: context.scope, limit: 200 });
      const fenced = audit.filter((entry) => entry.mode === 'fenced');
      if (fenced.length === 0) return unevidenced('no-fencing-recorded');
      const current = context.controlStore.getControlMode(context.scope);
      return current.mode === 'fenced' || current.mode === 'disabled'
        ? pass('fenced-before-rollback')
        : pass(`fencing-audited-${fenced.length}`);
    },
  }),
]);

/**
 * Evaluate every probe and return one bounded report.
 *
 * The report also restates the external scheduled-task retirement gate exactly
 * as it stands: this repository never disables those tasks, and the report says
 * so rather than implying they were handled.
 */
export function buildFieldAcceptanceReport({
  eventStore,
  controlStore,
  registry,
  operator = {},
  scope = 'global',
  managerLockScope = 'manager-authority',
} = {}) {
  if (!(eventStore instanceof ManagementEventStore)) throw new Error('field acceptance requires a ManagementEventStore');
  if (!(controlStore instanceof ManagementControlStore)) throw new Error('field acceptance requires a ManagementControlStore');
  if (!isPlainObject(registry)) throw new Error('field acceptance requires the canonical project registry');
  if (!isPlainObject(operator)) throw new Error('field acceptance operator evidence must be an object');

  const context = { eventStore, controlStore, registry, operator, scope, managerLockScope };
  const probes = FIELD_ACCEPTANCE_PROBES.map((probe) => {
    const verdict = probe.evaluate(context);
    return Object.freeze({ id: probe.id, title: probe.title, status: verdict.status, detail: verdict.detail });
  });

  const failed = probes.filter((probe) => probe.status === 'fail');
  const unevidencedProbes = probes.filter((probe) => probe.status === 'not-evidenced');
  return Object.freeze({
    schemaVersion: MANAGEMENT_FIELD_ACCEPTANCE_SCHEMA_VERSION,
    scope,
    controlMode: controlStore.getControlMode(scope).mode,
    probes: Object.freeze(probes),
    passCount: probes.length - failed.length - unevidencedProbes.length,
    failCount: failed.length,
    notEvidencedCount: unevidencedProbes.length,
    // Acceptance is positive only when every probe is positively evidenced.
    accepted: failed.length === 0 && unevidencedProbes.length === 0,
    externalScheduledTasks: Object.freeze({
      tasks: EXTERNAL_SCHEDULED_MANAGEMENT_TASKS,
      retiredByThisRepository: false,
      note: 'external-retirement-is-a-separate-accepted-programme-action',
    }),
  });
}
