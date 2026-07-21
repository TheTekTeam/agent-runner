import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canaryIssueMismatchResult,
  createAtomicAdmissionStore,
  CandidateAdmissionPausedError,
} from './agent-runner-atomic-candidate-store.mjs';
import {
  parseSupervisedCanaryArgs,
  runSupervisedCanary,
} from './agent-runner-supervised-canary.mjs';

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

test('requires explicit execute and a positive issue', () => {
  assert.throws(() => parseSupervisedCanaryArgs(['--issue', '5']), /--execute is required/);
  assert.throws(() => parseSupervisedCanaryArgs(['--issue', '0', '--execute']), /positive integer/);
  assert.deepEqual(parseSupervisedCanaryArgs(['--issue', '5', '--execute']), {
    issueNumber: 5,
    execute: true,
    timerUnit: 'agent-runner-modelspend.timer',
  });
});

test('refuses to launch while the execution timer is active', () => {
  const { spawn, calls } = spawnSequence([{ status: 0, stdout: '', stderr: '' }]);
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service' }, {}, { spawn });
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
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service' }, {}, { spawn });
  assert.equal(result.exitCode, 3);
  assert.equal(result.payload.reason, 'requested-canary-not-selected');
  assert.equal(result.payload.selectedIssue, 6);
  assert.equal(calls.length, 2);
});

test('launches one standalone run with a pinned canary issue', () => {
  const { spawn, calls } = spawnSequence([
    { status: 3, stdout: '', stderr: '' },
    { status: 0, stdout: '{"selectedIssue":5}\n', stderr: '' },
    { status: 0, stdout: '{"completed":true}\n', stderr: '' },
  ]);
  const result = runSupervisedCanary({ issueNumber: 5, execute: true, timerUnit: 'timer.service' }, {}, { spawn });
  assert.equal(result.exitCode, 0);
  assert.equal(result.payload.launched, true);
  assert.equal(result.payload.timerRemainedDisabled, true);
  assert.equal(calls[2].options.env.AGENT_RUNNER_CANARY_ISSUE, '5');
  assert.equal(calls[2].options.env.CLAUDE_RUNNER_CRON_DISABLE_AUTO_PREFLIGHT, 'true');
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
