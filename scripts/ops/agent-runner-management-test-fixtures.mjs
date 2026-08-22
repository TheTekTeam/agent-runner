#!/usr/bin/env node

/**
 * #268: deterministic test-support fixtures for the event-driven management
 * control plane. This module is not part of the runtime path: it builds the
 * registry, stores, collected evidence and port wiring the focused tests need,
 * reusing the same accepted #261/#266/#267 transitions production callers use.
 * It performs no GitHub call, no provider invocation and no mutation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openManagementStores } from './agent-runner-management-control-store.mjs';
import {
  ATTEMPT_ID,
  HEAD_SHA,
  IMPLEMENTATION_BRANCH,
  NEXT_HEAD_SHA,
  PULL_REQUEST_NUMBER,
  READY_CURATION_KEY,
  READY_ISSUE_NUMBER,
  SOURCE_SHA,
  buildAuthority,
  buildCuration,
  buildEvidence as buildSettlementEvidence,
  ciInput,
  executionInput,
  producer,
  publicationInput,
  pullRequestInput,
  readyIssue,
  requestInput,
  reviewInput,
} from './agent-runner-manager-authority-review-test-fixtures.mjs';
import { LABELS, buildChain, buildQueueEvidence } from './agent-runner-manager-queue-test-fixtures.mjs';
import { curateManagerQueue } from './agent-runner-manager-queue-curator.mjs';

export {
  ATTEMPT_ID,
  HEAD_SHA,
  IMPLEMENTATION_BRANCH,
  LABELS,
  NEXT_HEAD_SHA,
  PULL_REQUEST_NUMBER,
  READY_CURATION_KEY,
  READY_ISSUE_NUMBER,
  SOURCE_SHA,
  buildAuthority,
  buildCuration,
  buildSettlementEvidence,
  ciInput,
  executionInput,
  producer,
  publicationInput,
  pullRequestInput,
  readyIssue,
  requestInput,
  reviewInput,
};

/**
 * Build a curation from a freshly derived plan chain so a test can vary the
 * proposal (for example to introduce a plan escalation) rather than reusing the
 * single shared proposal the #267 fixtures expose.
 */
export function curationWith({ proposalOverrides = {}, issues = [readyIssue()], ...queueOverrides } = {}) {
  const { proposal } = buildChain({ proposalOverrides });
  return curateManagerQueue(buildQueueEvidence(proposal, { issues, ...queueOverrides }));
}

export const PROJECT_ID = 'fixture-project';
export const REPOSITORY = 'FixtureOrg/fixture-repo';
export const SECOND_PROJECT_ID = 'second-project';
export const SECOND_REPOSITORY = 'FixtureOrg/second-repo';
export const CONTROLLER_ID = 'dell-management-controller';
export const CLAIM_TOKEN = 'management-claim-token-1';

export const T0 = '2026-08-21T20:00:00.000Z';
export const T1 = '2026-08-21T20:01:00.000Z';
export const T2 = '2026-08-21T20:02:00.000Z';

const FIXTURE_PROJECT = Object.freeze({ projectId: PROJECT_ID, githubRepo: REPOSITORY });
const SECOND_PROJECT = Object.freeze({ projectId: SECOND_PROJECT_ID, githubRepo: SECOND_REPOSITORY });

/**
 * Two explicitly registered projects. The second exists so acceptance can prove
 * the control plane is project-neutral rather than shaped around one repository.
 */
export const REGISTRY = Object.freeze({
  projectsById: Object.freeze({ [PROJECT_ID]: FIXTURE_PROJECT, [SECOND_PROJECT_ID]: SECOND_PROJECT }),
  projectsByRepository: Object.freeze({
    'fixtureorg/fixture-repo': FIXTURE_PROJECT,
    'fixtureorg/second-repo': SECOND_PROJECT,
  }),
});

/**
 * Open one temporary controller database shared by both stores, as production
 * does. The callback is awaited so an asynchronous controller cycle completes
 * before the connections close.
 */
export async function withStores(fn, { now = () => T0, maxAttempts = 5, dbPath: suppliedPath = null, dir: suppliedDir = null } = {}) {
  const dir = suppliedDir ?? (suppliedPath ? null : mkdtempSync(join(tmpdir(), 'agent-runner-management-')));
  const dbPath = suppliedPath ?? join(dir, 'runner-state.sqlite');
  // The same shared-connection helper production uses, so the durable producer
  // dedupe transaction is exercised by the tests rather than only in production.
  const stores = openManagementStores(dbPath, { registry: REGISTRY, now, maxAttempts });
  try {
    return await fn({ eventStore: stores.eventStore, controlStore: stores.controlStore, dbPath, dir });
  } finally {
    stores.close();
    // A caller that supplied its own directory owns its lifetime: leaving it in
    // place is what lets a restart-recovery test reopen the same database.
    if (dir && !suppliedDir && !suppliedPath) rmSync(dir, { recursive: true, force: true });
  }
}

/** A durable temporary directory a restart test can reopen. */
export function makeStateDir() {
  return mkdtempSync(join(tmpdir(), 'agent-runner-management-restart-'));
}

export function removeStateDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function managementEvent(overrides = {}) {
  return {
    eventType: 'programme-reconcile-required',
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    correlationId: 'fixture-correlation-1',
    ...overrides,
  };
}

/**
 * Bounded programme evidence: a curated queue with one ready record, a free
 * global implementation slot and available quota headroom.
 */
export function programmeEvidence(overrides = {}) {
  const curation = overrides.curation ?? buildCuration();
  const { curation: _ignored, ...rest } = overrides;
  return {
    sourceSha: SOURCE_SHA,
    queueEvidence: curation.queueEvidence,
    quotaAdmission: { state: 'available', profileName: 'complex' },
    implementationSlot: { occupied: false },
    authorityLedger: { issued: [] },
    execution: executionInput(),
    producer: producer(),
    candidateRequests: [requestInput()],
    ...rest,
  };
}

/** Bounded execution evidence bound to one issued authority. */
export function executionEvidence(overrides = {}) {
  const authority = overrides.authority ?? buildAuthority();
  const settlementEvidence = overrides.settlementEvidence ?? buildSettlementEvidence(authority);
  const { authority: _a, settlementEvidence: _s, ...rest } = overrides;
  return {
    authority,
    settlementEvidence,
    previousSettlement: null,
    ownership: { activeLeases: [], openPullRequests: [], workspace: null },
    continuationRequest: null,
    producer: producer(),
    ...rest,
  };
}

/** A clean read-only assurance observation: nothing is wrong. */
export function assuranceObservation(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    registeredRepository: REPOSITORY,
    sourceSha: SOURCE_SHA,
    expectedSourceSha: SOURCE_SHA,
    controllerHost: 'dell',
    schedulerHost: 'dell',
    queue: {
      issues: [{ number: READY_ISSUE_NUMBER, state: 'open', labels: [], dependsOn: [] }],
      readyLabel: LABELS.ready,
      inProgressLabel: LABELS.inProgress,
    },
    ownership: { activeLeases: [], openPullRequests: [] },
    authorities: [],
    checks: [],
    completions: [],
    capacity: { implementationSlotOccupied: false, readyWorkAvailable: false },
    quotaPolicy: { admissionSignals: ['quota'], forbiddenSignalsObserved: [] },
    security: { boundaryViolations: [] },
    ...overrides,
  };
}

/**
 * A recording queue-mutation client implementing the accepted #266 client port.
 * `createIssue` must return a real issue number or the mutation boundary
 * refuses the operation as unverifiable.
 */
export function recordingQueueMutationClient(applied = [], { firstCreatedNumber = 900 } = {}) {
  let next = firstCreatedNumber;
  return {
    applied,
    createIssue(request) {
      applied.push({ kind: 'create-issue', curationKey: request.curationKey });
      next += 1;
      return { number: next };
    },
    updateIssueLabels(request) {
      applied.push({ kind: 'update-labels', issueNumber: request.issueNumber });
      return { ok: true };
    },
    updateIssueDependencies(request) {
      applied.push({ kind: 'update-dependencies', issueNumber: request.issueNumber });
      return { ok: true };
    },
  };
}

/**
 * Build a `resolvePorts` factory for the controller.
 *
 * `calls` records every mutating port invocation so a test can assert that
 * shadow mode suppressed it and active mode performed it.
 */
export function portFactory({
  programme = programmeEvidence(),
  execution = executionEvidence(),
  assurance = assuranceObservation(),
  calls = { queueMutation: [], workerAuthority: [], continuation: [], appliedOperations: [] },
  queueMutationClient = null,
} = {}) {
  const client = queueMutationClient ?? recordingQueueMutationClient(calls.appliedOperations ?? []);
  const evidenceByRole = { programme, execution, assurance };
  const resolvePorts = ({ role }) => {
    const ports = { collectEvidence: () => evidenceByRole[role] };
    if (role === 'programme') {
      ports.applyQueueMutation = () => {
        calls.queueMutation.push('client-requested');
        return client;
      };
      ports.publishWorkerAuthority = ({ authority }) => {
        calls.workerAuthority.push(authority.authorityKey);
      };
    }
    if (role === 'execution') {
      ports.publishContinuationAuthority = ({ continuation }) => {
        calls.continuation.push(continuation.continuationAuthorityKey);
      };
    }
    return ports;
  };
  return { resolvePorts, calls };
}

/** Enable one control mode for the fixture scope. */
export function setMode(controlStore, mode, { scope = 'global', now = T0 } = {}) {
  return controlStore.setControlMode({
    scope,
    mode,
    reason: 'fixture acceptance run',
    actor: 'fixture-operator',
    now,
  });
}
