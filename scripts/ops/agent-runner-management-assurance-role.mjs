#!/usr/bin/env node

/**
 * #268 role 3: queue assurance -- the independent, genuinely **read-only**
 * auditor.
 *
 * It inherits the responsibilities of the external Queue Oversight task:
 * independently re-read authoritative evidence and detect false ready/busy
 * state, idle safe capacity, duplicate or stale authority, wrong-SHA
 * validation, completion claimed without evidence, same-pull-request
 * violations, source/control-plane drift, identity mismatch, slot
 * contradictions, security-boundary breaches and subscription-quota policy
 * violations.
 *
 * Read-only here is structural, not conventional, in three independent ways:
 *
 *  1. **No mutation import.** This module imports no queue-mutation module, no
 *     authority-issuance module and no continuation module. There is no
 *     mutation function in its scope to call, and a boundary test asserts this
 *     stays true.
 *  2. **No mutation capability.** The assurance capability set is built by
 *     `createAssuranceCapabilities()`, which refuses at construction time if a
 *     mutating port is even offered to it.
 *  3. **No mutation channel in its output.** Its only outward effect is a
 *     bounded finding record and, at most, one `programme-reconcile-required`
 *     successor. A #289 successor carries identity only -- there is no field in
 *     the event schema in which an instruction could be placed -- so assurance
 *     can ask for reconciliation but can never say what to change.
 *
 * It also never mutates the discrepancy it finds. Correcting anything is the
 * programme role's job, and the programme role will re-read authoritative
 * evidence from scratch before doing so.
 */

import {
  assertResolvedRoleCapabilities,
} from './agent-runner-management-control-mode.mjs';
import { buildManagementRoleResult } from './agent-runner-management-role-result.mjs';
import { reviseManagementStatusProjection } from './agent-runner-management-status-projection.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_ASSURANCE_ROLE_SCHEMA_VERSION = 'agent-runner-management-assurance-role/v1';

/** The complete bounded set of assurance outcomes. */
export const ASSURANCE_OUTCOMES = Object.freeze([
  'clean',
  'correctable-discrepancy',
  'owner-attention',
  'blocked',
]);

/**
 * Every finding this auditor can raise, with its fixed severity. The severity
 * decides the outcome, and only `correctable` findings may wake programme
 * reconciliation.
 */
export const ASSURANCE_FINDING_SEVERITY = Object.freeze({
  'security-boundary-breach': 'blocking',
  'quota-policy-violation': 'blocking',
  'credit-admission-observed': 'blocking',
  'source-drift': 'blocking',
  'project-identity-mismatch': 'blocking',
  'scheduler-authority-drift': 'blocking',
  'implementation-slot-contradiction': 'blocking',
  'completion-without-evidence': 'owner-attention',
  'same-pull-request-violation': 'owner-attention',
  'unexpected-replacement-pull-request': 'owner-attention',
  'duplicate-authority': 'owner-attention',
  'stale-authority': 'correctable',
  'wrong-sha-validation': 'correctable',
  'false-ready-state': 'correctable',
  'false-busy-state': 'correctable',
  'idle-safe-capacity': 'correctable',
});

const SEVERITY_RANK = Object.freeze({ correctable: 1, 'owner-attention': 2, blocking: 3 });

const OBSERVATION_FIELDS = new Set([
  'projectId', 'repository', 'registeredRepository', 'sourceSha', 'expectedSourceSha',
  'controllerHost', 'schedulerHost', 'queue', 'ownership', 'authorities', 'checks',
  'completions', 'capacity', 'quotaPolicy', 'security', 'projectionContext',
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_COLLECTION = 200;

function fail(message) {
  throw new Error(`Refusing agent runner queue assurance: ${message}`);
}

function boundedArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > MAX_COLLECTION) fail(`${label} exceeds the bounded limit of ${MAX_COLLECTION}`);
  return value;
}

function validateObservation(observation) {
  if (!isPlainObject(observation)) fail('collectEvidence must return an observation object');
  const unknown = Object.keys(observation).filter((key) => !OBSERVATION_FIELDS.has(key));
  if (unknown.length > 0) fail(`assurance observation contains unsupported field(s): ${unknown.sort().join(', ')}`);
  if (!nonEmptyString(observation.projectId)) fail('assurance observation projectId is required');
  if (!nonEmptyString(observation.repository)) fail('assurance observation repository is required');
  if (!nonEmptyString(observation.sourceSha) || !SHA_PATTERN.test(observation.sourceSha)) {
    fail('assurance observation sourceSha must be an exact 40-character lowercase commit SHA');
  }
  return observation;
}

function assertIdentityBinding(event, observation) {
  if (observation.projectId !== event.projectId) {
    fail(`observation is for project '${observation.projectId}' but the event is for '${event.projectId}'`);
  }
  if (observation.repository.toLowerCase() !== String(event.repository).toLowerCase()) {
    fail(`observation is for repository '${observation.repository}' but the event is for '${event.repository}'`);
  }
}

function add(findings, findingClass, identity = {}) {
  const severity = ASSURANCE_FINDING_SEVERITY[findingClass];
  if (!severity) fail(`unknown assurance finding class: ${findingClass}`);
  findings.push({
    findingClass,
    severity,
    issueNumber: identity.issueNumber ?? null,
    pullRequestNumber: identity.pullRequestNumber ?? null,
    sha: identity.sha ?? null,
  });
}

/**
 * Control-plane integrity: the source actually in use, who is allowed to
 * schedule, and whether the observed identity is the registered one.
 */
function auditControlPlane(observation, findings) {
  if (nonEmptyString(observation.expectedSourceSha) && observation.expectedSourceSha !== observation.sourceSha) {
    add(findings, 'source-drift', { sha: observation.sourceSha });
  }
  if (nonEmptyString(observation.registeredRepository)
    && observation.registeredRepository.toLowerCase() !== observation.repository.toLowerCase()) {
    add(findings, 'project-identity-mismatch');
  }
  // Dell is the sole scheduler/controller. Any other host holding the scheduler
  // role is drift, which is exactly the Z790-never-scheduler guarantee.
  if (nonEmptyString(observation.controllerHost) && nonEmptyString(observation.schedulerHost)
    && observation.controllerHost.toLowerCase() !== observation.schedulerHost.toLowerCase()) {
    add(findings, 'scheduler-authority-drift');
  }
}

/** Queue truth: a record that claims to be ready or busy but is not. */
function auditQueueTruth(observation, findings) {
  const queue = isPlainObject(observation.queue) ? observation.queue : {};
  const issues = boundedArray(queue.issues, 'assurance observation queue.issues');
  const readyLabel = queue.readyLabel ?? null;
  const inProgressLabel = queue.inProgressLabel ?? null;
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const ownership = isPlainObject(observation.ownership) ? observation.ownership : {};
  const leases = boundedArray(ownership.activeLeases, 'assurance observation ownership.activeLeases');
  const pulls = boundedArray(ownership.openPullRequests, 'assurance observation ownership.openPullRequests');

  for (const issue of issues) {
    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    // False ready: advertised as runnable while a declared dependency is still open.
    if (readyLabel && labels.includes(readyLabel)) {
      const dependsOn = Array.isArray(issue.dependsOn) ? issue.dependsOn : [];
      const unmet = dependsOn.some((dependency) => byNumber.get(dependency)?.state === 'open');
      if (unmet) add(findings, 'false-ready-state', { issueNumber: issue.number });
    }
    // False busy: advertised as owned while nothing actually owns it.
    if (inProgressLabel && labels.includes(inProgressLabel)) {
      const leased = leases.some((lease) => lease.issueNumber === issue.number);
      const hasPull = pulls.some((pull) => pull.issueNumber === issue.number);
      if (!leased && !hasPull) add(findings, 'false-busy-state', { issueNumber: issue.number });
    }
  }
}

/** Ownership integrity: one slot, one pull request per issue, no replacement. */
function auditOwnership(observation, findings) {
  const ownership = isPlainObject(observation.ownership) ? observation.ownership : {};
  const leases = boundedArray(ownership.activeLeases, 'assurance observation ownership.activeLeases');
  const pulls = boundedArray(ownership.openPullRequests, 'assurance observation ownership.openPullRequests');
  const capacity = isPlainObject(observation.capacity) ? observation.capacity : {};

  const implementationLeases = leases.filter((lease) => lease.kind === 'implementation');
  if (implementationLeases.length > 1) {
    add(findings, 'implementation-slot-contradiction', { issueNumber: implementationLeases[0].issueNumber });
  }
  // The reported slot state must agree with the leases actually held.
  if (typeof capacity.implementationSlotOccupied === 'boolean'
    && capacity.implementationSlotOccupied !== (implementationLeases.length > 0)) {
    add(findings, 'implementation-slot-contradiction');
  }

  const pullsByIssue = new Map();
  for (const pull of pulls) {
    const list = pullsByIssue.get(pull.issueNumber) ?? [];
    list.push(pull);
    pullsByIssue.set(pull.issueNumber, list);
  }
  for (const [issueNumber, list] of [...pullsByIssue.entries()].sort((left, right) => left[0] - right[0])) {
    if (list.length > 1) add(findings, 'same-pull-request-violation', { issueNumber, pullRequestNumber: list[0].number });
  }

  // Safe idle capacity: nothing is running and runnable work exists, so the
  // programme role should have selected something. This is the single most
  // valuable correctable finding, because it is exactly the stall the event
  // loop exists to eliminate.
  if (capacity.implementationSlotOccupied === false && capacity.readyWorkAvailable === true) {
    add(findings, 'idle-safe-capacity');
  }
}

/** Authority integrity: exactly one live authority per issue, bound to current source. */
function auditAuthorities(observation, findings) {
  const authorities = boundedArray(observation.authorities, 'assurance observation authorities');
  const ownership = isPlainObject(observation.ownership) ? observation.ownership : {};
  const pulls = boundedArray(ownership.openPullRequests, 'assurance observation ownership.openPullRequests');

  const liveByIssue = new Map();
  const seenKeys = new Set();
  for (const authority of authorities) {
    if (seenKeys.has(authority.authorityKey)) {
      add(findings, 'duplicate-authority', { issueNumber: authority.issueNumber });
      continue;
    }
    seenKeys.add(authority.authorityKey);
    if (authority.state !== 'issued') continue;
    const existing = liveByIssue.get(authority.issueNumber);
    if (existing) {
      add(findings, 'duplicate-authority', { issueNumber: authority.issueNumber });
      continue;
    }
    liveByIssue.set(authority.issueNumber, authority);
    // An authority still advertised as live against a base that has moved is
    // stale by definition and must never be consumed.
    if (nonEmptyString(authority.baseSha) && authority.baseSha !== observation.sourceSha) {
      add(findings, 'stale-authority', { issueNumber: authority.issueNumber, sha: authority.baseSha });
    }
    // Same-pull-request continuation means the authority's bound pull request
    // is the only one; a different open pull request is a replacement.
    if (authority.pullRequestNumber != null) {
      for (const pull of pulls) {
        if (pull.issueNumber === authority.issueNumber && pull.number !== authority.pullRequestNumber) {
          add(findings, 'unexpected-replacement-pull-request', { issueNumber: authority.issueNumber, pullRequestNumber: pull.number });
        }
      }
    }
  }
}

/** Validation integrity: required checks must be read at the exact current head. */
function auditChecks(observation, findings) {
  for (const check of boundedArray(observation.checks, 'assurance observation checks')) {
    if (check.required !== true) continue;
    if (!nonEmptyString(check.headSha) || !nonEmptyString(check.checkedSha)) continue;
    if (check.headSha !== check.checkedSha) {
      add(findings, 'wrong-sha-validation', { pullRequestNumber: check.pullRequestNumber ?? null, sha: check.checkedSha });
    }
  }
}

/** Completion integrity: nothing is complete without evidence that it completed. */
function auditCompletions(observation, findings) {
  for (const completion of boundedArray(observation.completions, 'assurance observation completions')) {
    if (completion.claimedComplete === true && completion.hasMergeEvidence !== true) {
      add(findings, 'completion-without-evidence', { issueNumber: completion.issueNumber ?? null });
    }
  }
}

/**
 * Policy integrity: subscription admission is quota headroom only.
 *
 * Any observed account-credit, balance, dollar-cap, auto-top-up or paid/metered
 * fallback signal in an admission path is a blocking policy violation, not an
 * advisory note.
 */
function auditPolicy(observation, findings) {
  const quotaPolicy = isPlainObject(observation.quotaPolicy) ? observation.quotaPolicy : {};
  const forbidden = boundedArray(quotaPolicy.forbiddenSignalsObserved, 'assurance observation quotaPolicy.forbiddenSignalsObserved');
  if (forbidden.length > 0) add(findings, 'credit-admission-observed');
  const admission = boundedArray(quotaPolicy.admissionSignals, 'assurance observation quotaPolicy.admissionSignals');
  if (admission.length > 0 && !admission.every((signal) => signal === 'quota')) {
    add(findings, 'quota-policy-violation');
  }
  const security = isPlainObject(observation.security) ? observation.security : {};
  const breaches = boundedArray(security.boundaryViolations, 'assurance observation security.boundaryViolations');
  if (breaches.length > 0) add(findings, 'security-boundary-breach');
}

const PROJECTION_LIFECYCLE_BY_OUTCOME = Object.freeze({
  clean: 'quiescent',
  'correctable-discrepancy': 'planning',
  'owner-attention': 'owner-attention',
  blocked: 'blocked',
});

const NEXT_ACTION_BY_OUTCOME = Object.freeze({
  clean: 'none',
  'correctable-discrepancy': 'programme-reconcile',
  'owner-attention': 'owner-decision',
  blocked: 'none',
});

/**
 * Run one bounded, read-only queue assurance pass.
 *
 * Returns a validated role result carrying bounded findings and, for a
 * correctable discrepancy only, exactly one identity-only
 * `programme-reconcile-required` successor.
 */
export function runQueueAssurance({
  event,
  capabilities,
  now,
  recentDecisions = [],
} = {}) {
  assertResolvedRoleCapabilities(capabilities, { role: 'assurance' });
  if (!isPlainObject(event)) fail('event must be an object');
  if (!nonEmptyString(now)) fail('now must be an ISO-8601 timestamp');
  // Belt and braces: assurance must never have been granted a mutating port,
  // in any mode, by any wiring path.
  for (const name of ['applyQueueMutation', 'publishWorkerAuthority', 'publishContinuationAuthority']) {
    if (typeof capabilities.ports[name] === 'function') {
      fail(`read-only assurance was granted the mutating capability '${name}'`);
    }
  }

  // Assurance re-reads authoritative evidence independently: it does not reuse
  // the programme role's curation or the execution role's settlement.
  const observation = validateObservation(capabilities.ports.collectEvidence({ event }));
  assertIdentityBinding(event, observation);

  const findings = [];
  auditControlPlane(observation, findings);
  auditQueueTruth(observation, findings);
  auditOwnership(observation, findings);
  auditAuthorities(observation, findings);
  auditChecks(observation, findings);
  auditCompletions(observation, findings);
  auditPolicy(observation, findings);

  // Deterministic ordering so identical evidence always yields an identical
  // result, then highest severity decides the bounded outcome.
  findings.sort((left, right) => (
    right.severity.localeCompare(left.severity)
    || left.findingClass.localeCompare(right.findingClass)
    || (left.issueNumber ?? 0) - (right.issueNumber ?? 0)
    || (left.pullRequestNumber ?? 0) - (right.pullRequestNumber ?? 0)
  ));

  const worst = findings.reduce((rank, finding) => Math.max(rank, SEVERITY_RANK[finding.severity] ?? 0), 0);
  let outcome;
  let reason;
  if (worst === 0) {
    outcome = 'clean';
    reason = 'no-discrepancy-detected';
  } else if (worst === SEVERITY_RANK.blocking) {
    outcome = 'blocked';
    reason = 'systemic-discrepancy';
  } else if (worst === SEVERITY_RANK['owner-attention']) {
    outcome = 'owner-attention';
    reason = 'owner-decision-required';
  } else {
    outcome = 'correctable-discrepancy';
    reason = 'reconciliation-required';
  }

  // The only outward effect available to this role. It carries classification
  // and correlation identity, never an instruction: the programme handler that
  // claims it re-reads authoritative evidence and decides for itself.
  const successors = outcome === 'correctable-discrepancy'
    ? [{ eventType: 'programme-reconcile-required' }]
    : [];

  const projectionContext = observation.projectionContext ?? null;
  const projection = isPlainObject(projectionContext)
    ? reviseManagementStatusProjection({
      previous: projectionContext,
      changes: {
        currentEvent: { eventId: event.eventId, eventType: event.eventType, state: 'claimed' },
        lifecycleState: PROJECTION_LIFECYCLE_BY_OUTCOME[outcome],
        recentDecisions,
        nextAction: {
          classification: NEXT_ACTION_BY_OUTCOME[outcome],
          eventType: successors.length > 0 ? successors[0].eventType : null,
          notBefore: null,
        },
        ownerAttentionRequired: outcome === 'owner-attention',
        controlMode: capabilities.mode,
      },
      updatedAt: now,
    })
    : null;

  return buildManagementRoleResult({
    role: 'assurance',
    outcome,
    reason,
    settlementState: outcome === 'blocked' ? 'blocked' : 'settled',
    // Assurance has nothing to suppress: it never had a mutating capability in
    // any mode, so this is always false rather than mode-dependent.
    mutationSuppressed: false,
    identity: { projectId: observation.projectId, repository: observation.repository },
    successors,
    findings,
    projection,
  });
}
