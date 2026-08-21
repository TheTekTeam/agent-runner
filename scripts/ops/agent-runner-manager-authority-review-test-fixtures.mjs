#!/usr/bin/env node

/**
 * #267: deterministic test-support fixtures for the authority/settlement
 * family. This module is not part of the runtime path: it only builds the
 * validated curation -> authority -> evidence chain the focused tests need,
 * using the same public transitions production callers use. It performs no
 * GitHub call, no provider invocation and no mutation.
 */

import { curateManagerQueue } from './agent-runner-manager-queue-curator.mjs';
import {
  LABELS,
  SOURCE_SHA,
  buildChain,
  buildQueueEvidence,
} from './agent-runner-manager-queue-test-fixtures.mjs';
import { MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER } from './agent-runner-manager-authority.mjs';
import {
  AUTHORITY_PRODUCER_DOMAIN,
  issueManagerWorkerAuthority,
} from './agent-runner-manager-worker-authority.mjs';
import {
  MANAGER_SETTLEMENT_EVIDENCE_SCHEMA_VERSION,
  validateManagerSettlementEvidence,
} from './agent-runner-manager-settlement-evidence.mjs';

export { LABELS, SOURCE_SHA };

export const READY_CURATION_KEY = 'qc:fixture-project:evidence-contract';
export const READY_ISSUE_NUMBER = 501;
export const OTHER_ISSUE_NUMBER = 502;
export const IMPLEMENTATION_BRANCH = 'agent/fixture-evidence-contract-501';
export const PULL_REQUEST_NUMBER = 42;
export const HEAD_SHA = 'd'.repeat(40);
export const NEXT_HEAD_SHA = 'e'.repeat(40);
export const ATTEMPT_ID = 'attempt-501-1';
export const PRODUCER_ID = 'build-manager-fixture';
export const CONSUMER_ID = 'worker-fixture';

const { proposal } = buildChain();

/**
 * One open, unlabelled, unowned issue carrying the ready record's curation
 * key. `evidence-contract` belongs to the dependency-free `foundation`
 * milestone, so the curated record resolves to `ready` with no protection.
 */
export function readyIssue(overrides = {}) {
  return {
    number: READY_ISSUE_NUMBER,
    title: 'Bounded queue evidence contract',
    state: 'open',
    labels: [],
    curationKey: READY_CURATION_KEY,
    ...overrides,
  };
}

export function buildCuration({ issues = [readyIssue()], ...rest } = {}) {
  return curateManagerQueue(buildQueueEvidence(proposal, { issues, ...rest }));
}

export function producer(overrides = {}) {
  return {
    type: MANAGER_PREFLIGHT_BUILD_MANAGER_PRODUCER,
    domain: AUTHORITY_PRODUCER_DOMAIN,
    id: PRODUCER_ID,
    ...overrides,
  };
}

export function executionInput(overrides = {}) {
  return {
    adapter: 'fixture-adapter',
    capabilityProfile: 'complex',
    model: 'fixture-model',
    effort: 'high',
    ...overrides,
  };
}

export function requestInput(overrides = {}) {
  return {
    curationKey: READY_CURATION_KEY,
    branch: IMPLEMENTATION_BRANCH,
    scope: ['Implement the bounded evidence contract and its focused tests.'],
    stopConditions: ['Stop and report if the accepted base commit changes.'],
    ...overrides,
  };
}

export function authorityInput(overrides = {}) {
  const { curation = buildCuration(), ...rest } = overrides;
  return {
    curation,
    execution: executionInput(),
    request: requestInput(),
    currentSourceSha: SOURCE_SHA,
    producer: producer(),
    quotaAdmission: { state: 'available', profileName: 'complex' },
    ledger: { issued: [] },
    ...rest,
  };
}

export function buildAuthority(overrides = {}) {
  return issueManagerWorkerAuthority(authorityInput(overrides)).authority;
}

export function publicationInput(overrides = {}) {
  return {
    attemptId: ATTEMPT_ID,
    headSha: HEAD_SHA,
    completionState: 'published',
    pullRequestNumber: PULL_REQUEST_NUMBER,
    changedFileCount: 2,
    changedPaths: ['scripts/ops/fixture-module.mjs', 'scripts/ops/fixture-module.test.mjs'],
    insertions: 120,
    deletions: 4,
    validationChecks: [{ name: 'npm test', state: 'success' }],
    summary: 'Bounded evidence contract implemented with focused tests.',
    ...overrides,
  };
}

export function pullRequestInput(overrides = {}) {
  return {
    number: PULL_REQUEST_NUMBER,
    branch: IMPLEMENTATION_BRANCH,
    baseSha: SOURCE_SHA,
    headSha: HEAD_SHA,
    state: 'open',
    draft: true,
    mergeableState: 'clean',
    changedFileCount: 2,
    changedPaths: ['scripts/ops/fixture-module.mjs', 'scripts/ops/fixture-module.test.mjs'],
    ...overrides,
  };
}

export function ciInput(overrides = {}) {
  return {
    headSha: HEAD_SHA,
    checks: [
      { name: 'validate', state: 'success', required: true },
      { name: 'advisory-lint', state: 'failure', required: false },
    ],
    ...overrides,
  };
}

export function reviewInput(overrides = {}) {
  return {
    pullRequestNumber: PULL_REQUEST_NUMBER,
    headSha: HEAD_SHA,
    state: 'no-blockers',
    findings: [],
    ...overrides,
  };
}

export function evidenceInput(authority, overrides = {}) {
  return {
    schemaVersion: MANAGER_SETTLEMENT_EVIDENCE_SCHEMA_VERSION,
    authorityKey: authority.authorityKey,
    authorityFingerprint: authority.authorityFingerprint,
    attemptId: ATTEMPT_ID,
    projectId: authority.projectId,
    repository: { owner: authority.repository.owner, name: authority.repository.name },
    issueNumber: authority.issueNumber,
    branch: authority.branch,
    baseSha: authority.baseSha,
    evidenceRevision: 'settlement-2026-08-21.1',
    evidenceSequence: 1,
    evidenceTimestamp: '2026-08-21T01:00:00Z',
    publication: publicationInput(),
    pullRequest: pullRequestInput(),
    ci: ciInput(),
    review: reviewInput(),
    ...overrides,
  };
}

export function buildEvidence(authority, overrides = {}) {
  return validateManagerSettlementEvidence(evidenceInput(authority, overrides), { authority });
}
