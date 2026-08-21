#!/usr/bin/env node

/**
 * #268: the bounded control-mode and role-capability boundary for the
 * event-driven management control plane.
 *
 * Two independent things are decided here, and nothing else:
 *
 *  1. **Control mode** -- whether this repository's management control plane
 *     may process durable events at all, and whether it may mutate anything
 *     while doing so. The mode is explicit and fail-closed: an absent,
 *     unrecognised or ambiguous mode never resolves to a mutating state.
 *
 *  2. **Role capabilities** -- which ports a role handler is even *given*.
 *     This is deliberately structural rather than conventional: the read-only
 *     assurance role is built by a factory that refuses to accept a mutation
 *     port at all, so an assurance handler cannot call a mutation surface even
 *     if its own code tried to.
 *
 * This module is pure. It performs no I/O, reads no clock, opens no database
 * and contacts nothing. It never merges, closes, deploys, activates source,
 * dispatches a worker or changes a timer/service -- those are not capabilities
 * of any role in this contract and are refused by name below.
 */

import { freezeArray, isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_CONTROL_MODE_SCHEMA_VERSION = 'agent-runner-management-control-mode/v1';

/**
 * The complete bounded set of control modes.
 *
 * - `disabled` -- the control plane is not installed/enabled. No event is
 *   claimed and nothing is mutated. This is the default for an unconfigured
 *   deployment, so a fresh checkout can never start managing anything.
 * - `shadow`   -- events are claimed and role transitions are computed so the
 *   proposed decisions can be compared against the still-authoritative
 *   external management tasks, but every mutating port is suppressed.
 * - `active`   -- the control plane is the mutating manager authority.
 * - `fenced`   -- an explicit, auditable emergency stop used by rollback. It
 *   is deliberately distinct from `disabled`: fencing records that a
 *   previously-enabled control plane was deliberately stopped, which is the
 *   precondition rollback must satisfy before any legacy management authority
 *   could be re-enabled.
 */
export const MANAGEMENT_CONTROL_MODES = Object.freeze(['disabled', 'shadow', 'active', 'fenced']);

/** The three event-driven management roles. There is no fourth. */
export const MANAGEMENT_ROLES = Object.freeze(['programme', 'execution', 'assurance']);

/**
 * Every port name any role may ever be granted. A name not in this list can
 * never be granted to any role, and the forbidden list below is refused
 * outright wherever ports are supplied.
 */
export const MANAGEMENT_CAPABILITIES = Object.freeze([
  // The read surface every role gets. A handler must re-read authoritative
  // evidence rather than trust the wake event it was given, so this port is
  // mandatory for all three roles.
  'collectEvidence',
  // Mutating surfaces. Suppressed in every non-active mode and granted only to
  // the one role that owns them.
  'applyQueueMutation',
  'publishWorkerAuthority',
  'publishContinuationAuthority',
]);

/**
 * Surfaces that are **never** a management-role capability in this contract,
 * refused by name wherever ports are supplied. #268 adds an event graph; it
 * does not add a merge, a close, a deployment, a source activation, a worker
 * dispatch or a timer/service change to any role.
 */
export const FORBIDDEN_MANAGEMENT_CAPABILITIES = Object.freeze([
  'merge',
  'mergePullRequest',
  'closeIssue',
  'deploy',
  'activateSource',
  'sourceActivation',
  'dispatchWorker',
  'startWorker',
  'consumeWorkerAuthority',
  'enableTimer',
  'disableTimer',
  'restartService',
  'writeCheckout',
]);

/** Mutating capabilities: granted only in `active` mode, and only to their owning role. */
const MUTATING_CAPABILITIES = Object.freeze([
  'applyQueueMutation',
  'publishWorkerAuthority',
  'publishContinuationAuthority',
]);

/**
 * The capability matrix. Programme is the one mutating role. Execution owns
 * lifecycle follow-through and same-pull-request continuation only -- it can
 * never curate the queue or mint a new worker authority. Assurance is
 * read-only and is granted no mutating capability in any mode.
 */
const ROLE_CAPABILITIES = Object.freeze({
  programme: freezeArray(['collectEvidence', 'applyQueueMutation', 'publishWorkerAuthority']),
  execution: freezeArray(['collectEvidence', 'publishContinuationAuthority']),
  assurance: freezeArray(['collectEvidence']),
});

/** Which event type each role handles. Unknown types are refused by the controller. */
export const ROLE_BY_EVENT_TYPE = Object.freeze({
  'programme-reconcile-required': 'programme',
  'execution-reconcile-required': 'execution',
  'queue-assurance-required': 'assurance',
});

const CAPABILITY_SET = new Set(MANAGEMENT_CAPABILITIES);
const FORBIDDEN_SET = new Set(FORBIDDEN_MANAGEMENT_CAPABILITIES);
const MUTATING_SET = new Set(MUTATING_CAPABILITIES);
const MODE_SET = new Set(MANAGEMENT_CONTROL_MODES);

const VALIDATED_CAPABILITIES = new WeakSet();

/**
 * Resolve one explicit control mode, failing closed.
 *
 * Returns a bounded resolution rather than throwing so a controller can record
 * the refusal and stop cleanly instead of crash-looping. `processing` and
 * `mutating` are the only two questions callers ever need to ask, and both are
 * `false` for every state that is not positively recognised.
 */
export function resolveManagementControlMode(input = {}) {
  if (!isPlainObject(input)) {
    return refusal('mode-input-invalid');
  }
  const unknown = Object.keys(input).filter((key) => key !== 'mode');
  if (unknown.length > 0) return refusal('mode-input-invalid');
  const { mode } = input;
  if (!nonEmptyString(mode) || !MODE_SET.has(mode)) return refusal('mode-unknown');

  // `disabled` and `fenced` both stop processing. They are kept distinct so an
  // operator and an auditor can tell "never turned on" apart from "deliberately
  // stopped", which is the difference rollback evidence depends on.
  const processing = mode === 'shadow' || mode === 'active';
  const mutating = mode === 'active';
  return Object.freeze({
    schemaVersion: MANAGEMENT_CONTROL_MODE_SCHEMA_VERSION,
    ok: true,
    mode,
    processing,
    mutating,
    // A suppressed mode still computes decisions; it simply cannot apply them.
    mutationSuppressed: processing && !mutating,
    reason: null,
  });
}

function refusal(reason) {
  return Object.freeze({
    schemaVersion: MANAGEMENT_CONTROL_MODE_SCHEMA_VERSION,
    ok: false,
    mode: null,
    processing: false,
    mutating: false,
    mutationSuppressed: false,
    reason,
  });
}

function assertPortsShape(ports, label) {
  if (!isPlainObject(ports)) throw new Error(`${label} ports must be an object`);
  for (const [name, value] of Object.entries(ports)) {
    if (FORBIDDEN_SET.has(name)) {
      throw new Error(`${label} ports must not supply the forbidden capability '${name}': merge, close, deploy, source activation, worker dispatch and timer/service control are never management-role capabilities`);
    }
    if (!CAPABILITY_SET.has(name)) {
      throw new Error(`${label} ports contain an unrecognised capability '${name}'`);
    }
    if (typeof value !== 'function') {
      throw new Error(`${label} port '${name}' must be a function`);
    }
  }
}

/**
 * Build the capability object one role handler is given for one event.
 *
 * The returned object contains *only* the ports that role is permitted in that
 * mode. A capability the role does not own, or that the mode suppresses, is
 * absent -- not present-and-refusing -- so a handler cannot reach it at all.
 * `granted` and `suppressed` are reported so the controller can persist
 * bounded evidence of exactly what the handler could do.
 */
export function resolveRoleCapabilities({ role, mode, ports = {} } = {}) {
  if (!nonEmptyString(role) || !ROLE_CAPABILITIES[role]) {
    throw new Error(`unknown management role: ${String(role ?? '')}`);
  }
  const resolvedMode = resolveManagementControlMode({ mode });
  if (!resolvedMode.ok) {
    throw new Error(`unknown management control mode: ${String(mode ?? '')}`);
  }
  if (!resolvedMode.processing) {
    throw new Error(`management control mode '${resolvedMode.mode}' does not process events`);
  }
  assertPortsShape(ports, `management role '${role}'`);

  const permitted = ROLE_CAPABILITIES[role];

  // A port supplied for a capability this role does not own is a wiring defect,
  // never a silent grant. This runs before the grant loop so the more specific
  // "must not be supplied" error wins over a generic missing-port error.
  for (const name of Object.keys(ports)) {
    if (!permitted.includes(name)) {
      throw new Error(`management role '${role}' must not be supplied the '${name}' port`);
    }
  }

  const granted = [];
  const suppressed = [];
  const resolved = {};
  for (const name of permitted) {
    const mutatingCapability = MUTATING_SET.has(name);
    if (mutatingCapability && !resolvedMode.mutating) {
      suppressed.push(name);
      continue;
    }
    const port = ports[name];
    if (typeof port !== 'function') {
      // A missing port is always a wiring defect. In a mutating mode this
      // matters especially: silently suppressing it would make an `active`
      // controller behave like shadow while still reporting itself as mutating,
      // which is exactly the ambiguity that must never produce a decision.
      throw new Error(`management role '${role}' requires the '${name}' port in '${resolvedMode.mode}' mode`);
    }
    resolved[name] = port;
    granted.push(name);
  }

  const capabilities = Object.freeze({
    schemaVersion: MANAGEMENT_CONTROL_MODE_SCHEMA_VERSION,
    role,
    mode: resolvedMode.mode,
    mutationSuppressed: resolvedMode.mutationSuppressed,
    granted: freezeArray(granted.sort()),
    suppressed: freezeArray(suppressed.sort()),
    ports: Object.freeze({ ...resolved }),
  });
  VALIDATED_CAPABILITIES.add(capabilities);
  return capabilities;
}

/**
 * The read-only assurance capability factory.
 *
 * This exists so assurance is *structurally* incapable of mutation rather than
 * merely conventionally read-only: it accepts a separate `readers` argument and
 * refuses outright if any mutating or forbidden port name appears in it. The
 * generic factory above would already deny a mutating port to assurance; this
 * makes an attempt to wire one a loud wiring error at construction time instead
 * of a silent suppression at dispatch time.
 */
export function createAssuranceCapabilities({ mode, readers = {} } = {}) {
  if (!isPlainObject(readers)) throw new Error('assurance readers must be an object');
  for (const name of Object.keys(readers)) {
    if (MUTATING_SET.has(name) || FORBIDDEN_SET.has(name)) {
      throw new Error(`read-only assurance must never be supplied the mutating capability '${name}'`);
    }
  }
  return resolveRoleCapabilities({ role: 'assurance', mode, ports: readers });
}

/** Refuse anything that merely *looks* like a resolved capability set. */
export function assertResolvedRoleCapabilities(capabilities, { role } = {}) {
  if (!isPlainObject(capabilities) || !Object.isFrozen(capabilities) || !VALIDATED_CAPABILITIES.has(capabilities)) {
    throw new Error('requires resolved role capabilities: object was not produced by resolveRoleCapabilities');
  }
  if (role && capabilities.role !== role) {
    throw new Error(`role capability mismatch: expected '${role}', received '${capabilities.role}'`);
  }
  return capabilities;
}

/** Whether a role currently holds one named capability. */
export function hasCapability(capabilities, name) {
  assertResolvedRoleCapabilities(capabilities);
  return typeof capabilities.ports[name] === 'function';
}
