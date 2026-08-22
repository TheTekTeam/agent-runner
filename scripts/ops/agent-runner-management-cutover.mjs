#!/usr/bin/env node

/**
 * #268: cutover-readiness and rollback tooling.
 *
 * This module makes the eventual cutover *mechanically auditable*. It does not
 * perform it.
 *
 * Two hard boundaries are encoded here and enforced by the shapes below:
 *
 *  1. **This repository never retires the external scheduled management tasks.**
 *     `ModelSpend Programme Manager`, `Agent Runner Execution Manager` and
 *     `ModelSpend Queue Oversight` live outside this repository. The readiness
 *     report states the gate and reports it as outstanding; it never claims the
 *     tasks were disabled, and there is no code path here that could disable
 *     one.
 *
 *  2. **Rollback fences before anything else.** The ordered rollback plan always
 *     puts "fence the event manager" before any step that could re-enable the
 *     previous management authority, because two mutating authorities at once
 *     is the one outcome rollback must never produce. The fencing step is the
 *     only step this repository can execute; every later step is explicitly
 *     marked as an external operator action.
 */

import { isPlainObject } from './agent-runner-manager-planner-safety.mjs';
import { EXTERNAL_SCHEDULED_MANAGEMENT_TASKS } from './agent-runner-management-field-acceptance.mjs';

export const MANAGEMENT_CUTOVER_SCHEMA_VERSION = 'agent-runner-management-cutover/v1';

/**
 * Every gate the programme/operator must satisfy before the external scheduled
 * management tasks may be disabled. Each names who can evidence it: the
 * repository itself, or a supervised operator on Dell.
 */
export const CUTOVER_GATES = Object.freeze([
  Object.freeze({ id: 'implementation-merged', owner: 'programme', description: 'The #268 implementation is merged.' }),
  Object.freeze({ id: 'exact-head-ci-green', owner: 'programme', description: 'Exact-head GitHub Actions are green for the merged commit.' }),
  Object.freeze({ id: 'accepted-source-active', owner: 'operator', description: 'The accepted source is active on Dell, clean and quiescent.' }),
  Object.freeze({ id: 'shadow-mode-positive', owner: 'operator', description: 'Shadow-mode comparison against current management behaviour is positive.' }),
  Object.freeze({ id: 'agent-runner-acceptance-positive', owner: 'operator', description: 'Agent Runner project field acceptance is positive.' }),
  Object.freeze({ id: 'second-project-acceptance-positive', owner: 'operator', description: 'A second registered project shape passes acceptance.' }),
  Object.freeze({ id: 'causal-chain-proven', owner: 'operator', description: 'One real causal chain advanced without a management timer.' }),
  Object.freeze({ id: 'assurance-read-only-proven', owner: 'operator', description: 'Queue assurance ran and mutated nothing.' }),
  Object.freeze({ id: 'lost-wake-recovery-proven', owner: 'operator', description: 'A suppressed wake recovered through the generic scan.' }),
  Object.freeze({ id: 'delayed-retry-proven', owner: 'operator', description: 'A delayed event respected not_before without busy-looping.' }),
  Object.freeze({ id: 'replay-safety-proven', owner: 'operator', description: 'Duplicate, stale and out-of-order events produced no duplicate work.' }),
  Object.freeze({ id: 'one-manager-authority-proven', owner: 'operator', description: 'Only one mutating manager authority was ever active.' }),
  Object.freeze({ id: 'no-management-timer', owner: 'operator', description: 'No project-specific or role-specific manager timer remains.' }),
  Object.freeze({ id: 'rollback-fencing-proven', owner: 'operator', description: 'Rollback fences the event manager before any legacy re-enable.' }),
]);

/**
 * The external retirement gate. It is deliberately modelled as a separate,
 * always-outstanding item rather than as a `CUTOVER_GATES` entry, so no report
 * can ever compute it as satisfied from repository state.
 */
export const EXTERNAL_RETIREMENT_GATE = Object.freeze({
  id: 'external-scheduled-tasks-retired',
  owner: 'external-programme-action',
  tasks: EXTERNAL_SCHEDULED_MANAGEMENT_TASKS,
  description: 'After every other gate is positive, the external scheduled management tasks are disabled outside this repository.',
});

const GATE_IDS = new Set(CUTOVER_GATES.map((gate) => gate.id));

/**
 * Build a bounded cutover-readiness report.
 *
 * `satisfiedGates` is the explicit, operator-supplied list of gate ids already
 * evidenced. Anything not listed is outstanding: readiness is never inferred.
 */
export function buildCutoverReadiness({ acceptanceReport = null, satisfiedGates = [] } = {}) {
  if (!Array.isArray(satisfiedGates)) throw new Error('cutover satisfiedGates must be an array');
  const unknown = satisfiedGates.filter((gate) => !GATE_IDS.has(gate));
  if (unknown.length > 0) throw new Error(`unknown cutover gate(s): ${unknown.sort().join(', ')}`);
  const satisfied = new Set(satisfiedGates);

  const gates = CUTOVER_GATES.map((gate) => Object.freeze({
    id: gate.id,
    owner: gate.owner,
    description: gate.description,
    satisfied: satisfied.has(gate.id),
  }));

  const acceptancePositive = isPlainObject(acceptanceReport) ? acceptanceReport.accepted === true : null;
  const outstanding = gates.filter((gate) => !gate.satisfied);

  return Object.freeze({
    schemaVersion: MANAGEMENT_CUTOVER_SCHEMA_VERSION,
    gates: Object.freeze(gates),
    outstandingGateIds: Object.freeze(outstanding.map((gate) => gate.id)),
    fieldAcceptancePositive: acceptancePositive,
    // Every repository- and operator-owned gate positive *and* a positive field
    // acceptance report. Even then this only says the external action may now be
    // considered; it never performs it.
    readyForExternalRetirement: outstanding.length === 0 && acceptancePositive === true,
    externalRetirementGate: EXTERNAL_RETIREMENT_GATE,
    externalScheduledTasksRetiredByThisRepository: false,
  });
}

/**
 * The ordered rollback plan.
 *
 * Step one is always fencing, and it is the only step this repository executes.
 * Every subsequent step is marked `external: true` so an operator reading the
 * plan cannot mistake it for something the tooling already did.
 */
export function planManagementRollback({ currentMode = 'active' } = {}) {
  const steps = [
    Object.freeze({
      order: 1,
      id: 'fence-event-manager',
      external: false,
      description: 'Set the management control mode to `fenced`. No management event is claimed and no mutation is possible while fenced.',
      command: 'node scripts/ops/agent-runner-management-control-command.mjs fence --actor <operator> --reason <bounded-reason>',
    }),
    Object.freeze({
      order: 2,
      id: 'verify-fenced',
      external: false,
      description: 'Confirm the persisted mode is `fenced` and the mode audit records the transition.',
      command: 'node scripts/ops/agent-runner-management-control-command.mjs status',
    }),
    Object.freeze({
      order: 3,
      id: 'verify-no-mutating-authority',
      external: false,
      description: 'Confirm no manager-authority lock is held, so no mutating manager remains active.',
      command: 'node scripts/ops/agent-runner-management-control-command.mjs status',
    }),
    Object.freeze({
      order: 4,
      id: 'reenable-external-scheduled-tasks',
      external: true,
      description: 'Only after fencing is verified, an operator may re-enable the external scheduled management tasks outside this repository. This tooling cannot and does not perform it.',
      tasks: EXTERNAL_SCHEDULED_MANAGEMENT_TASKS,
    }),
  ];
  return Object.freeze({
    schemaVersion: MANAGEMENT_CUTOVER_SCHEMA_VERSION,
    currentMode,
    steps: Object.freeze(steps),
    invariant: 'fence-before-any-legacy-reenable',
    externalScheduledTasksRetiredByThisRepository: false,
  });
}
