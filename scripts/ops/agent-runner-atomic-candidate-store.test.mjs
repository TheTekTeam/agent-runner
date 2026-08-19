import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CandidateAdmissionPausedError,
  CandidateRevalidationUnavailableError,
  createAtomicAdmissionStore,
  runAtomicCandidateRevalidation,
  snapshotFromSelectionRecord,
} from './agent-runner-atomic-candidate-store.mjs';
import {
  evaluateCandidateAdmission,
  normalizeCandidateSnapshot,
} from './agent-runner-candidate-admission.mjs';

function fakeStore() {
  const calls = [];
  return {
    calls,
    recordIssueSelection(value) { calls.push(['selection', value]); },
    recordRecoveryAttempt(value) { calls.push(['attempt', value]); },
    recordQueueEvent(value) { calls.push(['queue', value]); },
    openHealthCondition(value) { calls.push(['health', value]); },
  };
}

const managerRevision = 'AR5-ATOMIC-CANARY-2026-07-25.1';
const managerFingerprint = `sha256:${'a'.repeat(64)}`;
const managerBodyDigest = `sha256:${'b'.repeat(64)}`;
const managerAuthorityKey = `manager-preflight:${managerRevision}:${managerFingerprint}`;

const selectionRecord = {
  issueNumber: 5,
  statusLabel: 'status:ready',
  selectionMode: 'preflight-direct',
  commandKind: null,
  sourceCommentIdentity: null,
  sourcePreflightCommentIdentity: { databaseId: 100 },
  sourcePreflightCommentId: 'github-comment:database-id:100',
  payload: {
    selectedIssue: 5,
    selectedStatusLabel: 'status:ready',
    selectionMode: 'preflight-direct',
    selectedCommandKind: null,
    sourceCommentIdentity: null,
    sourcePreflightCommentIdentity: { databaseId: 100 },
    sourcePreflightCommentId: 'github-comment:database-id:100',
    sourcePreflightRevision: managerRevision,
    sourcePreflightFingerprint: managerFingerprint,
    sourcePreflightBodyDigest: managerBodyDigest,
    sourcePreflightAuthorityKey: managerAuthorityKey,
    sourcePreflightAuthor: 'gpcola',
    // Issue #189: a combined/alias execution label (the outer scheduler
    // selection resolved this deterministically to `claude-code-cli`) --
    // the literal label and the resolved adapter id must both survive the
    // round-trip through `snapshotFromSelectionRecord()` distinctly.
    selectedAgentLabel: 'agent:codex-claude',
    agent: { agentId: 'claude-code-cli' },
  },
};

const initialAttempt = {
  phase: 'starting',
  resolutionState: 'active',
  finishedAt: null,
  attemptId: 'TheTekTeam/agent-runner#5:now',
};

function revalidateExpected(expected, mutateCurrent = (value) => value) {
  const initial = normalizeCandidateSnapshot(expected);
  const current = normalizeCandidateSnapshot(mutateCurrent(structuredClone(expected)));
  return {
    admission: evaluateCandidateAdmission({ initial, current, approvers: ['gpcola'] }),
    initial,
    current,
  };
}

test('selection record becomes the expected scheduler authority snapshot', () => {
  assert.deepEqual(snapshotFromSelectionRecord(selectionRecord), {
    issueNumber: 5,
    statusLabel: 'status:ready',
    agentLabel: 'agent:codex-claude',
    resolvedAgentId: 'claude-code-cli',
    selectionMode: 'preflight-direct',
    commandKind: null,
    commandIdentity: null,
    commandRevision: null,
    preflightIdentity: { databaseId: 100 },
    preflightRevision: managerRevision,
    preflightFingerprint: managerFingerprint,
    preflightAuthorityKey: managerAuthorityKey,
    preflightBodyDigest: managerBodyDigest,
    preflightPacketValid: true,
    preflightPacketReason: null,
    preflightApprovedAgent: 'claude-code-cli',
    preflightCommentRevision: 'github-comment:database-id:100',
    preflightAuthor: 'gpcola',
  });
});

test('stable canonical authority permits the initial attempt insert', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const store = createAtomicAdmissionStore(raw, {
    pauseState,
    revalidate: ({ expected }) => revalidateExpected(expected),
  });
  store.recordIssueSelection(selectionRecord);
  store.recordRecoveryAttempt(initialAttempt);
  assert.equal(pauseState.result, null);
  assert.equal(raw.calls.filter(([kind]) => kind === 'attempt').length, 1);
});

test('changed authority key refuses attempt persistence before claim or child launch', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const store = createAtomicAdmissionStore(raw, {
    pauseState,
    revalidate: ({ expected }) => revalidateExpected(expected, (current) => ({
      ...current,
      preflightAuthorityKey: `${current.preflightAuthorityKey}:changed`,
    })),
  });
  store.recordIssueSelection(selectionRecord);
  assert.throws(() => store.recordRecoveryAttempt(initialAttempt), CandidateAdmissionPausedError);
  assert.equal(raw.calls.filter(([kind]) => kind === 'attempt').length, 0);
  assert.equal(pauseState.result.admission.reason, 'candidate-preflight-revision-changed');
});

test('changed packet body digest refuses attempt persistence before claim or child launch', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const store = createAtomicAdmissionStore(raw, {
    pauseState,
    revalidate: ({ expected }) => revalidateExpected(expected, (current) => ({
      ...current,
      preflightBodyDigest: `sha256:${'c'.repeat(64)}`,
    })),
  });
  store.recordIssueSelection(selectionRecord);
  assert.throws(() => store.recordRecoveryAttempt(initialAttempt), CandidateAdmissionPausedError);
  assert.equal(raw.calls.filter(([kind]) => kind === 'attempt').length, 0);
  assert.equal(pauseState.result.admission.reason, 'candidate-preflight-content-changed');
});

test('invalid current packet refuses attempt persistence before claim or child launch', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const store = createAtomicAdmissionStore(raw, {
    pauseState,
    revalidate: ({ expected }) => revalidateExpected(expected, (current) => ({
      ...current,
      preflightPacketValid: false,
      preflightPacketReason: 'manager-preflight-invalid',
    })),
  });
  store.recordIssueSelection(selectionRecord);
  assert.throws(() => store.recordRecoveryAttempt(initialAttempt), CandidateAdmissionPausedError);
  assert.equal(raw.calls.filter(([kind]) => kind === 'attempt').length, 0);
  assert.equal(pauseState.result.admission.reason, 'manager-preflight-invalid');
});

test('wrong packet-approved agent refuses attempt persistence before claim or child launch', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const store = createAtomicAdmissionStore(raw, {
    pauseState,
    revalidate: ({ expected }) => revalidateExpected(expected, (current) => ({
      ...current,
      preflightApprovedAgent: 'codex-web',
    })),
  });
  store.recordIssueSelection(selectionRecord);
  assert.throws(() => store.recordRecoveryAttempt(initialAttempt), CandidateAdmissionPausedError);
  assert.equal(raw.calls.filter(([kind]) => kind === 'attempt').length, 0);
  assert.equal(pauseState.result.admission.reason, 'candidate-preflight-agent-not-approved');
});

test('comment identity remains evidence separate from canonical packet authority', () => {
  const snapshot = snapshotFromSelectionRecord(selectionRecord);
  assert.deepEqual(snapshot.preflightIdentity, { databaseId: 100 });
  assert.equal(snapshot.preflightCommentRevision, 'github-comment:database-id:100');
  assert.equal(snapshot.preflightRevision, managerRevision);
  assert.equal(snapshot.preflightAuthorityKey, managerAuthorityKey);
  assert.notEqual(snapshot.preflightCommentRevision, snapshot.preflightRevision);
});

test('stale candidate refuses attempt persistence before claim or child launch', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const current = { ...snapshotFromSelectionRecord(selectionRecord), preflightAuthorityKey: `${managerAuthorityKey}:stale` };
  const store = createAtomicAdmissionStore(raw, {
    pauseState,
    revalidate: ({ expected }) => ({
      admission: { allowed: false, reason: 'candidate-preflight-revision-changed' },
      initial: expected,
      current,
    }),
  });
  store.recordIssueSelection(selectionRecord);
  assert.throws(() => store.recordRecoveryAttempt(initialAttempt), CandidateAdmissionPausedError);
  assert.equal(raw.calls.filter(([kind]) => kind === 'attempt').length, 0);
  assert.equal(pauseState.result.admission.reason, 'candidate-preflight-revision-changed');
});

test('a broken revalidation subprocess stashes the real failure on pauseState and still fails closed (does not become a handled candidate denial)', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const failure = new CandidateRevalidationUnavailableError(
    "atomic candidate revalidation failed with exit 1: Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'claude-runner-cron-base.mjs'",
    { missingModule: true },
  );
  const store = createAtomicAdmissionStore(raw, {
    pauseState,
    revalidate: () => { throw failure; },
  });
  store.recordIssueSelection(selectionRecord);
  assert.throws(() => store.recordRecoveryAttempt(initialAttempt), CandidateRevalidationUnavailableError);
  assert.equal(raw.calls.filter(([kind]) => kind === 'attempt').length, 0, 'the attempt must never be persisted');
  assert.equal(pauseState.result, null, 'this is not a candidate-admission denial');
  assert.equal(pauseState.revalidationFailure, failure);
  assert.equal(pauseState.revalidationFailure.missingModule, true);
});

test('candidate pause is audited without opening systemic health', () => {
  const raw = fakeStore();
  const pauseState = {
    result: {
      admission: { allowed: false, reason: 'candidate-status-changed' },
      current: { issueNumber: 5, preflightRevision: managerRevision },
    },
  };
  const store = createAtomicAdmissionStore(raw, { pauseState });
  store.recordQueueEvent({ eventType: 'systemic-pause', reason: 'runner_state_unavailable', payload: {} });
  store.openHealthCondition({ conditionType: 'systemic_pause' });
  const queue = raw.calls.find(([kind]) => kind === 'queue')?.[1];
  assert.equal(queue.eventType, 'candidate-admission-paused');
  assert.equal(queue.reason, 'candidate-status-changed');
  assert.equal(queue.payload.attemptCreated, false);
  assert.equal(raw.calls.some(([kind]) => kind === 'health'), false);
});

test('candidate-specific machine_profile model refusal detected during atomic revalidation refuses attempt persistence with the exact typed scope', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const fingerprint = `sha256:${'f'.repeat(64)}`;
  const store = createAtomicAdmissionStore(raw, {
    pauseState,
    revalidate: ({ expected }) => ({
      admission: {
        allowed: false,
        scope: 'machine_profile',
        reason: 'candidate-machine-profile-cost-denied',
        violations: ['opus-requires-explicit-machine-opt-in'],
        safeNextAction: 'A changed manager intent/profile requires a fresh superseding immutable manager-preflight authority.',
        effectiveFingerprint: fingerprint,
        occurrenceCount: 1,
      },
      initial: expected,
      current: snapshotFromSelectionRecord(selectionRecord),
    }),
  });
  store.recordIssueSelection(selectionRecord);
  assert.throws(() => store.recordRecoveryAttempt(initialAttempt), CandidateAdmissionPausedError);
  assert.equal(raw.calls.filter(([kind]) => kind === 'attempt').length, 0, 'a candidate-specific profile refusal must write no attempt row');
  assert.equal(pauseState.result.admission.scope, 'machine_profile');

  store.recordQueueEvent({ eventType: 'systemic-pause', reason: 'runner_state_unavailable', payload: {} });
  const queue = raw.calls.find(([kind]) => kind === 'queue')?.[1];
  assert.equal(queue.eventType, 'candidate-admission-paused');
  assert.equal(queue.payload.failureScope, 'machine_profile');
  assert.equal(queue.payload.candidateEffectiveFingerprint, fingerprint);
  assert.equal(queue.payload.attemptCreated, false);
  assert.equal(queue.payload.childLaunched, false);
  assert.equal(queue.payload.issueMutation, false);
  assert.equal(raw.calls.some(([kind]) => kind === 'health'), false, 'a candidate-specific refusal must not open a systemic health condition');
});

test('standalone atomic scheduler adapter wraps the immutable imported scheduler', () => {
  const source = readFileSync(new URL('./agent-runner-atomic-cron.mjs', import.meta.url), 'utf8');
  assert.match(source, /createAtomicAdmissionStore/);
  assert.match(source, /admissionBoundary: 'recordRecoveryAttempt'/);
  assert.match(source, /schedulerMain\(argv, env/);
  assert.match(source, /from '\.\/claude-runner-cron\.mjs'/);
});

test('atomic revalidation source no longer references the removed claude-runner-cron-base.mjs module', () => {
  const source = readFileSync(new URL('./agent-runner-atomic-candidate-store.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /claude-runner-cron-base/);
  assert.match(source, /new URL\('\.\/claude-runner-cron\.mjs', import\.meta\.url\)/);
});

test('the module the atomic revalidation subprocess is pointed at actually resolves and exports the scheduler surface', async () => {
  const baseModule = new URL('./claude-runner-cron.mjs', import.meta.url);
  const cron = await import(baseModule.href);
  assert.equal(typeof cron.parseArgs, 'function');
  assert.equal(typeof cron.selectIssue, 'function');
});

test('runAtomicCandidateRevalidation classifies a missing-module subprocess crash without misreporting it as a state-store failure', () => {
  assert.throws(
    () => runAtomicCandidateRevalidation({
      expected: { issueNumber: 686 },
      spawn: () => ({
        status: 1,
        signal: null,
        error: null,
        stdout: '',
        stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module "
          + "'/home/gp/projects/agent-runner/scripts/ops/claude-runner-cron-base.mjs' imported from "
          + "'/home/gp/projects/agent-runner/scripts/ops/agent-runner-candidate-admission.mjs'",
      }),
    }),
    (error) => {
      assert.ok(error instanceof CandidateRevalidationUnavailableError);
      assert.equal(error.code, 'CANDIDATE_REVALIDATION_MODULE_NOT_FOUND');
      assert.equal(error.missingModule, true);
      return true;
    },
  );
});

test('runAtomicCandidateRevalidation classifies a non-module subprocess crash as candidate-revalidation-unavailable, not missing-module', () => {
  assert.throws(
    () => runAtomicCandidateRevalidation({
      expected: { issueNumber: 686 },
      spawn: () => ({ status: 1, signal: null, error: null, stdout: '', stderr: 'TypeError: boom' }),
    }),
    (error) => {
      assert.ok(error instanceof CandidateRevalidationUnavailableError);
      assert.equal(error.code, 'CANDIDATE_REVALIDATION_UNAVAILABLE');
      assert.equal(error.missingModule, false);
      return true;
    },
  );
});

test('runAtomicCandidateRevalidation classifies a spawn-start failure by the underlying module error code', () => {
  const spawnError = new Error("Cannot find module 'agent-runner-candidate-admission.mjs'");
  spawnError.code = 'ERR_MODULE_NOT_FOUND';
  assert.throws(
    () => runAtomicCandidateRevalidation({
      expected: { issueNumber: 686 },
      spawn: () => ({ status: null, signal: null, error: spawnError, stdout: '', stderr: '' }),
    }),
    (error) => {
      assert.ok(error instanceof CandidateRevalidationUnavailableError);
      assert.equal(error.missingModule, true);
      return true;
    },
  );
});
