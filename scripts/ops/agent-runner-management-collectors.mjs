#!/usr/bin/env node

/**
 * #268: the **production** role evidence collectors and `resolvePorts` factory.
 *
 * This is the module that makes the control plane runnable rather than merely
 * injectable. It turns live bounded evidence -- the exact source revision, the
 * registered manager profile, the registered management plan, current GitHub
 * issue/pull-request/check/review state, quota headroom, the global
 * implementation slot and the persisted authority ledger -- into exactly the
 * already-validated inputs each role handler requires.
 *
 * Two design rules keep this honest:
 *
 *  1. **Validate, never hand-build.** Every object handed to a role passes
 *     through the accepted #261/#266/#267 validators, so a collector cannot
 *     fabricate a trusted value. The handlers additionally check provenance, so
 *     a look-alike is refused even if one were constructed here.
 *
 *  2. **One bounded adapter surface.** Everything touching the outside world --
 *     git, GitHub, quota, the implementation lock, host identity -- arrives as a
 *     named adapter function. Production supplies real ones; the focused tests
 *     supply bounded fakes around *this same code*, so the production path is
 *     what is under test rather than a parallel test-only path.
 *
 * The collectors read. They never mutate: the only write-capable ports this
 * factory exposes are the ones the mode and the role capability boundary
 * already permit, and they are omitted entirely outside `active` mode.
 */

import { createHash } from 'node:crypto';

import { ManagementControlStore } from './agent-runner-management-control-store.mjs';
import { resolveRegisteredManagementPlan } from './agent-runner-management-plan-registry.mjs';
import { MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER } from './agent-runner-manager-authority.mjs';
import { MANAGER_PLAN_PROPOSAL_SCHEMA_VERSION, validateManagerPlanProposal } from './agent-runner-manager-plan-proposal.mjs';
import { resolveRegisteredManagerProfile } from './agent-runner-manager-profile-registry.mjs';
import { MANAGER_PROJECT_BRIEF_SCHEMA_VERSION, validateManagerProjectBrief } from './agent-runner-manager-project-brief.mjs';
import { MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION, validateManagerProjectEvidence } from './agent-runner-manager-project-evidence.mjs';
import { MANAGER_QUEUE_EVIDENCE_SCHEMA_VERSION, queueCurationKey, validateManagerQueueEvidence } from './agent-runner-manager-queue-evidence.mjs';
import { curateManagerQueue } from './agent-runner-manager-queue-curator.mjs';
import {
  AUTHORITY_PRODUCER_DOMAIN,
  issueManagerWorkerAuthority,
} from './agent-runner-manager-worker-authority.mjs';
import { MANAGER_SETTLEMENT_EVIDENCE_SCHEMA_VERSION, validateManagerSettlementEvidence } from './agent-runner-manager-settlement-evidence.mjs';
import { settleManagerLifecycle } from './agent-runner-manager-lifecycle-settlement.mjs';
import {
  ensureContinuationPublished,
  ensureWorkerAuthorityPublished,
} from './agent-runner-management-publication.mjs';
import { isPlainObject, nonEmptyString } from './agent-runner-manager-planner-safety.mjs';

export const MANAGEMENT_COLLECTORS_SCHEMA_VERSION = 'agent-runner-management-collectors/v1';

/** Every adapter the production collectors may call. Read surfaces are mandatory. */
export const REQUIRED_ADAPTERS = Object.freeze([
  'readSourceSha',
  'readInstructionDocument',
  'listOpenIssues',
  'listOpenPullRequests',
  'readQuotaAdmission',
  'readImplementationSlot',
  'readOwnership',
  'readAttempt',
  'readHosts',
]);

/**
 * Read surfaces a deployment may omit. Their absence narrows what can be
 * observed; it never turns an unproven fact into a proven one.
 */
export const OPTIONAL_READ_ADAPTERS = Object.freeze([
  'listRecentlyClosedPullRequests',
  'readSourceActivationEvidence',
]);

/**
 * The read adapter surface carries **no** write entry.
 *
 * Writes live in a separate `writeAdapters` transport that is constructed only
 * when the persisted mode is `active`, so a shadow, fenced or disabled control
 * plane has no write surface in scope at all rather than a suppressed one.
 */
export const OPTIONAL_ADAPTERS = Object.freeze([]);

const CURATION_KEY_MARKER = /<!--\s*agent-runner:queue-curation-key:\s*(qc:[a-z0-9-]+:[a-z0-9-]+)\s*-->/;
const DEPENDENCY_LINE = /^-\s*#(\d+)\s*$/;
const DEPENDENCY_BLOCK = /<!--\s*agent-runner:queue-dependencies:start\s*-->([\s\S]*?)<!--\s*agent-runner:queue-dependencies:end\s*-->/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function fail(message) {
  throw new Error(`Refusing agent runner management evidence collection: ${message}`);
}

/**
 * The write transport is required in `active` mode and must never be reachable
 * outside it. Assurance is never handed it under any mode.
 */
function assertWriteAdapters(writeAdapters) {
  if (!isPlainObject(writeAdapters)
    || typeof writeAdapters.createQueueMutationClient !== 'function'
    || typeof writeAdapters.listIssueComments !== 'function'
    || typeof writeAdapters.createIssueComment !== 'function') {
    fail('active mode requires the production write transport');
  }
  return writeAdapters;
}

function assertAdapters(adapters) {
  if (!isPlainObject(adapters)) fail('adapters must be an object');
  for (const name of REQUIRED_ADAPTERS) {
    if (typeof adapters[name] !== 'function') fail(`adapters.${name} is required`);
  }
  const known = new Set([...REQUIRED_ADAPTERS, ...OPTIONAL_READ_ADAPTERS]);
  for (const name of Object.keys(adapters)) {
    if (!known.has(name)) fail(`adapters contains an unrecognised entry '${name}'`);
  }
  return adapters;
}

/** A bounded ISO timestamp in the exact form the accepted evidence validators accept. */
function evidenceTimestamp(now) {
  const value = new Date(Date.parse(now));
  if (!Number.isFinite(value.getTime())) fail('now must be a valid timestamp');
  return `${value.toISOString().slice(0, 19)}Z`;
}

/**
 * A deterministic, bounded revision identifier for one collected snapshot.
 * Derived from the content it describes, so an unchanged snapshot keeps the
 * same revision and a changed one always differs.
 */
function evidenceRevision(prefix, material) {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 24)}`;
}

/**
 * Read the curation key and managed dependency edges back out of an issue body
 * that the accepted #266 mutation boundary wrote. This is purely the read side
 * of that written format; it parses nothing else and ignores human prose.
 */
export function parseCuratedIssueBody(body) {
  const text = typeof body === 'string' ? body : '';
  const keyMatch = CURATION_KEY_MARKER.exec(text);
  const blockMatch = DEPENDENCY_BLOCK.exec(text);
  const dependsOn = [];
  if (blockMatch) {
    for (const line of blockMatch[1].split('\n')) {
      const dependency = DEPENDENCY_LINE.exec(line.trim());
      if (dependency) dependsOn.push(Number(dependency[1]));
    }
  }
  return Object.freeze({ curationKey: keyMatch ? keyMatch[1] : null, dependsOn: Object.freeze(dependsOn) });
}

function repositoryParts(profile) {
  return { owner: profile.repository.owner, name: profile.repository.name };
}

/**
 * Build the validated #261 evidence -> brief -> proposal chain from the
 * registered plan plus live evidence. Everything revision-dependent is injected
 * here rather than carried by the checked-in plan document.
 */
function buildPlanChain({ profile, plan, sourceSha, openIssues, openPullRequests, adapters, project, now }) {
  const timestamp = evidenceTimestamp(now);
  const instructionDocuments = profile.instructionPaths.map((path) => {
    const document = adapters.readInstructionDocument({ project, profile, path });
    if (!isPlainObject(document) || !nonEmptyString(document.sha256)) {
      fail(`instruction document '${path}' could not be read at the accepted source revision`);
    }
    return { path, sha256: document.sha256, freshness: document.freshness ?? 'current' };
  });

  const evidenceInput = {
    schemaVersion: MANAGER_PROJECT_EVIDENCE_SCHEMA_VERSION,
    projectId: profile.projectId,
    repository: repositoryParts(profile),
    branch: profile.branches.default,
    sourceSha,
    evidenceRevision: evidenceRevision('evidence', { sourceSha, instructionDocuments, openIssues, openPullRequests }),
    evidenceTimestamp: timestamp,
    instructionDocuments,
    tooling: plan.tooling,
    acceptanceCommands: [...plan.acceptanceCommands],
    openIssues,
    openPullRequests,
  };
  const evidence = validateManagerProjectEvidence(evidenceInput, { profile });

  const briefInput = { schemaVersion: MANAGER_PROJECT_BRIEF_SCHEMA_VERSION, ...plan.brief };
  const brief = validateManagerProjectBrief(briefInput, { evidence });

  const proposalInput = {
    schemaVersion: MANAGER_PLAN_PROPOSAL_SCHEMA_VERSION,
    // Grounding names the repository as the exact `owner/name` identity the
    // validated evidence resolved to, not as an owner/name pair.
    grounding: { repository: evidence.repository.full, branch: profile.branches.default, sourceSha },
    milestones: plan.milestones.map((milestone) => ({ ...milestone })),
    proposedIssues: plan.proposedIssues.map((issue) => ({ ...issue })),
    blockers: [...plan.planBlockers],
    escalations: [...plan.escalations],
  };
  const proposal = validateManagerPlanProposal(proposalInput, { brief });

  return { evidence, brief, proposal, timestamp, inputs: { evidenceInput, briefInput, proposalInput } };
}

/**
 * Collect the bounded programme evidence.
 *
 * Nothing here decides anything: it assembles current, independently validated
 * inputs and hands them to the deterministic programme transition.
 */
export function collectProgrammeEvidence(args) {
  return programmeEvidenceForRole(buildProgrammeEvidence(collectProgrammeSnapshot(args)));
}

/**
 * Read every live input once, so one cycle never issues the same GitHub and
 * git reads twice.
 */
function collectProgrammeSnapshot({ project, profile, plan, adapters, controlStore, producerId, now }) {
  const sourceSha = String(adapters.readSourceSha({ project, profile }) ?? '').toLowerCase();
  if (!SHA_PATTERN.test(sourceSha)) fail('the current accepted source revision could not be read as an exact commit SHA');

  const rawIssues = adapters.listOpenIssues({ project, profile }) ?? [];
  const rawPulls = adapters.listOpenPullRequests({ project, profile }) ?? [];

  // #261 evidence carries a bounded *summary* of open work; #266 queue evidence
  // carries the curated queue records. Both are derived from the same read.
  const openIssues = rawIssues.slice(0, 200).map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: Array.isArray(issue.labels) ? issue.labels : [],
  }));
  const openPullRequests = rawPulls.slice(0, 50).map((pull) => ({
    number: pull.number,
    title: pull.title,
    headSha: pull.headSha,
    labels: Array.isArray(pull.labels) ? pull.labels : [],
  }));

  const planChain = buildPlanChain({
    profile, plan, sourceSha, openIssues, openPullRequests, adapters, project, now,
  });
  const { proposal, timestamp } = planChain;

  const queueIssues = rawIssues.slice(0, 200).map((issue) => {
    const parsed = parseCuratedIssueBody(issue.body);
    const record = {
      number: issue.number,
      title: issue.title,
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: Array.isArray(issue.labels) ? issue.labels : [],
    };
    if (parsed.curationKey) record.curationKey = parsed.curationKey;
    if (parsed.dependsOn.length > 0) record.dependsOn = [...parsed.dependsOn];
    return record;
  });

  const ownership = adapters.readOwnership({ project, profile }) ?? { activeLeases: [], openPullRequests: [] };
  const issuedAuthorities = controlStore.listIssuedAuthorities({ projectId: profile.projectId });
  const quota = adapters.readQuotaAdmission({ profileName: profile.validation.profile }) ?? {};
  const slot = adapters.readImplementationSlot({ project, profile }) ?? {};

  // Candidate requests are derived only for plan items that are already bound
  // to a real issue: the branch name needs that issue number, and an unbound
  // item has nothing to authorise yet.
  const candidateRequests = [];
  for (const issue of queueIssues) {
    if (!issue.curationKey) continue;
    const planItem = plan.proposedIssues.find(
      (item) => queueCurationKey(profile.projectId, item.id) === issue.curationKey,
    );
    if (!planItem) continue;
    candidateRequests.push({
      curationKey: issue.curationKey,
      branch: `${plan.request.branchPrefix}${planItem.id}-${issue.number}`,
      scope: [...plan.request.scope],
      stopConditions: [...plan.request.stopConditions],
    });
  }

  return {
    profile, plan, proposal, timestamp, sourceSha, queueIssues, ownership,
    issuedAuthorities, quota, slot, candidateRequests, producerId,
    planInputs: planChain.inputs,
  };
}

/**
 * Derive the validated evidence view from a snapshot.
 *
 * The ledger-derived implementation leases matter here: an authority holds its
 * issue from the moment it is granted -- before any pull request exists -- and
 * without them the curator could hand that issue to a second attempt. At the
 * moment an authority is *being* granted its own ledger entry does not exist
 * yet, so the evidence pinned alongside it naturally records the pre-grant
 * state that reproduces it.
 */
function buildProgrammeEvidence(snapshot) {
  const {
    profile, plan, proposal, timestamp, sourceSha, queueIssues, ownership,
    issuedAuthorities, quota, slot, candidateRequests, producerId,
  } = snapshot;

  const leases = [...(ownership.activeLeases ?? [])];
  const leasedIssues = new Set(leases.map((lease) => lease.issueNumber));
  for (const entry of issuedAuthorities) {
    if (entry.state !== 'issued' && entry.state !== 'consumed') continue;
    if (leasedIssues.has(entry.issueNumber)) continue;
    leases.push({ issueNumber: entry.issueNumber, kind: 'implementation', holder: 'management-authority' });
    leasedIssues.add(entry.issueNumber);
  }

  const queueEvidenceInput = {
    schemaVersion: MANAGER_QUEUE_EVIDENCE_SCHEMA_VERSION,
    projectId: profile.projectId,
    repository: repositoryParts(profile),
    branch: profile.branches.default,
    sourceSha,
    evidenceRevision: evidenceRevision('queue', { sourceSha, queueIssues, ownership }),
    evidenceTimestamp: timestamp,
    issues: queueIssues,
    ownership: {
      activeLeases: leases,
      openPullRequests: ownership.openPullRequests ?? [],
    },
  };
  const queueEvidence = validateManagerQueueEvidence(queueEvidenceInput, { proposal });

  return {
    sourceSha,
    queueEvidence,
    quotaAdmission: {
      state: ['available', 'unavailable', 'ambiguous'].includes(quota.state) ? quota.state : 'ambiguous',
      profileName: profile.validation.profile,
    },
    implementationSlot: {
      // Carried through verbatim: flattening an ambiguous slot to a boolean is
      // exactly the fail-open the global-slot invariant forbids.
      state: nonEmptyString(slot.state) ? slot.state : (slot.occupied === true ? 'occupied' : 'ambiguous'),
      occupied: slot.state === 'occupied' || slot.occupied === true,
    },
    // Read back from the durable ledger, so duplicate-authority reconciliation
    // survives a restart instead of only holding within one pass.
    authorityLedger: { issued: [...issuedAuthorities] },
    execution: { ...plan.execution },
    producer: { type: MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER, domain: AUTHORITY_PRODUCER_DOMAIN, id: producerId },
    candidateRequests,
    // Not part of the role's collected evidence: retained so an issuance can be
    // pinned exactly. Stripped before the evidence reaches a handler.
    queueEvidenceInput,
  };
}

/** The role-visible evidence, with the pinning-only field removed. */
function programmeEvidenceForRole(built) {
  const { queueEvidenceInput, ...evidence } = built;
  return evidence;
}

/**
 * Build the pinned issuance record for one granted authority.
 *
 * It holds the *exact* inputs the accepted #267 transition consumed. Issuance
 * is a pure function of those inputs, so replaying them reproduces the identical
 * authority however far the live queue has since moved -- which reproduction
 * from current evidence cannot do, because the authority key depends on the
 * curation fingerprint and that changes with every queue edit.
 */
export function buildAuthorityIssuanceSnapshot(snapshot, built, authority) {
  const request = snapshot.candidateRequests.find((candidate) => candidate.branch === authority.branch) ?? null;
  if (!request) fail(`no candidate request reproduces the granted branch '${authority.branch}'`);
  return {
    schemaVersion: 1,
    projectId: snapshot.profile.projectId,
    evidenceInput: snapshot.planInputs.evidenceInput,
    briefInput: snapshot.planInputs.briefInput,
    proposalInput: snapshot.planInputs.proposalInput,
    queueEvidenceInput: built.queueEvidenceInput,
    request,
    execution: built.execution,
    producer: built.producer,
    quotaAdmission: built.quotaAdmission,
    currentSourceSha: built.sourceSha,
  };
}

/**
 * Replay a pinned issuance record back into the exact authority object.
 *
 * Every step runs through the same accepted validators the original issuance
 * used, so the rebuilt authority carries genuine provenance rather than being
 * a reconstructed look-alike. The caller checks the resulting key against the
 * ledger, so a snapshot that no longer reproduces its authority fails closed.
 */
export function rebuildAuthorityFromSnapshot({ snapshot, profile, expectedAuthorityKey }) {
  if (!isPlainObject(snapshot)) fail('the pinned issuance snapshot is unreadable');
  const evidence = validateManagerProjectEvidence(snapshot.evidenceInput, { profile });
  const brief = validateManagerProjectBrief(snapshot.briefInput, { evidence });
  const proposal = validateManagerPlanProposal(snapshot.proposalInput, { brief });
  const queueEvidence = validateManagerQueueEvidence(snapshot.queueEvidenceInput, { proposal });
  const curation = curateManagerQueue(queueEvidence);
  const issued = issueManagerWorkerAuthority({
    curation,
    execution: snapshot.execution,
    request: snapshot.request,
    currentSourceSha: snapshot.currentSourceSha,
    producer: snapshot.producer,
    quotaAdmission: snapshot.quotaAdmission,
    // Replay must never look like a fresh grant. The ledger is deliberately
    // empty here because the authority object is identical either way; the
    // caller proves it against the persisted ledger immediately below.
    ledger: { issued: [] },
  });
  if (nonEmptyString(expectedAuthorityKey) && issued.authority.authorityKey !== expectedAuthorityKey) {
    fail('the pinned issuance snapshot no longer reproduces its authority');
  }
  return issued.authority;
}

/**
 * Prove the returned attempt is the exact one the event named.
 *
 * Returns a bounded mismatch reason, or `null` when every identity the event
 * carried is reproduced by the evidence. This is what stops a wake for one pull
 * request quietly reconciling another.
 */
function attemptIdentityMismatch({ event, authority, attempt }) {
  const pullRequest = isPlainObject(attempt.pullRequest) ? attempt.pullRequest : null;
  if (event.pullRequestNumber != null) {
    if (!pullRequest || pullRequest.number !== event.pullRequestNumber) return 'pull-request-mismatch';
    if (attempt.publication && attempt.publication.pullRequestNumber != null
      && attempt.publication.pullRequestNumber !== event.pullRequestNumber) {
      return 'publication-pull-request-mismatch';
    }
  }
  if (attempt.issueNumber != null && attempt.issueNumber !== authority.issueNumber) {
    return 'issue-mismatch';
  }
  // A SHA on the event is the head that moved. It must be the head the evidence
  // was actually read at, or the checks and review below describe other code.
  if (event.sha != null && pullRequest) {
    const head = String(pullRequest.headSha ?? '').toLowerCase();
    if (head !== String(event.sha).toLowerCase()) return 'head-mismatch';
    if (attempt.ci && String(attempt.ci.headSha ?? '').toLowerCase() !== head) return 'check-head-mismatch';
    if (attempt.review && String(attempt.review.headSha ?? '').toLowerCase() !== head) return 'review-head-mismatch';
  }
  return null;
}

/** Collect the bounded execution evidence for one authorised attempt. */
export function collectExecutionEvidence({ event, adapters, controlStore, producerId, project, profile }) {
  const issueNumber = event.issueNumber ?? null;
  // Exact identity or nothing. Selecting the first issued authority would
  // reconcile an arbitrary historical attempt as soon as more than one exists,
  // so an execution event that cannot name its issue is refused outright rather
  // than resolved by guesswork.
  if (issueNumber === null) {
    return { noAuthorisedAttempt: true, reason: 'ambiguous-attempt-identity' };
  }
  const ledger = controlStore.listIssuedAuthorities({ projectId: profile.projectId });
  const live = ledger.filter((entry) => entry.issueNumber === issueNumber
    && (entry.state === 'issued' || entry.state === 'consumed'));
  // No live authority for this identity is a legitimate state, not a failure:
  // a shadow run never grants one, and a revoked or superseded grant leaves
  // stale execution events behind. Either way there is nothing to follow
  // through, so the role settles a harmless no-op rather than erroring.
  if (live.length === 0) {
    return { noAuthorisedAttempt: true, reason: 'no-issued-authority' };
  }
  // Two live authorities for one issue is a duplicate-grant defect that
  // assurance reports; execution must not pick one of them.
  if (live.length > 1) {
    return { noAuthorisedAttempt: true, reason: 'ambiguous-attempt-identity' };
  }
  const ledgerEntry = live[0];

  // Rebuilt from the pinned issuance inputs, then proven against the ledger.
  const issuance = controlStore.getAuthorityIssuance(ledgerEntry.authorityKey);
  if (!issuance) {
    return { noAuthorisedAttempt: true, reason: 'no-issued-authority' };
  }
  const authority = rebuildAuthorityFromSnapshot({
    snapshot: issuance.snapshot,
    profile,
    expectedAuthorityKey: ledgerEntry.authorityKey,
  });

  // Bind the exact pull request the event was raised for. A worker authority is
  // issued before any pull request exists, so the authority alone cannot name
  // one -- without this, a real pull-request/CI/review wake would read nothing
  // and settle a genuine transition as a harmless no-op.
  const attempt = adapters.readAttempt({
    project,
    profile,
    authority,
    pullRequestNumber: event.pullRequestNumber ?? null,
  });
  if (!isPlainObject(attempt)) {
    return { noAuthorisedAttempt: true, reason: 'no-attempt-evidence' };
  }
  // Whatever came back must be the exact attempt the event named. A different
  // pull request, issue or head is a mismatch, never a silent substitution.
  const mismatch = attemptIdentityMismatch({ event, authority, attempt });
  if (mismatch) {
    return { noAuthorisedAttempt: true, reason: 'attempt-identity-mismatch' };
  }
  if (!nonEmptyString(attempt.evidenceTimestamp) || !TIMESTAMP_PATTERN.test(attempt.evidenceTimestamp)) {
    fail('attempt evidence must carry an ISO-8601 UTC timestamp');
  }

  const settlementEvidence = validateManagerSettlementEvidence({
    schemaVersion: MANAGER_SETTLEMENT_EVIDENCE_SCHEMA_VERSION,
    authorityKey: authority.authorityKey,
    authorityFingerprint: authority.authorityFingerprint,
    attemptId: attempt.attemptId,
    projectId: authority.projectId,
    repository: repositoryParts(profile),
    issueNumber: authority.issueNumber,
    branch: authority.branch,
    baseSha: authority.baseSha,
    evidenceRevision: attempt.evidenceRevision,
    evidenceSequence: attempt.evidenceSequence,
    evidenceTimestamp: attempt.evidenceTimestamp,
    publication: attempt.publication ?? null,
    pullRequest: attempt.pullRequest ?? null,
    ci: attempt.ci ?? null,
    review: attempt.review ?? null,
  }, { authority });

  // A previously recorded settlement makes a replay an explicit no-op rather
  // than repeated work. It is re-derived from the previous evidence snapshot so
  // it carries real validator provenance.
  let previousSettlement = null;
  if (isPlainObject(attempt.previousEvidence)) {
    const previousEvidence = validateManagerSettlementEvidence({
      schemaVersion: MANAGER_SETTLEMENT_EVIDENCE_SCHEMA_VERSION,
      authorityKey: authority.authorityKey,
      authorityFingerprint: authority.authorityFingerprint,
      attemptId: attempt.previousEvidence.attemptId,
      projectId: authority.projectId,
      repository: repositoryParts(profile),
      issueNumber: authority.issueNumber,
      branch: authority.branch,
      baseSha: authority.baseSha,
      evidenceRevision: attempt.previousEvidence.evidenceRevision,
      evidenceSequence: attempt.previousEvidence.evidenceSequence,
      evidenceTimestamp: attempt.previousEvidence.evidenceTimestamp,
      publication: attempt.previousEvidence.publication ?? null,
      pullRequest: attempt.previousEvidence.pullRequest ?? null,
      ci: attempt.previousEvidence.ci ?? null,
      review: attempt.previousEvidence.review ?? null,
    }, { authority });
    previousSettlement = settleManagerLifecycle({ evidence: previousEvidence, previousSettlement: null });
  }

  const persisted = controlStore.getProjection(profile.projectId);
  return {
    authority,
    settlementEvidence,
    previousSettlement,
    ownership: attempt.ownership ?? { activeLeases: [], openPullRequests: [], workspace: null },
    continuationRequest: attempt.continuationRequest ?? null,
    producer: { type: MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER, domain: AUTHORITY_PRODUCER_DOMAIN, id: producerId },
    projectionContext: persisted ? persisted.payload : null,
  };
}

/**
 * Collect the bounded, read-only assurance observation.
 *
 * It is deliberately gathered independently rather than reusing the programme
 * or execution evidence: an auditor that reads the same derived state it is
 * auditing cannot detect a divergence in that state.
 */
export function collectAssuranceObservation({ project, profile, adapters, controlStore, expectedSourceSha = null }) {
  const sourceSha = String(adapters.readSourceSha({ project, profile }) ?? '').toLowerCase();
  if (!SHA_PATTERN.test(sourceSha)) fail('the current accepted source revision could not be read as an exact commit SHA');

  const rawIssues = adapters.listOpenIssues({ project, profile }) ?? [];
  const ownership = adapters.readOwnership({ project, profile }) ?? { activeLeases: [], openPullRequests: [] };
  const slot = adapters.readImplementationSlot({ project, profile }) ?? {};
  const hosts = adapters.readHosts() ?? {};
  const ledger = controlStore.listIssuedAuthorities({ projectId: profile.projectId });

  const issues = rawIssues.slice(0, 200).map((issue) => {
    const parsed = parseCuratedIssueBody(issue.body);
    return {
      number: issue.number,
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: Array.isArray(issue.labels) ? issue.labels : [],
      dependsOn: [...parsed.dependsOn],
    };
  });

  const readyLabel = profile.labels.ready ?? null;
  const readyWorkAvailable = readyLabel !== null
    && issues.some((issue) => issue.state === 'open' && issue.labels.includes(readyLabel));

  const checks = [];
  for (const pull of ownership.openPullRequests ?? []) {
    const attempt = adapters.readAttempt({ project, profile, pullRequestNumber: pull.number });
    if (!isPlainObject(attempt) || !isPlainObject(attempt.ci)) continue;
    for (const check of attempt.ci.checks ?? []) {
      checks.push({
        pullRequestNumber: pull.number,
        headSha: pull.headSha,
        checkedSha: attempt.ci.headSha,
        required: check.required === true,
      });
    }
  }

  return {
    projectId: profile.projectId,
    repository: profile.repository.full,
    registeredRepository: project.githubRepo,
    sourceSha,
    expectedSourceSha: expectedSourceSha ?? sourceSha,
    controllerHost: hosts.controllerHost ?? null,
    schedulerHost: hosts.schedulerHost ?? null,
    queue: {
      issues,
      readyLabel,
      inProgressLabel: profile.labels.inProgress ?? null,
    },
    ownership: {
      activeLeases: ownership.activeLeases ?? [],
      openPullRequests: ownership.openPullRequests ?? [],
    },
    authorities: ledger.map((entry) => ({
      authorityKey: entry.authorityKey,
      issueNumber: entry.issueNumber,
      baseSha: entry.baseSha,
      state: entry.state,
    })),
    checks,
    completions: [],
    capacity: { implementationSlotOccupied: slot.occupied === true, readyWorkAvailable },
    // Admission is quota headroom only; the auditor states the observed policy
    // rather than inferring it.
    quotaPolicy: { admissionSignals: ['quota'], forbiddenSignalsObserved: [] },
    security: { boundaryViolations: [] },
    projectionContext: controlStore.getProjection(profile.projectId)?.payload ?? null,
  };
}

/**
 * Build the production `resolvePorts` factory the controller calls.
 *
 * Mutating ports are wired only in `active` mode and only for the role that
 * owns them; in every other mode they are simply absent, which is what makes
 * shadow structurally incapable of mutating rather than merely disinclined to.
 */
export function createProductionManagementPorts({
  adapters,
  writeAdapters = null,
  controlStore,
  profileRegistry = undefined,
  planEntries = undefined,
  producerId = 'dell-build-manager',
  expectedSourceSha = null,
  now = () => new Date().toISOString(),
} = {}) {
  assertAdapters(adapters);
  if (!(controlStore instanceof ManagementControlStore)) fail('a ManagementControlStore is required');

  return async function resolvePorts({ role, event, mode, project }) {
    const profile = resolveRegisteredManagerProfile({
      projectId: event.projectId,
      repository: event.repository,
      ...(profileRegistry ? { registry: profileRegistry } : {}),
    });
    if (!profile.enabled) fail(`registered manager profile '${profile.projectId}' is disabled`);
    const plan = resolveRegisteredManagementPlan({
      projectId: event.projectId,
      profile,
      ...(planEntries ? { entries: planEntries } : {}),
    });
    if (!plan) fail(`no management plan is registered for project '${event.projectId}'`);
    const timestamp = typeof now === 'function' ? now() : now;
    const mutating = mode === 'active';

    if (role === 'assurance') {
      // Read-only by construction: no mutating port is even constructed here.
      return {
        collectEvidence: () => collectAssuranceObservation({
          project, profile, adapters, controlStore, expectedSourceSha,
        }),
      };
    }

    const snapshot = collectProgrammeSnapshot({
      project, profile, plan, adapters, controlStore, producerId, now: timestamp,
    });
    const built = buildProgrammeEvidence(snapshot);
    const programme = programmeEvidenceForRole(built);

    if (role === 'programme') {
      const ports = { collectEvidence: () => programme };
      if (mutating) {
        assertWriteAdapters(writeAdapters);
        ports.applyQueueMutation = () => writeAdapters.createQueueMutationClient({ repository: profile.repository.full });
        ports.publishWorkerAuthority = ({ authority }) => {
          // Pin the exact issuance inputs first: an announced authority that
          // could never be rebuilt would strand its own attempt.
          controlStore.recordAuthorityIssuance({
            authorityKey: authority.authorityKey,
            projectId: authority.projectId,
            issueNumber: authority.issueNumber,
            snapshot: buildAuthorityIssuanceSnapshot(snapshot, built, authority),
            now: timestamp,
          });
          // Durably record the grant before announcing it, so a crash can never
          // leave an announced authority absent from the ledger.
          controlStore.recordIssuedAuthority({
            authorityKey: authority.authorityKey,
            authorityFingerprint: authority.authorityFingerprint,
            projectId: authority.projectId,
            repository: authority.repository.full,
            issueNumber: authority.issueNumber,
            branch: authority.branch,
            baseSha: authority.baseSha,
            state: 'issued',
            now: timestamp,
          });
          // Reconciled, not fire-and-forget: an interrupted publication stays
          // pending and resumes on the next reconciliation.
          return ensureWorkerAuthorityPublished({
            controlStore, transport: writeAdapters, authority, now: timestamp,
          });
        };
      }
      return ports;
    }

    if (role === 'execution') {
      const ports = {
        collectEvidence: () => collectExecutionEvidence({
          event, adapters, controlStore, producerId, project, profile,
        }),
      };
      if (mutating) {
        assertWriteAdapters(writeAdapters);
        ports.publishContinuationAuthority = ({ continuation }) => ensureContinuationPublished({
          controlStore, transport: writeAdapters, continuation, now: timestamp,
        });
      }
      return ports;
    }

    return fail(`unknown management role: ${String(role)}`);
  };
}
