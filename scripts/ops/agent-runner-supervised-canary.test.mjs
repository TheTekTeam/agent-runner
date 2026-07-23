import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canaryIssueMismatchResult,
  createAtomicAdmissionStore,
  CandidateAdmissionPausedError,
} from './agent-runner-atomic-candidate-store.mjs';
import {
  boundedDiagnostic,
  parseSupervisedCanaryArgs,
  runSupervisedCanary,
} from './agent-runner-supervised-canary.mjs';

const PREFLIGHT = 'github-comment:database:5057357402';

function spawnSequence(results) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const result = results.shift();
    if (!result) throw new Error('unexpected spawn');
    return result;
  };
  return { spawn, calls };
}

function baseResults(run = { status: 0, stdout: '', stderr: '' }) {
  return [
    { status: 3, stdout: '', stderr: '' },
    { status: 0, stdout: JSON.stringify({ selectedIssue: 5, sourcePreflightCommentId: PREFLIGHT }), stderr: '' },
    run,
    { status: 3, stdout: '', stderr: '' },
  ];
}

function dependenciesFor(evidence, wrapperResult = { state: 'canonical_runner_invoked', reason: 'canonical-runner-executed' }, run = { status: 0, stdout: '', stderr: '' }) {
  const { spawn, calls } = spawnSequence(baseResults(run));
  return {
    dependencies: {
      spawn,
      temporaryDir: '/tmp/fixed-canary-test',
      readWrapperResult: () => wrapperResult,
      inspectEvidence: () => evidence,
      config: { stateDbPath: '/tmp/unused.sqlite' },
    },
    calls,
  };
}

test('requires explicit execute and a positive issue', () => {
  assert.throws(() => parseSupervisedCanaryArgs(['--issue', '5']), /--execute is required/);
  assert.throws(() => parseSupervisedCanaryArgs(['--issue', '0', '--execute']), /positive integer/);
  assert.deepEqual(parseSupervisedCanaryArgs(['--issue', '5', '--execute']), {
    issueNumber: 5,
    execute: true,
    timerUnit: 'agent-runner-modelspend.timer',
    sourcePreflightComment: null,
  });
});

test('refuses to launch while the execution timer is active', () => {
  const { spawn, calls } = spawnSequence([{ status: 0, stdout: '', stderr: '' }]);
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service', sourcePreflightComment: null }, {}, { spawn });
  assert.equal(result.exitCode, 3);
  assert.equal(result.payload.reason, 'execution-timer-active');
  assert.equal(result.payload.launched, false);
  assert.equal(calls.length, 1);
});

test('refuses when the exact requested issue is not selected', () => {
  const { spawn, calls } = spawnSequence([
    { status: 3, stdout: '', stderr: '' },
    { status: 0, stdout: '{"selectedIssue":6}\n', stderr: '' },
  ]);
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service', sourcePreflightComment: null }, {}, { spawn });
  assert.equal(result.exitCode, 3);
  assert.equal(result.payload.reason, 'requested-canary-not-selected');
  assert.equal(result.payload.selectedIssue, 6);
  assert.equal(calls.length, 2);
});

test('reports terminal success only after correlated durable evidence exists', () => {
  const { dependencies, calls } = dependenciesFor({
    state: 'terminal_success', claimPersisted: true, attemptPersisted: true, workerStarted: true,
    terminalSucceeded: true, terminalFailed: false, claimId: 41, attemptId: 'attempt-41', runResultId: 51,
  });
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service', sourcePreflightComment: PREFLIGHT }, {}, dependencies);
  assert.equal(result.exitCode, 0);
  assert.equal(result.payload.launched, true);
  assert.equal(result.payload.state, 'terminal_success');
  assert.equal(result.payload.evidence.claimId, 41);
  assert.equal(result.payload.timerRemainedDisabled, true);
  assert.equal(result.payload.runnerDiagnostics, undefined);
  assert.equal(calls[2].options.env.AGENT_RUNNER_CANARY_ISSUE, '5');
  assert.equal(calls[2].options.env.AGENT_RUNNER_RUN_RESULT_FILE, '/tmp/fixed-canary-test/run-project-result.json');
});

test('handled wrapper no-op remains non-execution even when the shell exits zero', () => {
  const { dependencies } = dependenciesFor(
    { state: 'handled_noop', claimPersisted: false, attemptPersisted: false, workerStarted: false },
    { state: 'handled_noop', reason: 'circuit-paused' },
    { status: 0, stdout: 'paused', stderr: '' },
  );
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service', sourcePreflightComment: PREFLIGHT }, {}, dependencies);
  assert.equal(result.exitCode, 3);
  assert.equal(result.payload.launched, false);
  assert.equal(result.payload.state, 'handled_noop');
  assert.equal(result.payload.reason, 'circuit-paused');
  assert.equal(result.payload.runnerDiagnostics.stdout.text, 'paused');
});

test('canonical wrapper invocation without a new claim or attempt fails closed', () => {
  const { dependencies } = dependenciesFor(
    { state: 'handled_noop', claimPersisted: false, attemptPersisted: false, workerStarted: false },
  );
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service', sourcePreflightComment: PREFLIGHT }, {}, dependencies);
  assert.equal(result.exitCode, 3);
  assert.equal(result.payload.launched, false);
  assert.equal(result.payload.reason, 'handled-noop-without-attempt');
});

test('worker start without terminal persistence is not success', () => {
  const { dependencies } = dependenciesFor({
    state: 'worker_started', claimPersisted: true, attemptPersisted: true, workerStarted: true,
    terminalSucceeded: false, terminalFailed: false, claimId: 41, attemptId: 'attempt-41', runResultId: null,
  });
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service', sourcePreflightComment: PREFLIGHT }, {}, dependencies);
  assert.equal(result.exitCode, 4);
  assert.equal(result.payload.launched, true);
  assert.equal(result.payload.reason, 'worker-started-without-terminal-result');
});

test('nonzero launcher exit exposes bounded sanitized diagnostics', () => {
  const { dependencies } = dependenciesFor(
    { state: 'terminal_failure', claimPersisted: true, attemptPersisted: true, workerStarted: true, terminalFailed: true },
    { state: 'canonical_runner_invoked', reason: 'canonical-runner-executed' },
    {
      status: 1,
      stdout: `before\nGH_TOKEN=ghp_abcdefghijklmnop\n${'x'.repeat(5000)}`,
      stderr: 'Bearer abc.def.ghi\nstartup failed',
    },
  );
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service', sourcePreflightComment: PREFLIGHT }, {}, dependencies);
  assert.equal(result.exitCode, 1);
  assert.equal(result.payload.runnerDiagnostics.restricted, true);
  assert.equal(result.payload.runnerDiagnostics.maxCharsPerStream, 4096);
  assert.equal(result.payload.runnerDiagnostics.stdout.truncated, true);
  assert.equal(result.payload.runnerDiagnostics.stdout.text.length, 4096);
  assert.doesNotMatch(result.payload.runnerDiagnostics.stdout.text, /ghp_/);
  assert.equal(result.payload.runnerDiagnostics.stderr.text, 'Bearer <redacted>\nstartup failed');
});

test('boundedDiagnostic reports deterministic truncation metadata', () => {
  assert.deepEqual(boundedDiagnostic('abcdef', 4), {
    text: 'cdef',
    truncated: true,
    originalChars: 6,
  });
});

test('atomic claim boundary rejects a different selected issue before attempt persistence', () => {
  const mismatch = canaryIssueMismatchResult(5, { issueNumber: 6 }, { issueNumber: 6 });
  assert.equal(mismatch.admission.reason, 'canary-issue-mismatch');
  assert.equal(mismatch.admission.expectedIssueNumber, 5);
  assert.equal(mismatch.admission.selectedIssueNumber, 6);

  let attemptWrites = 0;
  const events = [];
  const store = {
    recordIssueSelection: () => undefined,
    recordRecoveryAttempt: () => { attemptWrites += 1; },
    recordQueueEvent: (event) => events.push(event),
    openHealthCondition: () => undefined,
  };
  const pauseState = { result: null };
  const wrapped = createAtomicAdmissionStore(store, {
    env: { AGENT_RUNNER_CANARY_ISSUE: '5' },
    pauseState,
    revalidate: () => ({ admission: { allowed: true } }),
  });
  wrapped.recordIssueSelection({ issueNumber: 6, payload: { selectedIssue: 6 } });
  assert.throws(() => wrapped.recordRecoveryAttempt({
    issueNumber: 6,
    phase: 'starting',
    resolutionState: 'active',
    finishedAt: null,
  }), CandidateAdmissionPausedError);
  assert.equal(attemptWrites, 0);
  assert.equal(pauseState.result.admission.reason, 'canary-issue-mismatch');

  wrapped.recordQueueEvent({ eventType: 'systemic-pause', reason: 'state-failure' });
  assert.equal(events[0].eventType, 'candidate-admission-paused');
});
