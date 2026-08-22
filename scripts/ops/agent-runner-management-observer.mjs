#!/usr/bin/env node

/**
 * #268: the deterministic material-transition observer seam.
 *
 * This is where "something really changed in the world" is decided, and it is
 * deliberately one small module rather than edits scattered through every
 * lifecycle surface. It reads the same bounded adapter surface the production
 * collectors use, computes a **semantic** fingerprint for each observable
 * transition, and hands the results to `produceManagementEvents()`, which
 * durably suppresses anything whose fingerprint has not moved.
 *
 * Three properties matter:
 *
 *  1. **Closed allowlist.** Every observation below is a named function for a
 *     named transition kind. There is no open-ended callback, no caller-supplied
 *     observer and no way to register a new kind at runtime, so this seam cannot
 *     become a channel for arbitrary management events.
 *
 *  2. **Semantic fingerprints only.** Each fingerprint is computed over the
 *     fields that actually change management's mind -- issue state and labels,
 *     dependency edges, ownership, the exact head, required-check terminality,
 *     review actionability, the accepted source revision. Titles, bodies,
 *     timestamps, comment counts and other cosmetic churn are deliberately
 *     excluded, so a cosmetic edit or a repeated poll cannot move a fingerprint.
 *
 *  3. **Identity-only output.** A transition carries project, repository, issue,
 *     pull request and exact SHA. It never carries an instruction: the handler
 *     that later claims the event re-reads authoritative evidence and decides
 *     for itself.
 *
 * The observer decides nothing about what should run. It only reports that
 * evidence moved.
 */

import { createHash } from 'node:crypto';

import { MANAGEMENT_EVENT_PRODUCERS } from './agent-runner-management-producers.mjs';
import { parseCuratedIssueBody } from './agent-runner-management-collectors.mjs';
import { isPlainObject, nonEmptyString, stableJson } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_OBSERVER_SCHEMA_VERSION = 'agent-runner-management-observer/v1';

/** Check states that are terminal for the purposes of waking execution reconciliation. */
const TERMINAL_CHECK_STATES = new Set(['success', 'failure', 'cancelled', 'neutral', 'skipped']);
/** Review states that are actionable for a manager. `pending` is not. */
const ACTIONABLE_REVIEW_STATES = new Set(['changes-requested', 'no-blockers']);
/** Publication states that represent a finished worker attempt. */
const TERMINAL_PUBLICATION_STATES = new Set(['published', 'failed', 'abandoned']);

const MAX_TRANSITIONS = 100;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function fingerprint(material) {
  return `sha256:${createHash('sha256').update(stableJson(material)).digest('hex')}`;
}

function transition(kind, { profile, issueNumber = null, pullRequestNumber = null, sha = null, material }) {
  if (!MANAGEMENT_EVENT_PRODUCERS[kind]) {
    throw new Error(`Refusing agent runner management observation: unrecognised transition kind '${kind}'`);
  }
  return {
    kind,
    projectId: profile.projectId,
    repository: profile.repository.full,
    ...(issueNumber === null ? {} : { issueNumber }),
    ...(pullRequestNumber === null ? {} : { pullRequestNumber }),
    ...(sha === null ? {} : { sha }),
    evidenceFingerprint: fingerprint(material),
  };
}

/**
 * Queue evidence: the open issue set reduced to the fields management reasons
 * about. A retitled or re-bodied issue produces an identical fingerprint.
 */
function observeQueueEvidence({ profile, issues }) {
  const material = issues
    .map((issue) => ({
      number: issue.number,
      state: issue.state,
      labels: [...(issue.labels ?? [])].sort(),
    }))
    .sort((left, right) => left.number - right.number);
  return transition('github-evidence-settled', { profile, material });
}

/** Dependency edges: only the managed depends-on graph and the state it resolves against. */
function observeDependencyReadiness({ profile, issues }) {
  const stateByNumber = new Map(issues.map((issue) => [issue.number, issue.state]));
  const material = issues
    .map((issue) => ({
      number: issue.number,
      dependsOn: [...(issue.dependsOn ?? [])].sort((left, right) => left - right)
        .map((dependency) => ({ number: dependency, state: stateByNumber.get(dependency) ?? 'unknown' })),
    }))
    .filter((entry) => entry.dependsOn.length > 0)
    .sort((left, right) => left.number - right.number);
  if (material.length === 0) return null;
  return transition('dependency-readiness-changed', { profile, material });
}

/**
 * The global implementation slot, reported as whichever edge it is currently on.
 *
 * A freed slot wakes programme reconciliation and needs no issue identity -- it
 * says "capacity exists", not "reconcile this attempt". An occupied slot wakes
 * *execution* reconciliation, which does need identity, so it is only emitted
 * when the occupancy can be attributed to an issue. An ambiguous slot is not a
 * transition at all: nothing has been proven to change.
 */
function observeImplementationSlot({ profile, slot }) {
  const state = nonEmptyString(slot.state) ? slot.state : (slot.occupied === true ? 'occupied' : 'free');
  if (state === 'ambiguous') return null;
  if (state === 'free') {
    return transition('implementation-slot-freed', { profile, material: { state: 'free' } });
  }
  if (!Number.isInteger(slot.issueNumber) || slot.issueNumber <= 0) return null;
  return transition('implementation-slot-occupied', {
    profile,
    issueNumber: slot.issueNumber,
    material: { state: 'occupied', issueNumber: slot.issueNumber },
  });
}

/**
 * Worker ownership, one transition **per lease**.
 *
 * An aggregate lease-set event could represent several attempts at once and
 * could not be reconciled against any one of them, so each lease wakes
 * execution reconciliation for its own issue.
 */
function observeWorkerOwnership({ profile, ownership }) {
  const results = [];
  for (const lease of ownership.activeLeases ?? []) {
    if (!Number.isInteger(lease.issueNumber) || lease.issueNumber <= 0) continue;
    results.push(transition('worker-ownership-changed', {
      profile,
      issueNumber: lease.issueNumber,
      material: { issueNumber: lease.issueNumber, kind: lease.kind },
    }));
  }
  return results;
}

/**
 * One publication transition **per pull request**, never one for the set.
 *
 * An execution wake must name exactly the attempt it belongs to: an aggregate
 * event cannot be reconciled against a specific authority, and resolving it
 * would mean picking an arbitrary one. A pull request that carries no issue
 * identity therefore produces no event at all rather than an unresolvable one.
 */
function observePullRequestPublications({ profile, ownership }) {
  const results = [];
  for (const pull of ownership.openPullRequests ?? []) {
    if (pull.issueNumber == null) continue;
    results.push(transition('pull-request-published', {
      profile,
      issueNumber: pull.issueNumber,
      pullRequestNumber: pull.number,
      sha: nonEmptyString(pull.headSha) && SHA_PATTERN.test(String(pull.headSha).toLowerCase())
        ? String(pull.headSha).toLowerCase()
        : null,
      material: { pullRequestNumber: pull.number, issueNumber: pull.issueNumber },
    }));
  }
  return results;
}

/**
 * Accepted merge evidence for an authorised pull request that has already left
 * the open list.
 *
 * A merge is read only from explicit merged evidence. A pull request that
 * merely disappeared from the open set is never inferred to have merged.
 */
function observeMergedPullRequests({ profile, closedPulls }) {
  const results = [];
  for (const pull of closedPulls ?? []) {
    if (pull.merged !== true) continue;
    if (pull.issueNumber == null) continue;
    results.push(transition('merge-evidence-accepted', {
      profile,
      issueNumber: pull.issueNumber,
      pullRequestNumber: pull.number,
      sha: nonEmptyString(pull.mergeCommitSha) && SHA_PATTERN.test(String(pull.mergeCommitSha).toLowerCase())
        ? String(pull.mergeCommitSha).toLowerCase()
        : null,
      material: {
        pullRequestNumber: pull.number,
        issueNumber: pull.issueNumber,
        merged: true,
        mergeCommitSha: pull.mergeCommitSha ?? null,
      },
    }));
  }
  return results;
}

/** One transition per authorised pull request whose exact head moved. */
function observePullRequestHeads({ profile, ownership }) {
  const results = [];
  for (const pull of ownership.openPullRequests ?? []) {
    if (!nonEmptyString(pull.headSha) || !SHA_PATTERN.test(String(pull.headSha).toLowerCase())) continue;
    // An execution wake must name its attempt; an unattributable pull request
    // produces no event rather than an unresolvable one.
    if (pull.issueNumber == null) continue;
    results.push(transition('pull-request-head-changed', {
      profile,
      issueNumber: pull.issueNumber,
      pullRequestNumber: pull.number,
      sha: String(pull.headSha).toLowerCase(),
      material: { pullRequestNumber: pull.number, headSha: String(pull.headSha).toLowerCase() },
    }));
  }
  return results;
}

/**
 * Attempt-derived transitions for one pull request: publication, terminal
 * result, terminal exact-head checks, actionable review and accepted merge
 * evidence. Each is fingerprinted over its own semantic slice, so a pending
 * check does not wake anything and a settled one wakes exactly once.
 */
function observeAttempt({ profile, pull, attempt }) {
  const results = [];
  if (!isPlainObject(attempt)) return results;
  // Every transition below wakes execution reconciliation, which resolves an
  // exact authority by issue. Without that identity, emit nothing.
  if (pull.issueNumber == null) return results;

  const publication = attempt.publication ?? null;
  if (isPlainObject(publication)) {
    results.push(transition('implementation-published', {
      profile,
      issueNumber: pull.issueNumber,
      pullRequestNumber: pull.number,
      sha: nonEmptyString(publication.headSha) ? String(publication.headSha).toLowerCase() : null,
      material: { attemptId: publication.attemptId, headSha: publication.headSha, completionState: publication.completionState },
    }));
    if (TERMINAL_PUBLICATION_STATES.has(publication.completionState)) {
      results.push(transition('worker-terminal-result', {
        profile,
        issueNumber: pull.issueNumber ?? null,
        pullRequestNumber: pull.number,
        material: { attemptId: publication.attemptId, completionState: publication.completionState },
      }));
    }
  }

  const ci = attempt.ci ?? null;
  if (isPlainObject(ci) && Array.isArray(ci.checks)) {
    const required = ci.checks.filter((check) => check.required === true);
    // Only a fully terminal required-check set is a material transition; a
    // pending run must not wake the manager on every poll.
    if (required.length > 0 && required.every((check) => TERMINAL_CHECK_STATES.has(check.state))) {
      results.push(transition('required-checks-terminal', {
        profile,
        issueNumber: pull.issueNumber ?? null,
        pullRequestNumber: pull.number,
        sha: nonEmptyString(ci.headSha) ? String(ci.headSha).toLowerCase() : null,
        material: {
          headSha: ci.headSha,
          checks: [...required].map((check) => ({ name: check.name, state: check.state }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        },
      }));
    }
  }

  const review = attempt.review ?? null;
  if (isPlainObject(review) && ACTIONABLE_REVIEW_STATES.has(review.state)) {
    results.push(transition('review-actionable', {
      profile,
      issueNumber: pull.issueNumber,
      pullRequestNumber: pull.number,
      sha: nonEmptyString(review.headSha) ? String(review.headSha).toLowerCase() : null,
      material: {
        state: review.state,
        headSha: review.headSha,
        findings: [...(review.findings ?? [])].map((finding) => ({ id: finding.id, severity: finding.severity, actionable: finding.actionable }))
          .sort((left, right) => String(left.id).localeCompare(String(right.id))),
      },
    }));
  }

  // Accepted merge evidence is read as a programme fact. Observing it never
  // performs or authorises a merge.
  const pullRequest = attempt.pullRequest ?? null;
  if (isPlainObject(pullRequest) && pullRequest.state === 'merged') {
    results.push(transition('merge-evidence-accepted', {
      profile,
      issueNumber: pull.issueNumber,
      pullRequestNumber: pull.number,
      sha: nonEmptyString(pullRequest.headSha) ? String(pullRequest.headSha).toLowerCase() : null,
      material: { pullRequestNumber: pull.number, state: pullRequest.state, headSha: pullRequest.headSha },
    }));
  }
  return results;
}

/**
 * Accepted source-activation evidence.
 *
 * Read from the durable record the activation controller already writes, so a
 * recurring production cycle needs no operator-supplied expected SHA. The
 * transition distinguishes applied from refused and names the exact target; it
 * carries no instruction and can never authorise an activation.
 */
function observeSourceActivation({ profile, sourceSha, activation, expectedSourceSha }) {
  if (isPlainObject(activation) && nonEmptyString(activation.result)) {
    const applied = activation.result === 'activated' || activation.result === 'already-active';
    return transition('source-activation-settled', {
      profile,
      sha: nonEmptyString(activation.finalHead) && SHA_PATTERN.test(activation.finalHead) ? activation.finalHead : sourceSha,
      material: {
        result: activation.result,
        applied,
        requestedTarget: activation.requestedTarget ?? null,
        finalHead: activation.finalHead ?? null,
      },
    });
  }
  // Fall back to an explicitly supplied expectation when no durable record
  // exists yet; with neither, nothing about activation has been observed.
  if (!nonEmptyString(expectedSourceSha)) return null;
  return transition('source-activation-settled', {
    profile,
    sha: sourceSha,
    material: { sourceSha, expectedSourceSha, applied: sourceSha === expectedSourceSha },
  });
}

/** A recorded correctable assurance finding that programme reconciliation should see. */
function observeAssuranceFindings({ profile, findings }) {
  const correctable = findings
    .filter((finding) => finding.severity === 'correctable')
    .map((finding) => ({ findingClass: finding.findingClass, issueNumber: finding.issueNumber, pullRequestNumber: finding.pullRequestNumber }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  if (correctable.length === 0) return null;
  return transition('assurance-discrepancy', { profile, material: correctable });
}

/**
 * Observe every material transition for one registered project.
 *
 * Pure with respect to the control plane: it enqueues nothing and mutates
 * nothing. The caller passes the result to `produceManagementEvents()`, which
 * owns durability and semantic suppression.
 */
export function observeMaterialTransitions({
  project,
  profile,
  adapters,
  controlStore,
  expectedSourceSha = null,
} = {}) {
  if (!isPlainObject(profile)) throw new Error('observeMaterialTransitions requires the registered manager profile');
  if (!isPlainObject(adapters)) throw new Error('observeMaterialTransitions requires the bounded adapter surface');

  const sourceSha = String(adapters.readSourceSha({ project, profile }) ?? '').toLowerCase();
  if (!SHA_PATTERN.test(sourceSha)) {
    throw new Error('Refusing agent runner management observation: the accepted source revision is not an exact commit SHA');
  }

  const issues = (adapters.listOpenIssues({ project, profile }) ?? []).slice(0, 200).map((issue) => {
    const parsed = parseCuratedIssueBody(issue.body);
    return {
      number: issue.number,
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: Array.isArray(issue.labels) ? issue.labels : [],
      dependsOn: [...parsed.dependsOn],
    };
  });
  const ownership = adapters.readOwnership({ project, profile }) ?? { activeLeases: [], openPullRequests: [] };
  const slot = adapters.readImplementationSlot({ project, profile }) ?? {};

  // Accepted merge evidence outlives the open-pull-request list, so a merged
  // pull request stays observable after it closes.
  const closedPulls = typeof adapters.listRecentlyClosedPullRequests === 'function'
    ? (adapters.listRecentlyClosedPullRequests({ project, profile }) ?? []).slice(0, 50)
    : [];
  const activation = typeof adapters.readSourceActivationEvidence === 'function'
    ? adapters.readSourceActivationEvidence({ project, profile })
    : null;

  const transitions = [
    observeQueueEvidence({ profile, issues }),
    observeDependencyReadiness({ profile, issues }),
    observeImplementationSlot({ profile, slot }),
    ...observeWorkerOwnership({ profile, ownership }),
    ...observePullRequestPublications({ profile, ownership }),
    ...observePullRequestHeads({ profile, ownership }),
    ...observeMergedPullRequests({ profile, closedPulls }),
    observeSourceActivation({ profile, sourceSha, activation, expectedSourceSha }),
  ];

  for (const pull of ownership.openPullRequests ?? []) {
    const attempt = adapters.readAttempt({ project, profile, pullRequestNumber: pull.number });
    transitions.push(...observeAttempt({ profile, pull, attempt }));
  }

  if (controlStore) {
    transitions.push(observeAssuranceFindings({
      profile,
      findings: controlStore.listFindings({ projectId: profile.projectId, limit: 50 }),
    }));
  }

  const bounded = transitions.filter(Boolean).slice(0, MAX_TRANSITIONS);
  return Object.freeze(bounded.map((entry) => Object.freeze(entry)));
}
