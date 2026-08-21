#!/usr/bin/env node

/**
 * #266: the bounded, deterministic, dependency-aware queue-curation
 * transition. One pure function maps validated project/plan/current-queue
 * evidence onto a normalized curation result carrying a dry-run mutation
 * proposal and a bounded semantic outcome -- see
 * docs/ops/AGENT-RUNNER-MANAGER-QUEUE-CURATOR.md.
 *
 * This module performs no GitHub call, no provider invocation, no dispatch and
 * no mutation of any kind. It also owns no scheduling: it embeds no timer,
 * recurrence, sleep or poll assumption, and never emits a management event
 * itself. It only reports which successor a later event controller *could*
 * justify, so `agent-runner-management-events.mjs` (#289) remains the single
 * owner of the durable ledger, dedupe, leases, delayed events and wake
 * primitives.
 */

import {
  assertNormalizedManagerQueueEvidenceShape,
  normalizeQueueTitle,
  queueCurationKey,
} from './agent-runner-manager-queue-evidence.mjs';
import {
  contentFingerprint,
  freezeArray,
  isPlainObject,
  stableJson,
} from './agent-runner-manager-planner-safety.mjs';

export const MANAGER_QUEUE_CURATION_SCHEMA_VERSION = 'agent-runner-manager-queue-curation/v1';

/**
 * The only successors a later event controller may derive from one curation.
 * These names deliberately mirror the #289 management-event types so #268 can
 * bind them without translation, but this module never enqueues one.
 */
export const QUEUE_CURATION_SUCCESSOR_HINTS = Object.freeze([
  'none',
  'execution-reconcile-required',
  'programme-reconcile-required',
  'queue-assurance-required',
  'delayed-retry',
]);

/** Queue-state labels curation may set. `inProgress`/`done` belong to execution and settlement. */
const CURATABLE_LABEL_STATES = Object.freeze(['ready', 'blocked']);
/** Queue-state labels whose presence proves the record is already owned downstream. */
const OWNERSHIP_LABEL_STATES = Object.freeze(['inProgress', 'done']);

const OPERATION_KIND_ORDER = Object.freeze({
  'create-issue': 0,
  'update-labels': 1,
  'update-dependencies': 2,
});

const VALIDATED_CURATIONS = new WeakSet();

function sortedNumbers(values) {
  return [...values].sort((a, b) => a - b);
}

function sortedStrings(values) {
  return [...values].sort();
}

function sameNumberList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Resolve the terminal issue of a supersession chain. Evidence validation has
 * already proven every chain is present and acyclic, so this walk always
 * terminates.
 */
function terminalIssue(issue, byNumber, superseded) {
  let cursor = issue;
  while (cursor.supersededBy !== null) {
    superseded.push(cursor.number);
    cursor = byNumber.get(cursor.supersededBy);
  }
  return cursor;
}

/**
 * Derive per-issue dependency edges from the accepted #261 plan shape: a
 * proposed issue depends on every proposed issue belonging to a milestone its
 * own milestone directly depends on. No new planner input is introduced.
 */
function proposedDependencyIds(proposal) {
  const issueIdsByMilestone = new Map(proposal.milestones.map((milestone) => [milestone.id, []]));
  for (const issue of proposal.proposedIssues) {
    issueIdsByMilestone.get(issue.milestoneId).push(issue.id);
  }
  const dependsOnByMilestone = new Map(proposal.milestones.map((milestone) => [milestone.id, milestone.dependsOn]));
  const result = new Map();
  for (const issue of proposal.proposedIssues) {
    const dependencies = [];
    for (const dependencyMilestone of dependsOnByMilestone.get(issue.milestoneId)) {
      dependencies.push(...issueIdsByMilestone.get(dependencyMilestone));
    }
    result.set(issue.id, freezeArray(sortedStrings(dependencies)));
  }
  return result;
}

function resolveIdentity(proposal, queueEvidence, errors) {
  const byNumber = new Map(queueEvidence.issues.map((issue) => [issue.number, issue]));
  const byCurationKey = new Map();
  const curationKeyPrefix = `qc:${proposal.projectId}:`;
  for (const issue of queueEvidence.issues) {
    if (issue.curationKey === null) continue;
    if (!issue.curationKey.startsWith(curationKeyPrefix)) {
      errors.push(`issue ${issue.number} carries curation key '${issue.curationKey}', which belongs to a different registered project than '${proposal.projectId}'`);
      continue;
    }
    byCurationKey.set(issue.curationKey, issue);
  }

  const openAdoptableByTitle = new Map();
  for (const issue of queueEvidence.issues) {
    if (issue.state !== 'open' || issue.supersededBy !== null || issue.curationKey !== null) continue;
    const title = normalizeQueueTitle(issue.title);
    const bucket = openAdoptableByTitle.get(title) ?? [];
    bucket.push(issue);
    openAdoptableByTitle.set(title, bucket);
  }

  const seenProposedTitles = new Map();
  for (const proposed of proposal.proposedIssues) {
    const title = normalizeQueueTitle(proposed.title);
    if (seenProposedTitles.has(title)) {
      errors.push(`proposed issues '${seenProposedTitles.get(title)}' and '${proposed.id}' describe duplicate proposed work with the same normalized title`);
      continue;
    }
    seenProposedTitles.set(title, proposed.id);
  }

  const claimedIssueNumbers = new Map();
  const matches = new Map();
  for (const proposed of proposal.proposedIssues) {
    const curationKey = queueCurationKey(proposal.projectId, proposed.id);
    const supersededFrom = [];
    let match = byCurationKey.get(curationKey) ?? null;
    if (match) {
      match = terminalIssue(match, byNumber, supersededFrom);
    } else {
      const candidates = openAdoptableByTitle.get(normalizeQueueTitle(proposed.title)) ?? [];
      if (candidates.length > 1) {
        errors.push(`proposed issue '${proposed.id}' matches ${candidates.length} existing open issues by title (${candidates.map((issue) => `#${issue.number}`).join(', ')}); issue identity is ambiguous`);
        continue;
      }
      match = candidates[0] ?? null;
    }
    if (match) {
      const existingClaim = claimedIssueNumbers.get(match.number);
      if (existingClaim) {
        errors.push(`proposed issues '${existingClaim}' and '${proposed.id}' both resolve to existing issue #${match.number}; issue identity is ambiguous`);
        continue;
      }
      claimedIssueNumbers.set(match.number, proposed.id);
    }
    matches.set(proposed.id, {
      curationKey,
      match,
      supersededFrom: freezeArray(sortedNumbers(supersededFrom)),
    });
  }

  return { matches, claimedIssueNumbers, byNumber, byCurationKey };
}

function resolveOwnership(queueEvidence, profile, errors) {
  const leaseByIssue = new Map();
  for (const lease of queueEvidence.ownership.activeLeases) {
    leaseByIssue.set(lease.issueNumber, lease);
  }
  const pullRequestsByIssue = new Map();
  for (const pull of queueEvidence.ownership.openPullRequests) {
    const bucket = pullRequestsByIssue.get(pull.issueNumber) ?? [];
    bucket.push(pull.number);
    pullRequestsByIssue.set(pull.issueNumber, bucket);
  }

  const inProgressLabel = profile.labels.inProgress ?? null;
  const inProgressIssues = inProgressLabel
    ? queueEvidence.issues.filter((issue) => issue.state === 'open' && issue.labels.includes(inProgressLabel))
    : [];
  if (inProgressIssues.length > 1) {
    errors.push(`the one-global-implementation-slot invariant is violated: issues ${inProgressIssues.map((issue) => `#${issue.number}`).join(', ')} all carry the in-progress label`);
  }
  const implementationLease = queueEvidence.ownership.activeLeases.find((lease) => lease.kind === 'implementation') ?? null;
  if (implementationLease && inProgressIssues.length === 1 && inProgressIssues[0].number !== implementationLease.issueNumber) {
    errors.push(`duplicate implementation ownership: issue #${implementationLease.issueNumber} holds the active implementation lease while issue #${inProgressIssues[0].number} carries the in-progress label`);
  }

  return { leaseByIssue, pullRequestsByIssue, inProgressLabel };
}

/**
 * Why an existing record must not be mutated by this curation. Returns the
 * single highest-precedence reason so the outcome stays deterministic when a
 * record is protected several ways at once.
 */
function protectionReason(issue, ownership, profile) {
  const lease = ownership.leaseByIssue.get(issue.number) ?? null;
  if (lease?.kind === 'implementation') return 'active-implementation-lease';
  if (lease?.kind === 'recovery') return 'recovery-ownership';
  if ((ownership.pullRequestsByIssue.get(issue.number) ?? []).length > 0) return 'open-pull-request';
  for (const state of OWNERSHIP_LABEL_STATES) {
    const label = profile.labels[state] ?? null;
    if (label && issue.labels.includes(label)) return `${state}-label`;
  }
  return null;
}

function curatableLabels(profile) {
  const labels = [];
  for (const state of CURATABLE_LABEL_STATES) {
    const label = profile.labels[state] ?? null;
    if (label) labels.push(label);
  }
  return freezeArray(sortedStrings(labels));
}

function detectDependencyCycle(records, queueEvidence, errors) {
  const edges = new Map();
  const addNode = (node) => {
    if (!edges.has(node)) edges.set(node, []);
    return edges.get(node);
  };
  const nodeForRecord = (record) => (record.issueNumber === null ? `proposed:${record.proposedIssueId}` : `issue:${record.issueNumber}`);

  const recordById = new Map(records.map((record) => [record.proposedIssueId, record]));
  const claimed = new Set(records.filter((record) => record.issueNumber !== null).map((record) => record.issueNumber));

  // Records express the *intended* post-mutation edges; unclaimed existing
  // issues keep the edges the evidence already shows. Superseded issues carry
  // no active edges.
  for (const record of records) {
    const from = addNode(nodeForRecord(record));
    for (const dependencyId of record.dependsOnProposedIssueIds) {
      const dependency = recordById.get(dependencyId);
      if (dependency) from.push(nodeForRecord(dependency));
    }
  }
  for (const issue of queueEvidence.issues) {
    if (claimed.has(issue.number) || issue.supersededBy !== null) continue;
    const from = addNode(`issue:${issue.number}`);
    for (const dependency of issue.dependsOn) {
      from.push(`issue:${dependency}`);
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...edges.keys()].map((node) => [node, WHITE]));
  const stack = [];
  let cycleFound = false;
  const visit = (node) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of sortedStrings(edges.get(node) ?? [])) {
      if (cycleFound) return;
      if (!color.has(next)) continue;
      if (color.get(next) === GRAY) {
        const cycleStart = stack.indexOf(next);
        errors.push(`queue dependencies contain a cycle: ${[...stack.slice(cycleStart), next].join(' -> ')}`);
        cycleFound = true;
        return;
      }
      if (color.get(next) === WHITE) visit(next);
    }
    stack.pop();
    color.set(node, BLACK);
  };
  for (const node of sortedStrings([...edges.keys()])) {
    if (cycleFound) break;
    if (color.get(node) === WHITE) visit(node);
  }
}

function buildRecords(proposal, queueEvidence, identity, ownership, profile) {
  const dependencyIds = proposedDependencyIds(proposal);
  const records = [];
  for (const proposed of proposal.proposedIssues) {
    const resolved = identity.matches.get(proposed.id);
    const match = resolved.match;
    const classification = match === null ? 'absent' : (match.state === 'closed' ? 'completed' : 'present');
    records.push({
      proposedIssueId: proposed.id,
      curationKey: resolved.curationKey,
      milestoneId: proposed.milestoneId,
      title: proposed.title,
      scope: proposed.scope,
      acceptanceCriteria: proposed.acceptanceCriteria,
      decisionType: proposed.decisionType,
      issueNumber: match?.number ?? null,
      classification,
      supersededFrom: resolved.supersededFrom,
      currentLabels: match?.labels ?? freezeArray([]),
      currentDependsOn: match?.dependsOn ?? freezeArray([]),
      protection: match && classification === 'present' ? protectionReason(match, ownership, profile) : null,
      dependsOnProposedIssueIds: dependencyIds.get(proposed.id),
    });
  }
  return records;
}

function resolveReadiness(records) {
  const byId = new Map(records.map((record) => [record.proposedIssueId, record]));
  for (const record of records) {
    const dependencies = record.dependsOnProposedIssueIds.map((id) => byId.get(id)).filter(Boolean);
    const unsatisfied = dependencies.filter((dependency) => dependency.classification !== 'completed');
    record.dependencies = freezeArray(dependencies.map((dependency) => Object.freeze({
      proposedIssueId: dependency.proposedIssueId,
      issueNumber: dependency.issueNumber,
      satisfied: dependency.classification === 'completed',
    })));
    record.readiness = record.classification === 'completed'
      ? 'completed'
      : (unsatisfied.length === 0 ? 'ready' : 'blocked');
    record.resolvedDependencyIssueNumbers = freezeArray(
      sortedNumbers(dependencies.map((dependency) => dependency.issueNumber).filter((value) => value !== null)),
    );
  }
}

function desiredQueueLabel(record, profile) {
  if (record.readiness === 'ready') return profile.labels.ready ?? null;
  if (record.readiness === 'blocked') return profile.labels.blocked ?? null;
  return null;
}

function buildOperations(records, profile, curatable) {
  const operations = [];
  const deferred = [];
  const escalations = [];
  const curatableSet = new Set(curatable);

  for (const record of records) {
    const desired = desiredQueueLabel(record, profile);

    if (record.classification === 'absent') {
      // A proposed item that encodes a product decision is never materialized
      // by the curator: inventing product scope is a manager/owner decision.
      if (record.decisionType === 'product') {
        escalations.push({
          kind: 'product-decision-required',
          curationKey: record.curationKey,
          proposedIssueId: record.proposedIssueId,
          detail: 'proposed work is a product decision and must be confirmed by an owner before it is curated into the queue',
        });
        record.disposition = 'escalated';
        continue;
      }
      record.disposition = 'create';
      operations.push({
        kind: 'create-issue',
        sortKey: `${OPERATION_KIND_ORDER['create-issue']}:${record.curationKey}`,
        curationKey: record.curationKey,
        proposedIssueId: record.proposedIssueId,
        issueNumber: null,
        title: record.title,
        labels: freezeArray(desired ? [desired] : []),
        bodySections: Object.freeze({
          curationKey: record.curationKey,
          milestoneId: record.milestoneId,
          scope: record.scope,
          acceptanceCriteria: record.acceptanceCriteria,
          dependsOn: record.resolvedDependencyIssueNumbers,
        }),
        readiness: record.readiness,
      });
      continue;
    }

    if (record.classification === 'completed') {
      record.disposition = 'completed';
      continue;
    }

    // A profile that declares no label for the record's readiness still has
    // any stale curated label removed, rather than leaving the queue asserting
    // a readiness the curation no longer supports.
    const removeLabels = sortedStrings(record.currentLabels.filter((label) => curatableSet.has(label) && label !== desired));
    const addLabels = desired !== null && !record.currentLabels.includes(desired) ? [desired] : [];
    const wantsLabelChange = removeLabels.length > 0 || addLabels.length > 0;
    const wantsDependencyChange = !sameNumberList(record.currentDependsOn, record.resolvedDependencyIssueNumbers);

    if (record.protection) {
      if (wantsLabelChange || wantsDependencyChange) {
        deferred.push({
          curationKey: record.curationKey,
          issueNumber: record.issueNumber,
          reason: record.protection,
          intended: freezeArray([
            ...(wantsLabelChange ? ['update-labels'] : []),
            ...(wantsDependencyChange ? ['update-dependencies'] : []),
          ]),
        });
        record.disposition = 'deferred';
      } else {
        record.disposition = 'protected';
      }
      continue;
    }

    let mutated = false;
    if (wantsLabelChange) {
      const resultingLabels = sortedStrings([
        ...record.currentLabels.filter((label) => !removeLabels.includes(label)),
        ...addLabels,
      ]);
      operations.push({
        kind: 'update-labels',
        sortKey: `${OPERATION_KIND_ORDER['update-labels']}:${record.curationKey}`,
        curationKey: record.curationKey,
        proposedIssueId: record.proposedIssueId,
        issueNumber: record.issueNumber,
        addLabels: freezeArray(addLabels),
        removeLabels: freezeArray(removeLabels),
        resultingLabels: freezeArray(resultingLabels),
        readiness: record.readiness,
      });
      mutated = true;
    }
    if (wantsDependencyChange) {
      operations.push({
        kind: 'update-dependencies',
        sortKey: `${OPERATION_KIND_ORDER['update-dependencies']}:${record.curationKey}`,
        curationKey: record.curationKey,
        proposedIssueId: record.proposedIssueId,
        issueNumber: record.issueNumber,
        dependsOn: record.resolvedDependencyIssueNumbers,
        previousDependsOn: record.currentDependsOn,
        readiness: record.readiness,
      });
      mutated = true;
    }
    record.disposition = mutated ? 'update' : 'unchanged';
  }

  return { operations, deferred, escalations };
}

function collectOrphanEscalations(proposal, queueEvidence, identity, escalations) {
  const curationKeyPrefix = `qc:${proposal.projectId}:`;
  const claimedKeys = new Set([...identity.matches.values()].map((entry) => entry.curationKey));
  for (const issue of queueEvidence.issues) {
    if (issue.state !== 'open' || issue.supersededBy !== null) continue;
    if (issue.curationKey === null || !issue.curationKey.startsWith(curationKeyPrefix)) continue;
    if (claimedKeys.has(issue.curationKey)) continue;
    escalations.push({
      kind: 'orphaned-curated-issue',
      curationKey: issue.curationKey,
      issueNumber: issue.number,
      detail: 'a curated open issue is absent from the current plan; retiring planned work is an owner decision, not a curation mutation',
    });
  }
}

/**
 * Precedence is fixed and documented so identical input always yields an
 * identical successor hint. A hint is only ever a *recommendation*: this
 * module never enqueues, wakes or dispatches anything.
 */
function successorFor({ escalationCount, createdCount, readyTransitionCount, deferredCount, operationCount }) {
  if (escalationCount > 0) return Object.freeze({ successorHint: 'programme-reconcile-required', successorReason: 'owner-decision-outstanding' });
  if (createdCount > 0 || readyTransitionCount > 0) return Object.freeze({ successorHint: 'execution-reconcile-required', successorReason: 'ready-work-changed' });
  if (deferredCount > 0) return Object.freeze({ successorHint: 'delayed-retry', successorReason: 'active-ownership-collision' });
  if (operationCount > 0) return Object.freeze({ successorHint: 'queue-assurance-required', successorReason: 'queue-annotation-changed' });
  return Object.freeze({ successorHint: 'none', successorReason: 'no-semantic-change' });
}

/**
 * Convert validated project/plan/current-queue evidence into one bounded,
 * deterministic queue-curation proposal. Fails closed (throws) on ambiguous
 * issue identity, duplicate proposed work, dependency cycles, cross-project
 * curation keys, colliding implementation ownership or any other state a
 * deterministic curation cannot resolve. Never mutates anything: the returned
 * `operations` array is a dry-run proposal that
 * `agent-runner-manager-queue-mutation.mjs` must separately validate and apply.
 */
export function curateManagerQueue(queueEvidence) {
  assertNormalizedManagerQueueEvidenceShape(queueEvidence);
  const proposal = queueEvidence.proposal;
  const profile = proposal.brief.evidence.profile;
  const errors = [];

  const identity = resolveIdentity(proposal, queueEvidence, errors);
  const ownership = resolveOwnership(queueEvidence, profile, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager queue curation: ${errors.join('; ')}`);

  const records = buildRecords(proposal, queueEvidence, identity, ownership, profile);
  resolveReadiness(records);
  detectDependencyCycle(records, queueEvidence, errors);
  if (errors.length) throw new Error(`Invalid agent runner manager queue curation: ${errors.join('; ')}`);

  const curatable = curatableLabels(profile);
  const { operations, deferred, escalations } = buildOperations(records, profile, curatable);
  collectOrphanEscalations(proposal, queueEvidence, identity, escalations);
  for (const escalation of proposal.escalations) {
    escalations.push({ kind: 'plan-escalation', curationKey: null, issueNumber: null, detail: escalation });
  }

  const sortedOperations = freezeArray(
    [...operations]
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
      .map(({ sortKey, ...operation }) => Object.freeze(operation)),
  );
  const sortedDeferred = freezeArray(
    [...deferred]
      .sort((left, right) => left.curationKey.localeCompare(right.curationKey))
      .map((entry) => Object.freeze(entry)),
  );
  const sortedEscalations = freezeArray(
    [...escalations]
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
      .map((entry) => Object.freeze(entry)),
  );

  const normalizedRecords = freezeArray(
    [...records]
      .sort((left, right) => left.curationKey.localeCompare(right.curationKey))
      .map((record) => Object.freeze({
        proposedIssueId: record.proposedIssueId,
        curationKey: record.curationKey,
        milestoneId: record.milestoneId,
        title: record.title,
        issueNumber: record.issueNumber,
        classification: record.classification,
        readiness: record.readiness,
        disposition: record.disposition,
        protection: record.protection,
        supersededFrom: record.supersededFrom,
        dependencies: record.dependencies,
        resolvedDependencyIssueNumbers: record.resolvedDependencyIssueNumbers,
      })),
  );

  const createdCount = sortedOperations.filter((operation) => operation.kind === 'create-issue').length;
  const labelUpdateCount = sortedOperations.filter((operation) => operation.kind === 'update-labels').length;
  const dependencyUpdateCount = sortedOperations.filter((operation) => operation.kind === 'update-dependencies').length;
  const readyLabel = profile.labels.ready ?? null;
  const readyTransitionCount = sortedOperations.filter((operation) => (
    (operation.kind === 'create-issue' && operation.readiness === 'ready')
    || (operation.kind === 'update-labels' && readyLabel !== null && operation.addLabels.includes(readyLabel))
  )).length;

  const outcome = Object.freeze({
    semanticChange: sortedOperations.length > 0,
    operationCount: sortedOperations.length,
    createdCount,
    labelUpdateCount,
    dependencyUpdateCount,
    readyTransitionCount,
    deferredCount: sortedDeferred.length,
    escalationCount: sortedEscalations.length,
    readyCount: normalizedRecords.filter((record) => record.readiness === 'ready').length,
    blockedCount: normalizedRecords.filter((record) => record.readiness === 'blocked').length,
    completedCount: normalizedRecords.filter((record) => record.readiness === 'completed').length,
    protectedCount: normalizedRecords.filter((record) => record.protection !== null).length,
    ...successorFor({
      escalationCount: sortedEscalations.length,
      createdCount,
      readyTransitionCount,
      deferredCount: sortedDeferred.length,
      operationCount: sortedOperations.length,
    }),
  });

  const identityPayload = Object.freeze({
    schemaVersion: MANAGER_QUEUE_CURATION_SCHEMA_VERSION,
    projectId: proposal.projectId,
    repository: queueEvidence.repository,
    branch: proposal.branch,
    sourceSha: proposal.sourceSha,
    proposalFingerprint: proposal.proposalFingerprint,
    queueEvidenceFingerprint: queueEvidence.queueEvidenceFingerprint,
  });
  // Deterministic and time-free: identical inputs always produce an identical
  // revision, so a replay can never look like a fresh curation.
  const curationRevision = `qcr:${contentFingerprint(identityPayload).slice('sha256:'.length, 'sha256:'.length + 32)}`;

  const fingerprintPayload = Object.freeze({
    ...identityPayload,
    curationRevision,
    curatableLabels: curatable,
    records: normalizedRecords,
    operations: sortedOperations,
    deferred: sortedDeferred,
    escalations: sortedEscalations,
    outcome,
  });
  const curationFingerprint = contentFingerprint(fingerprintPayload);
  const normalized = Object.freeze({ ...fingerprintPayload, curationFingerprint, queueEvidence });
  VALIDATED_CURATIONS.add(normalized);
  return normalized;
}

/**
 * Refuse anything that merely *looks* like a validated curation: provenance is
 * checked against a `WeakSet` populated only by `curateManagerQueue()` itself.
 */
export function assertNormalizedManagerQueueCurationShape(curation) {
  if (!isPlainObject(curation) || !Object.isFrozen(curation) || !VALIDATED_CURATIONS.has(curation)) {
    throw new Error('requires an already-validated manager queue curation: object was not produced by curateManagerQueue');
  }
}

/** Stable, deterministic serialization: identical inputs always yield identical bytes. */
export function serializeManagerQueueCuration(curation) {
  assertNormalizedManagerQueueCurationShape(curation);
  const { queueEvidence, ...serializable } = curation;
  return stableJson(serializable);
}
