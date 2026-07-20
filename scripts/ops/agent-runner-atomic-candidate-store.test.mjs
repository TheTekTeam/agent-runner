import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CandidateAdmissionPausedError,
  createAtomicAdmissionStore,
  snapshotFromSelectionRecord,
} from './agent-runner-atomic-candidate-store.mjs';

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
    agent: { agentId: 'claude' },
  },
};

const initialAttempt = {
  phase: 'starting',
  resolutionState: 'active',
  finishedAt: null,
  attemptId: 'TheTekTeam/agent-runner#5:now',
};

test('selection record becomes the expected scheduler authority snapshot', () => {
  assert.deepEqual(snapshotFromSelectionRecord(selectionRecord), {
    issueNumber: 5,
    statusLabel: 'status:ready',
    agentLabel: 'agent:claude',
    selectionMode: 'preflight-direct',
    commandKind: null,
    commandIdentity: null,
    commandRevision: null,
    preflightIdentity: { databaseId: 100 },
    preflightRevision: 'github-comment:database-id:100',
    preflightAuthor: null,
  });
});

test('stable candidate permits the initial attempt insert', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const store = createAtomicAdmissionStore(raw, {
    pauseState,
    revalidate: ({ expected }) => ({ admission: { allowed: true, reason: 'candidate-admitted' }, initial: expected, current: expected }),
  });
  store.recordIssueSelection(selectionRecord);
  store.recordRecoveryAttempt(initialAttempt);
  assert.equal(pauseState.result, null);
  assert.equal(raw.calls.filter(([kind]) => kind === 'attempt').length, 1);
});

test('stale candidate refuses attempt persistence before claim or child launch', () => {
  const raw = fakeStore();
  const pauseState = { result: null };
  const current = { ...snapshotFromSelectionRecord(selectionRecord), preflightRevision: 'github-comment:database-id:101' };
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

test('candidate pause is audited without opening systemic health', () => {
  const raw = fakeStore();
  const pauseState = {
    result: {
      admission: { allowed: false, reason: 'candidate-status-changed' },
      current: { issueNumber: 5, preflightRevision: 'github-comment:database-id:100' },
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

test('canonical scheduler entrypoint installs the gate around the preserved base scheduler', () => {
  const source = readFileSync(new URL('./claude-runner-cron.mjs', import.meta.url), 'utf8');
  assert.match(source, /createAtomicAdmissionStore/);
  assert.match(source, /admissionBoundary: 'recordRecoveryAttempt'/);
  assert.match(source, /schedulerMain\(argv, env/);
});
