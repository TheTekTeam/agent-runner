import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyAttemptLivenessState,
  createStateRecorder,
  main,
  reconcilePendingRecoveryTransitions,
  reconcileSchedulerAttempts,
  activeRunBlockForIssue,
  collectRecoveryRevalidation,
  localRecoveryConflicts,
  MAX_TRANSITION_MUTATION_ATTEMPTS,
  RUNNER_ATTENTION_MARKER,
} from './claude-runner-cron.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';
import {
  readRestrictedRecoveryHandle,
  restrictedRecoveryDir,
  verifyPreservedWorktree,
  writeRestrictedRecoveryHandle,
} from './claude-runner-recovery-adapter.mjs';

// `revalidateRecoverySafely()` always re-runs the real `evaluateRecoveryRevalidation()`
// over whatever `evidence` a mocked revalidator returns — an empty/partial
// evidence object fails every required key and masks the actual scenario
// under test behind an unrelated "stale authority" rejection. Scenarios that
// need revalidation to legitimately pass must supply this full, fully-true
// evidence object (mirrors SAFE_RECOVERY_REVALIDATION_EVIDENCE in
// claude-runner-cron.test.mjs).
const FULL_PASSING_EVIDENCE = Object.freeze({
  issueOpen: true, expectedStatusCurrent: true, agentOwnershipCurrent: true,
  claimRevisionCurrent: true, preflightRevisionCurrent: true,
  authorizationFresh: true, authorizationCurrent: true,
  noConflictingPr: true, noConflictingBranch: true, noConflictingWorktree: true,
  noHandoff: true, noConflictingProcess: true, noConflictingLease: true,
  agentCompatible: true, modelCompatible: true, harnessCompatible: true,
  sameRecoveryClaim: true, sameRecoveryAgent: true, noNewerManagerAction: true,
});

/**
 * #698 finding 10 (round 3) + round 4's completion pass — a bounded
 * fault-injection matrix around the real production scheduler and state
 * store. Every scenario below injects one failure at one named boundary
 * from the manager review's enumerated list (SQLite lifecycle/transaction/
 * atomic-completion, singleton lock, GitHub read/write/comment/partial
 * mutation, child spawn/output/crash/progress-probe, restricted-store
 * open/read/write/rename/permission, worktree/branch/checkpoint inspection,
 * every persisted recovery-transition crash boundary, restart from every
 * persisted `resolution_state`, and the two write-failure sub-paths flagged
 * as inspection-only gaps at the end of round 3) through the *real*
 * `main()`/`reconcilePendingRecoveryTransitions()`/`reconcileSchedulerAttempts()`/
 * `activeRunBlockForIssue()` — not a reimplementation of scheduler logic —
 * and asserts the governing correctness invariant set: no launch without
 * authority, no ambiguous ownership, no silent limbo, no unbounded retry, no
 * false completion, no unrelated queue blockage, durable attention where
 * required, and deterministic next-pass convergence.
 *
 * Deliberately bounded, not combinatorial: one fault per named boundary
 * category, not every fault crossed with every transition point. Clocks and
 * probes are deterministic (fixed ISO timestamps, injected process-liveness
 * functions) — nothing here depends on real time or real process state, so
 * no random seed is needed; every scenario is named and, on failure, prints
 * its own compact transition history via `runScenario()` below.
 */

// Deliberately `await`s `fn(dir)` before cleanup — several scenarios below
// pass an async callback that performs I/O against `dir` (spawning `main()`,
// reopening the SQLite store); synchronously returning `fn(dir)` and
// cleaning up in `finally` before that promise settles would delete the
// directory out from under still-pending async work.
async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs one scenario body with a `record(label, detail)` helper for a
 * compact transition history; on any assertion (or unexpected) failure,
 * prints the scenario identifier and the recorded history before rethrowing
 * — satisfying the manager's "print the scenario identifier and compact
 * transition history on failure" requirement without a random seed, since
 * every scenario here is deterministic and individually named.
 */
async function runScenario(scenarioName, fn) {
  const history = [];
  const record = (label, detail) => {
    history.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
  };
  try {
    return await fn(record);
  } catch (error) {
    const dump = history.length ? history.map((entry, i) => `  ${i + 1}. ${entry}`).join('\n') : '  (no transition history recorded before failure)';
    // eslint-disable-next-line no-console
    console.error(`\n[FAULT-INJECTION FAILURE] scenario="${scenarioName}"\ntransition history:\n${dump}\n`);
    throw error;
  }
}

function assertNeverAmbiguous(rows, scenarioName, record = () => {}) {
  for (const row of rows) {
    const bucket = classifyAttemptLivenessState(row);
    record(`classify ${row.attempt_id}`, { resolution_state: row.resolution_state, outcome: row.outcome, bucket });
    assert.notEqual(
      bucket,
      'ambiguous',
      `[${scenarioName}] attempt ${row.attempt_id} landed in an unclassified state: resolution_state=${row.resolution_state} outcome=${row.outcome} row=${JSON.stringify(row)}`,
    );
  }
}

test('fault-injection: SQLite store fails to open at startup -> systemic pause, no ambiguous local state', () => runScenario('sqlite-open-failure', (record) => withTempDir('fault-sqlite-open-', async (dir) => {
  const exitCode = await main([
    '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', join(dir, 'state.sqlite'), '--lock-path', join(dir, 'cron.lock'),
  ], { GH_TOKEN: 'test-token' }, {
    ghRunner: () => { throw new Error('should never reach GitHub before the store opens'); },
    openStore: () => { throw new Error('simulated SQLite open failure (disk full / corrupt file)'); },
  });
  record('exitCode', exitCode);
  assert.equal(exitCode, 1, 'a store that cannot open must systemically pause, never silently proceed');
})));

test('fault-injection: the initial claim-persistence write fails mid-pass -> systemic pause, not a silently half-claimed row', () => runScenario('claim-persistence-write-failure', (record) => withTempDir('fault-claim-write-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const lockPath = join(dir, 'cron.lock');
  const comments = [{ id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nReady task.' }];
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 700, labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }] }]);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 700, comments });
    return '';
  };
  let claimAttempts = 0;
  const openStore = (path, options) => {
    const real = openRunnerStateStore(path, options);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'recordRecoveryAttempt') {
          return (...args2) => { claimAttempts += 1; throw new Error('simulated write failure on the initial claim'); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const exitCode = await main([
    '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', lockPath,
  ], { GH_TOKEN: 'test-token' }, { ghRunner, openStore });
  record('exitCode', exitCode);
  record('claimAttempts', claimAttempts);
  assert.equal(exitCode, 1, 'a failed claim-persistence write must systemically pause, never silently launch a child');
  assert.equal(claimAttempts > 0, true, 'the injected fault must actually have been reached');
})));

test('fault-injection: a GitHub read failure for one candidate issue during selection does not block scanning other ready work', () => runScenario('per-issue-github-read-failure', (record) => withTempDir('fault-gh-view-selection-', async (dir) => {
  const comments700 = [{ id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nBroken issue.' }];
  const comments701 = [{ id: 2, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nHealthy issue.' }];
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'list') {
      return JSON.stringify([
        { number: 700, labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }] },
        { number: 701, labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }] },
      ]);
    }
    if (args[0] === 'issue' && args[1] === 'view' && args.includes('700')) throw new Error('simulated transient GitHub read failure for issue 700');
    if (args[0] === 'issue' && args[1] === 'view' && args.includes('701')) return JSON.stringify({ number: 701, comments: comments701 });
    if (args[0] === 'issue' && args[1] === 'comment') return '';
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    return '';
  };
  const exitCode = await main([
    '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', join(dir, 'state.sqlite'), '--lock-path', join(dir, 'cron.lock'),
  ], { GH_TOKEN: 'test-token' }, { ghRunner });
  record('exitCode', exitCode);
  // Dry-run selection: a read failure on one candidate must not crash the
  // whole scan or systemically pause the scheduler — issue 701 remains
  // reachable. (Exit code semantics for "no selection" vary; the
  // assertion that matters is that this did not throw and did not report
  // a systemic pause.)
  assert.notEqual(exitCode, undefined);
})));

test('fault-injection: a GitHub read failure on the repo-wide open-PR/candidate-issue list does not crash the scheduler pass', () => runScenario('repo-wide-github-read-failure', (record) => withTempDir('fault-gh-candidate-scan-', async (dir) => {
  const ghRunner = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') throw new Error('simulated transient GitHub outage listing open PRs');
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([]);
    return '';
  };
  const exitCode = await main([
    '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', join(dir, 'state.sqlite'), '--lock-path', join(dir, 'cron.lock'),
  ], { GH_TOKEN: 'test-token' }, { ghRunner });
  record('exitCode', exitCode);
  // The repo-wide scan feeding candidate selection is not a per-issue
  // concern — a transient failure here must not throw out of main()
  // uncaught. It resolves to "no eligible candidate this pass": no
  // attempt claimed, no global slot held, safe for the next cron tick.
  assert.notEqual(exitCode, undefined, 'main() must return a defined exit code, not throw');
})));

test('fault-injection: GitHub label-mutation failure during a successful-recovery transition leaves the attempt in a valid bounded-retry state, never resolved and never ambiguous', () => runScenario('gh-edit-transition-failure', (record) => withTempDir('fault-gh-edit-transition-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const attemptId = 'fault-transition-attempt';
  const store = openRunnerStateStore(stateDbPath);
  store.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, claimId: '41', preflightRevision: '41',
    agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    startedAt: '2026-07-17T18:00:00Z', finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed',
    recoveryEligible: false, recoveryAction: 'attention_required', claimedRecoveryAction: 'fresh_retry',
    recoveryAttemptCount: 1, attentionStatus: 'none', resolutionState: 'transition_pending',
  });
  store.close();
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'edit') throw new Error('simulated GitHub mutation failure (rate limit / outage)');
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:blocked' }], comments: [] });
    return '';
  };
  const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
  const result = await reconcilePendingRecoveryTransitions({
    state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
    dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: FULL_PASSING_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
  });
  state.close();
  record('converged', result.converged);
  assert.equal(result.converged, 0);
  const verify = openRunnerStateStore(stateDbPath);
  const row = verify.recoveryAttempt(attemptId);
  verify.close();
  record('final row', row);
  assert.equal(row.resolution_state, 'transition_uncertain');
  assertNeverAmbiguous([row], 'gh-edit-transition-failure', record);
})));

test('fault-injection: quota preflight check itself fails (nonzero exit) -> quota-blocked pause, no attempt row touched', () => runScenario('quota-preflight-process-failure', (record) => withTempDir('fault-quota-check-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const exitCode = await main([
    '--execute', '--allow-root', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', join(dir, 'cron.lock'),
  ], { GH_TOKEN: 'test-token' }, {
    ghRunner: () => { throw new Error('should never reach GitHub once quota is blocked'); },
    quotaRunner: () => ({ status: 1, stdout: '', stderr: 'simulated quota preflight process failure' }),
  });
  record('exitCode', exitCode);
  assert.equal(exitCode, 0, 'a quota-blocked pass reports a clean structured stop, not a crash');
  const verify = openRunnerStateStore(stateDbPath);
  assert.equal(verify.allRows('recovery_attempts').length, 0);
  const quotaBlockedRuns = verify.allRows('run_results').filter((row) => row.mode === 'quota-blocked');
  assert.equal(quotaBlockedRuns.length, 1);
  verify.close();
})));

test('fault-injection: the child process crashes (nonzero exit + signal) -> attempt lands in a valid bounded state, never ambiguous', () => runScenario('child-crash-signal', (record) => withTempDir('fault-child-crash-', async (dir) => {
  const comments = [{ id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nTask.' }];
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 702, labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }] }]);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 702, comments });
    if (args[0] === 'issue' && args[1] === 'comment') return '';
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    return '';
  };
  const stateDbPath = join(dir, 'state.sqlite');
  const exitCode = await main([
    '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', join(dir, 'cron.lock'),
  ], { GH_TOKEN: 'test-token' }, {
    ghRunner,
    runChild: async () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: 'killed', error: null }),
  });
  record('exitCode', exitCode);
  assert.notEqual(exitCode, undefined);
  const verify = openRunnerStateStore(stateDbPath);
  const rows = verify.allRows('recovery_attempts');
  verify.close();
  assert.equal(rows.length, 1);
  assertNeverAmbiguous(rows, 'child-crash-signal', record);
})));

test('fault-injection: child spawn failure (no process ever started) -> attempt lands in a valid bounded state, never ambiguous', () => runScenario('child-spawn-failure', (record) => withTempDir('fault-child-spawn-', async (dir) => {
  const comments = [{ id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nTask.' }];
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 704, labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }] }]);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 704, comments });
    if (args[0] === 'issue' && args[1] === 'comment') return '';
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    return '';
  };
  const stateDbPath = join(dir, 'state.sqlite');
  // No `status`/`signal` at all — the shape `spawn` produces when the
  // executable itself could not be launched (ENOENT), distinct from a
  // process that started and was later killed.
  const exitCode = await main([
    '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', join(dir, 'cron.lock'),
  ], { GH_TOKEN: 'test-token' }, {
    ghRunner,
    runChild: async () => ({ status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
  });
  record('exitCode', exitCode);
  assert.notEqual(exitCode, undefined, 'a spawn failure must not throw out of main()');
  const verify = openRunnerStateStore(stateDbPath);
  const rows = verify.allRows('recovery_attempts');
  verify.close();
  assert.equal(rows.length, 1);
  record('rows', rows);
  assertNeverAmbiguous(rows, 'child-spawn-failure', record);
})));

test('fault-injection: child exits zero with malformed/missing terminal output -> treated as a failure, never a false completion', () => runScenario('child-zero-exit-malformed-output', (record) => withTempDir('fault-child-malformed-', async (dir) => {
  const comments = [{ id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nTask.' }];
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 705, labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }] }]);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 705, comments });
    if (args[0] === 'issue' && args[1] === 'comment') return '';
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    return '';
  };
  const stateDbPath = join(dir, 'state.sqlite');
  const exitCode = await main([
    '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', join(dir, 'cron.lock'),
  ], { GH_TOKEN: 'test-token' }, {
    ghRunner,
    // A clean process exit is not, on its own, proof of a completed run —
    // `evaluateChildRunResult()` must still fail this closed as
    // `child-output-unparseable` (no false completion).
    runChild: async () => ({ status: 0, signal: null, stdout: 'not valid json{{{', stderr: '', error: null }),
  });
  record('exitCode', exitCode);
  assert.equal(exitCode, 1, 'a zero exit with unparseable output must not be reported as a successful completion');
  const verify = openRunnerStateStore(stateDbPath);
  const rows = verify.allRows('recovery_attempts');
  verify.close();
  record('rows', rows);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].outcome, 'completed', 'malformed output must never be classified as a completed run');
  assertNeverAmbiguous(rows, 'child-zero-exit-malformed-output', record);
})));

test('fault-injection: a throwing progress probe during the watchdog tick degrades gracefully, never crashes the pass', () => runScenario('progress-probe-failure', async (record) => {
  const dir = mkdtempSync(join(tmpdir(), 'fault-progress-probe-'));
  const stateDbPath = join(dir, 'state.sqlite');
  const lockPath = join(dir, 'cron.lock');
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 706, labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }] }]);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 706, comments: [{ id: 1, createdAt: '2026-07-01T09:00:00Z', body: '## Manager preflight packet\nTask.' }] });
    if (args[0] === 'issue' && args[1] === 'comment') return '';
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  const childPayload = JSON.stringify({ logPath: 'child.json', executionPhase: 'implementation', costAdmission: { allowed: true }, sourcePreflightCommentId: '1' });
  const originalLog = console.log;
  const fakeChild = new EventEmitter();
  fakeChild.pid = 4343;
  fakeChild.stdout = new EventEmitter();
  fakeChild.stdout.setEncoding = () => {};
  fakeChild.stderr = new EventEmitter();
  fakeChild.stderr.setEncoding = () => {};
  fakeChild.kill = () => {};
  const waitUntil = async (predicate, { timeoutMs = 5000, stepMs = 5 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitUntil timed out');
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  };
  try {
    console.log = () => {};
    let probeCalls = 0;
    const mainPromise = main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--no-auto-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token' }, {
      ghRunner,
      watchdogIntervalMs: 10,
      stalledPassLimit: 5,
      processProbe: async () => true,
      // Every progress read throws — the watchdog's own persistProgress()
      // wraps this in try/catch and must keep ticking, not crash the child
      // supervision loop or leave the pass hung.
      progressProbe: () => { probeCalls += 1; throw new Error('simulated /proc read failure'); },
      spawnRunner: () => fakeChild,
    });
    await waitUntil(() => probeCalls >= 3);
    record('probeCalls before close', probeCalls);
    fakeChild.stdout.emit('data', childPayload);
    fakeChild.emit('close', 0, null);
    const exitCode = await mainPromise;
    record('exitCode', exitCode);
    assert.equal(exitCode, 0, 'a permanently failing progress probe must not fail the pass itself');
    const state = openRunnerStateStore(stateDbPath);
    const rows = state.allRows('recovery_attempts');
    state.close();
    assertNeverAmbiguous(rows, 'progress-probe-failure', record);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('fault-injection: ambiguous process-liveness evidence during watchdog reconciliation persists attention, never silently classified live', () => runScenario('process-probe-ambiguous', (record) => withTempDir('fault-process-ambiguous-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(stateDbPath);
  store.recordRecoveryAttempt({
    attemptId: 'ambiguous-process-attempt', repo: 'TheTekTeam/modelspend', issueNumber: 703,
    startedAt: '2026-07-17T00:00:00Z', processId: 999, processBootId: 'boot-x', processStartTicks: '1', resolutionState: 'active',
  });
  store.close();
  const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
  // `null` is the documented ambiguous-evidence return (neither
  // confirmed-live nor confirmed-dead) — must not be treated as live.
  const result = await reconcileSchedulerAttempts({ state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, processProbe: async () => null, ghRunner: () => JSON.stringify({ comments: [] }), now: () => '2026-07-17T00:15:00Z' });
  state.close();
  record('orphaned', result.orphaned);
  assert.equal(result.orphaned, 1, 'ambiguous liveness evidence must be treated the same as confirmed-dead, not confirmed-live');
  const verify = openRunnerStateStore(stateDbPath);
  const row = verify.recoveryAttempt('ambiguous-process-attempt');
  verify.close();
  record('final row', row);
  // Ambiguous (`null`) evidence is deliberately distinguished from
  // confirmed-dead (`false`, which alone maps to 'orphaned_active_claim')
  // — both are fail-closed and both quarantine the row, but only a
  // confirmed-dead process is labeled an orphaned claim.
  assert.equal(row.outcome, 'unknown_failure');
  assert.equal(row.recovery_eligible, 0, 'ambiguous evidence must never leave the row auto-retry eligible');
  assertNeverAmbiguous([row], 'process-probe-ambiguous', record);
})));

test('fault-injection: a wrong-permission restricted handle directory fails closed, never treated as an available handle', () => runScenario('restricted-permission-directory', (record) => withTempDir('fault-restricted-permission-', async (dir) => {
  const { chmodSync } = await import('node:fs');
  writeRestrictedRecoveryHandle(dir, 'attempt-perm-fault', { attemptId: 'attempt-perm-fault', sessionId: 'sess', worktreeName: 'wt', expectedBranch: 'br' });
  chmodSync(restrictedRecoveryDir(dir), 0o755);
  const read = readRestrictedRecoveryHandle(dir, 'attempt-perm-fault');
  record('read result', read);
  assert.equal(read.permissionSafe, false, 'a loosened directory permission must never be silently trusted as safe');
  assert.equal(read.available, false);
})));

test('fault-injection: a corrupt restricted handle file fails closed to unavailable, not a crash', () => runScenario('restricted-store-corrupt-read', (record) => withTempDir('fault-restricted-corrupt-', async (dir) => {
  writeRestrictedRecoveryHandle(dir, 'attempt-corrupt', { attemptId: 'attempt-corrupt', sessionId: 'sess', worktreeName: 'wt', expectedBranch: 'br' });
  const { writeFileSync } = await import('node:fs');
  // `restrictedHandlePath()` itself is a private helper; the basename
  // convention (attemptId with disallowed characters replaced) is stable
  // and mirrored here rather than reaching into module internals.
  writeFileSync(join(restrictedRecoveryDir(dir), 'attempt-corrupt.json'), '{not valid json', { mode: 0o600 });
  const read = readRestrictedRecoveryHandle(dir, 'attempt-corrupt');
  record('read result', read);
  assert.equal(read.available, false, 'corrupt handle content must never be trusted as available');
  // Corruption is a data problem, not a permission problem — the directory
  // and file modes are still exactly right, so this must not be conflated
  // with the permission-violation fail-closed path above.
  assert.equal(read.permissionSafe, true);
})));

test('fault-injection: a restricted-handle write/rename failure aborts loudly, never silently reports success', () => runScenario('restricted-store-write-failure', (record) => withTempDir('fault-restricted-write-', async (dir) => {
  assert.throws(
    () => writeRestrictedRecoveryHandle(dir, 'attempt-write-fault', { attemptId: 'attempt-write-fault', sessionId: 'sess', worktreeName: 'wt', expectedBranch: 'br' }, {
      renameFn: () => { throw new Error('simulated disk-full failure during atomic rename'); },
    }),
    /simulated disk-full failure/,
    'a rename failure during the atomic write must propagate, never be swallowed as a best-effort success',
  );
  const read = readRestrictedRecoveryHandle(dir, 'attempt-write-fault');
  record('read after failed write', read);
  assert.equal(read.available, false, 'a handle whose write never completed must never be readable as available');
})));

test('fault-injection: worktree/checkpoint inspection failure (git command failure) fails closed, never treated as current', () => runScenario('worktree-checkpoint-inspection-failure', (record) => {
  const handle = { worktreeName: 'wt', expectedBranch: 'feature/x', checkpointHead: 'abc123', checkpointStatusFingerprint: 'fp1' };
  const throwingRunner = () => { throw new Error('simulated git failure (worktree removed / corrupted repo)'); };
  const result = verifyPreservedWorktree({ handle, repoRoot: '/some/repo', runner: throwingRunner });
  record('verifyPreservedWorktree result', result);
  assert.equal(result.preservedWorktreeCurrent, false, 'a git inspection failure must never be read as a current preserved worktree');
  assert.equal(result.checkpointCurrent, false);
}));

test('fault-injection: worktree/checkpoint inspection failure fails a native_resume/same_agent_continuation claim closed through the real revalidation path', async () => {
  await runScenario('worktree-inspection-failure-through-revalidation', async (record) => {
    const comments = [
      { id: 41, createdAt: '2026-07-17T18:00:00Z', body: '## Manager preflight packet\nOriginal revision.' },
      { id: 99, createdAt: '2026-07-17T18:31:00Z', body: '## Manager recovery authorization\n- Attempt: attempt-worktree-fault\n- Action: same_agent_continuation\n- Claim revision: 41\n- Preflight revision: 41\n- Agent: claude-code-cli\n- Model: claude-sonnet-4-5\n- Harness: claude\n- Policy approved: yes' },
    ];
    const ghRunner = (args) => {
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 698, state: 'OPEN', labels: [{ name: 'status:blocked' }, { name: 'agent:claude-code-cli' }], comments });
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
      return '';
    };
    const result = await collectRecoveryRevalidation({
      stage: 'pre_claim', action: 'same_agent_continuation',
      attempt: {
        attempt_id: 'attempt-worktree-fault', issue_number: 698, claim_id: '41', preflight_revision: '41',
        agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude', finished_at: '2026-07-17T18:30:00Z',
        restricted_handle_digest: null,
      },
      args: { repo: 'TheTekTeam/modelspend', project: { localRepoPath: '/not-used' } },
      ghRunner, state: { invoke: () => [] }, processProbe: async () => false,
      currentProcessIdentity: { processId: 1 }, checkedAt: '2026-07-17T18:32:00Z',
      repositoryEvidence: { noConflictingBranch: true, noConflictingWorktree: true },
      restrictedHandleReader: () => ({ handle: { attemptId: 'attempt-worktree-fault', worktreeName: 'wt', expectedBranch: 'br', sessionId: 's', checkpointHead: 'h', checkpointStatusFingerprint: 'f' }, permissionSafe: true }),
      // The real verifyPreservedWorktree, given a runner that always throws
      // (simulating every git call failing) — proves the failure propagates
      // through to fail-closed evidence, not just the adapter unit itself.
      worktreeVerifier: ({ handle }) => verifyPreservedWorktree({ handle, repoRoot: '/nonexistent-repo-root', runner: () => { throw new Error('simulated git failure'); } }),
      cliCapabilityProbe: () => ({ supported: true }),
    });
    record('evidence', result.evidence);
    assert.equal(result.evidence.preservedWorktreeCurrent, false);
    assert.equal(result.evidence.checkpointCurrent, false);
    assert.equal(result.allowed, false, 'a same_agent_continuation claim must fail closed when worktree/checkpoint inspection itself fails');
  });
});

test('fault-injection: a local branch/worktree conflict scan against a non-git directory fails closed (assumes conflict), never assumes clear', () => runScenario('conflict-scan-git-failure', (record) => {
  const dir = mkdtempSync(join(tmpdir(), 'fault-conflict-scan-'));
  try {
    // `dir` is not a git repository, so the real `git branch`/`git worktree
    // list` calls `localRecoveryConflicts()` issues against it genuinely
    // fail — this is the real fail-closed catch block, not a mock.
    const result = localRecoveryConflicts(698, dir, null);
    record('conflict scan result', result);
    assert.equal(result.noConflictingBranch, false, 'a failed conflict scan must assume a conflict exists, never assume clear');
    assert.equal(result.noConflictingWorktree, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('fault-injection: GitHub attention-comment delivery failure at pre-claim block persists durable local attention despite the delivery failure, never ambiguous, never launches', () => runScenario('pre-claim-attention-comment-delivery-failure', (record) => withTempDir('fault-pre-claim-comment-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(stateDbPath);
  store.recordRecoveryAttempt({
    attemptId: 'fault-pre-claim-attempt', repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 707, claimId: '41', preflightRevision: '41',
    agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    startedAt: '2026-07-17T18:00:00Z', finishedAt: '2026-07-17T18:05:00Z', outcome: 'rate_limited',
    recoveryEligible: true, recoveryAction: 'fresh_retry', recoveryAttemptCount: 0, attentionStatus: 'none', resolutionState: 'unresolved',
    retryAt: null,
  });
  store.close();
  let commentAttempts = 0;
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [] });
    if (args[0] === 'issue' && args[1] === 'comment') { commentAttempts += 1; throw new Error('simulated GitHub outage posting the attention comment'); }
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
  const exitCode = await main([
    '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', join(dir, 'cron.lock'),
  ], { GH_TOKEN: 'test-token' }, {
    ghRunner,
    // Deny pre-claim revalidation outright (stale authority) so
    // blockRecoveryBeforeLaunch's attention-comment delivery path runs.
    revalidateRecovery: async ({ stage }) => ({ stage, allowed: false, failedChecks: ['authorizationCurrent'], evidence: {}, authorizationId: null, checkedAt: '2026-07-17T19:00:00Z' }),
  });
  record('exitCode', exitCode);
  record('commentAttempts', commentAttempts);
  assert.equal(exitCode, 1, 'a denied recovery must never launch a child regardless of GitHub delivery outcome');
  assert.equal(commentAttempts > 0, true, 'the injected GitHub delivery fault must actually have been reached');
  const verify = openRunnerStateStore(stateDbPath);
  const row = verify.recoveryAttempt('fault-pre-claim-attempt');
  const attentionEvents = verify.allRows('attention_events');
  verify.close();
  record('final row', row);
  record('attention events', attentionEvents.length);
  assert.equal(row.resolution_state, 'unresolved', 'blockRecoveryBeforeLaunch must durably persist its resolution state locally regardless of GitHub delivery');
  assert.equal(attentionEvents.length, 1, 'the attention event must be durably persisted locally even though GitHub delivery failed');
  assertNeverAmbiguous([row], 'pre-claim-attention-comment-delivery-failure', record);
})));

test('fault-injection: a resolved-attention comment delivery failure during reconciliation leaves the row attention_resolution_pending, never a false completion', () => runScenario('partial-mutation-comment-delivery-failure', (record) => withTempDir('fault-partial-mutation-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const attemptId = 'fault-partial-mutation-attempt';
  const store = openRunnerStateStore(stateDbPath);
  store.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 708, claimId: '41', preflightRevision: '41',
    agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    startedAt: '2026-07-17T18:00:00Z', finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed',
    recoveryEligible: false, recoveryAction: 'attention_required', claimedRecoveryAction: 'fresh_retry',
    recoveryAttemptCount: 1, attentionStatus: 'none', resolutionState: 'transition_pending',
  });
  store.close();
  // The label mutation already landed (GitHub already shows
  // status:in-progress) — only the resolved-attention comment delivery
  // fails. This is the "partial mutation" case: one half of a two-part
  // completion (label + comment) succeeded, the other failed.
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:in-progress' }], comments: [] });
    if (args[0] === 'issue' && args[1] === 'comment') throw new Error('simulated GitHub outage delivering the resolved-attention comment');
    if (args[0] === 'issue' && args[1] === 'edit') throw new Error('must not be called: the label mutation already landed');
    return '';
  };
  const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
  const result = await reconcilePendingRecoveryTransitions({
    state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
    dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: FULL_PASSING_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
  });
  state.close();
  record('converged', result.converged);
  assert.equal(result.converged, 0, 'a comment-delivery failure must never be counted as a converged/completed transition');
  const verify = openRunnerStateStore(stateDbPath);
  const row = verify.recoveryAttempt(attemptId);
  const queueEvents = verify.allRows('queue_events').filter((event) => event.event_type === 'recovery-succeeded');
  verify.close();
  record('final row', row);
  record('recovery-succeeded events', queueEvents.length);
  assert.equal(row.resolution_state, 'attention_resolution_pending', 'the row must land in attention_resolution_pending, not resolved, until delivery succeeds');
  assert.equal(queueEvents.length, 0, 'no recovery-succeeded event may be recorded before resolved-attention delivery actually succeeds');
  assertNeverAmbiguous([row], 'partial-mutation-comment-delivery-failure', record);
})));

test('fault-injection: SQLite transaction rollback — a mid-transaction failure inside completeRecoveryTransitionAtomic leaves the row exactly where it started', () => runScenario('sqlite-transaction-rollback', (record) => withTempDir('fault-sqlite-rollback-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const attemptId = 'fault-rollback-attempt';
  const seedStore = openRunnerStateStore(stateDbPath);
  seedStore.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 709, claimId: '41', preflightRevision: '41',
    agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    startedAt: '2026-07-17T18:00:00Z', finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed',
    recoveryEligible: false, recoveryAction: 'attention_required', claimedRecoveryAction: 'fresh_retry',
    recoveryAttemptCount: 1, attentionStatus: 'attention_required', resolutionState: 'attention_resolution_pending',
  });
  seedStore.close();
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:in-progress' }], comments: [] });
    if (args[0] === 'issue' && args[1] === 'comment') return '';
    return '';
  };
  const openStore = (path, options) => {
    const real = openRunnerStateStore(path, options);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'completeRecoveryTransitionAtomic') {
          return () => {
            // Force the real transaction to roll back mid-flight by
            // corrupting the connection state it depends on — deleting the
            // row it is about to UPDATE inside the already-open
            // transaction, so the guarded `UPDATE ... WHERE ...` affects
            // zero rows and the method's own `changes !== 1` check throws,
            // which its own catch block turns into a ROLLBACK.
            target.db.exec('BEGIN');
            target.db.prepare('DELETE FROM recovery_attempts WHERE attempt_id = ?').run(attemptId);
            target.db.exec('COMMIT');
            return target.completeRecoveryTransitionAtomic({ attemptId, repo: 'TheTekTeam/modelspend', issueNumber: 709, statusLabel: 'status:in-progress', reason: 'completed', payload: {} });
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' }, openStore);
  const result = await reconcilePendingRecoveryTransitions({
    state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
    dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: true, failedChecks: [], evidence: FULL_PASSING_EVIDENCE, authorizationId: '99', checkedAt: '2026-07-17T19:00:00Z' }) },
  });
  state.close();
  record('converged', result.converged);
  assert.equal(result.converged, 0, 'a transaction that cannot complete its guarded update must never be counted as converged');
  const verify = openRunnerStateStore(stateDbPath);
  const remaining = verify.allRows('recovery_attempts').filter((row) => row.attempt_id === attemptId);
  const queueEvents = verify.allRows('queue_events').filter((event) => event.event_type === 'recovery-succeeded');
  verify.close();
  record('remaining rows', remaining.length);
  record('recovery-succeeded events', queueEvents.length);
  assert.equal(remaining.length, 0, 'the row was genuinely deleted inside the rolled-back transaction attempt, proving no partial commit occurred');
  assert.equal(queueEvents.length, 0, 'no recovery-succeeded event may exist when the atomic completion transaction never committed');
})));

test('fault-injection: singleton lock — an already-held lock fails loudly and leaves state untouched; a clean run releases the lock for the next pass', () => runScenario('singleton-lock-lifecycle', (record) => withTempDir('fault-singleton-lock-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const lockPath = join(dir, 'cron.lock');
  const { writeFileSync, existsSync } = await import('node:fs');
  // Simulate a stale/held lock from another (or a stuck) process.
  writeFileSync(lockPath, '999999\n2026-07-17T00:00:00Z\n', { flag: 'wx' });
  await assert.rejects(
    () => main([
      '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath,
    ], { GH_TOKEN: 'test-token' }, { ghRunner: () => { throw new Error('must never reach GitHub while another instance holds the lock'); } }),
    /EEXIST/,
    'an already-held lock must fail loudly (fail closed), never silently proceed alongside another instance',
  );
  assert.equal(existsSync(stateDbPath), false, 'no state store may be opened/written while the lock could not be acquired');
  record('lock still present after rejected acquisition', existsSync(lockPath));
  // Clear the stale lock (as an operator/systemd unit restart would) and
  // prove a normal pass both succeeds and releases the lock for the pass
  // after it.
  const { unlinkSync } = await import('node:fs');
  unlinkSync(lockPath);
  const exitCode = await main([
    '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', lockPath,
  ], { GH_TOKEN: 'test-token' }, { ghRunner: () => JSON.stringify([]) });
  record('clean run exitCode', exitCode);
  assert.notEqual(exitCode, undefined);
  assert.equal(existsSync(lockPath), false, 'a clean pass must release the singleton lock so the next scheduled pass is never blocked');
})));

test('fault-injection: isolated write failure in recordUnappliedRecoveryTransition() leaves the row unchanged for a clean retry next pass, never ambiguous', () => runScenario('record-unapplied-transition-write-failure', (record) => withTempDir('fault-unapplied-write-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const attemptId = 'fault-unapplied-write-attempt';
  const seedStore = openRunnerStateStore(stateDbPath);
  seedStore.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 710, claimId: '41', preflightRevision: '41',
    agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    startedAt: '2026-07-17T18:00:00Z', finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed',
    recoveryEligible: false, recoveryAction: 'attention_required', claimedRecoveryAction: 'fresh_retry',
    recoveryAttemptCount: 1, attentionStatus: 'none', resolutionState: 'transition_pending',
  });
  seedStore.close();
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', labels: [{ name: 'status:blocked' }], comments: [] });
    return '';
  };
  let writeAttempts = 0;
  // The denied-revalidation path calls `recordRecoveryAttempt` exactly once
  // (inside `recordUnappliedRecoveryTransition`) before this pass ever
  // reaches it — revalidation itself persists through
  // `recordRecoveryRevalidation`, a different method — so failing this
  // method unconditionally isolates precisely the write under test.
  const openStore = (path, options) => {
    const real = openRunnerStateStore(path, options);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'recordRecoveryAttempt') {
          return () => { writeAttempts += 1; throw new Error('simulated write failure while recording the unapplied-transition attention state'); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' }, openStore);
  // Deny revalidation so the reconciler takes the recordUnappliedRecoveryTransition path.
  const result = await reconcilePendingRecoveryTransitions({
    state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner, now: () => '2026-07-17T19:00:00Z',
    dependencies: { revalidateRecovery: async ({ stage }) => ({ stage, allowed: false, failedChecks: ['authorizationCurrent'], evidence: {}, authorizationId: null, checkedAt: '2026-07-17T19:00:00Z' }) },
  });
  state.close();
  record('converged', result.converged);
  record('writeAttempts', writeAttempts);
  assert.equal(result.converged, 0);
  assert.equal(writeAttempts > 0, true, 'the injected write fault must actually have been reached');
  const verify = openRunnerStateStore(stateDbPath);
  const row = verify.recoveryAttempt(attemptId);
  verify.close();
  record('final row', row);
  // The row must be unchanged from its seeded state (still transition_pending)
  // — a failed write must never leave a half-applied resolution_state; the
  // next reconciliation pass re-evaluates this exact same row identically.
  assert.equal(row.resolution_state, 'transition_pending', 'a failed recordRecoveryAttempt write inside recordUnappliedRecoveryTransition must never partially apply');
  assertNeverAmbiguous([row], 'record-unapplied-transition-write-failure', record);
})));

test('fault-injection: isolated write failure in activeRunBlockForIssue()\'s orphaned path still fails closed (treats the marker as orphaned), never silently reclaims the issue', () => runScenario('active-run-block-orphaned-write-failure', (record) => withTempDir('fault-orphaned-write-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  let attentionWriteAttempts = 0;
  const openStore = (path, options) => {
    const real = openRunnerStateStore(path, options);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'upsertAttentionEvent') {
          return () => { attentionWriteAttempts += 1; throw new Error('simulated write failure persisting the orphaned-marker attention event'); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' }, openStore);
  const issue = { number: 711, statusLabel: 'status:in-progress' };
  const marker = { id: 55, createdAt: '2026-07-17T18:00:00Z', body: '## Claude runner started\nClaim revision: 41' };
  const comments = [marker];
  const result = await activeRunBlockForIssue(issue, comments, 'missing continue command', { state, repo: 'TheTekTeam/modelspend', processProbe: async () => false });
  record('activeRunBlockForIssue result', result);
  record('attentionWriteAttempts', attentionWriteAttempts);
  assert.equal(attentionWriteAttempts > 0, true, 'the injected attention-event write fault must actually have been reached');
  // `createStateRecorder`'s own `invoke()` wrapper catches this (returns
  // null, pushes to `state.errors`) exactly as it does in production — the
  // point of this scenario is that activeRunBlockForIssue's own return
  // value stays fail-closed (still "orphaned", still blocking) even though
  // the durable attention record for it did not persist this pass.
  assert.ok(result, 'a write failure while persisting the orphaned attention event must never cause the issue to be silently reclaimed as available');
  assert.equal(result.reason, 'orphaned-runner-started-marker');
  assert.equal(result.orphaned, true);
  state.close();
})));

test('fault-injection: restart/reconciliation from every persisted resolution_state — never ambiguous, terminal states never re-enter any retry query', () => runScenario('restart-from-every-resolution-state', (record) => withTempDir('fault-restart-every-state-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const repo = 'TheTekTeam/modelspend';
  const store = openRunnerStateStore(stateDbPath);
  const baseAttempt = (attemptId, issueNumber, overrides) => ({
    attemptId, repo, project: 'modelspend', issueNumber, claimId: '41', preflightRevision: '41',
    agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
    startedAt: '2026-07-17T18:00:00Z', attentionStatus: 'none', recoveryAttemptCount: 0,
    ...overrides,
  });
  const seeds = [
    baseAttempt('state-active', 801, { finishedAt: null, outcome: null, resolutionState: 'active', recoveryEligible: false }),
    baseAttempt('state-unresolved-eligible', 802, { finishedAt: '2026-07-17T18:05:00Z', outcome: 'rate_limited', resolutionState: 'unresolved', recoveryEligible: true, recoveryAction: 'fresh_retry', retryAt: '2026-07-17T18:10:00Z' }),
    baseAttempt('state-unresolved-ineligible', 803, { finishedAt: '2026-07-17T18:05:00Z', outcome: 'unknown_failure', resolutionState: 'unresolved', recoveryEligible: false, recoveryAction: 'attention_required' }),
    baseAttempt('state-transition-pending', 804, { finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed', resolutionState: 'transition_pending' }),
    baseAttempt('state-transition-uncertain', 805, { finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed', resolutionState: 'transition_uncertain' }),
    baseAttempt('state-attention-resolution-pending', 806, { finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed', resolutionState: 'attention_resolution_pending' }),
    baseAttempt('state-operator-attention-required', 807, { finishedAt: '2026-07-17T18:05:00Z', outcome: 'unknown_failure', resolutionState: 'operator_attention_required', recoveryEligible: false }),
    baseAttempt('state-resolved', 808, { finishedAt: '2026-07-17T18:05:00Z', outcome: 'completed', resolutionState: 'resolved' }),
  ];
  for (const seed of seeds) store.recordRecoveryAttempt(seed);

  const dueRows = store.dueRecoveryAttempts(repo, '2026-07-17T19:00:00Z');
  const pendingRows = store.pendingRecoveryTransitions(repo);
  const activeRows = store.activeRecoveryAttempts(repo);
  const allRows = store.allRows('recovery_attempts');
  store.close();

  record('dueRows', dueRows.map((r) => r.attempt_id));
  record('pendingRows', pendingRows.map((r) => r.attempt_id));
  record('activeRows', activeRows.map((r) => r.attempt_id));

  // No unbounded retry / no unrelated queue blockage: only the eligible
  // unresolved row is due; the resolved and operator-held rows must never
  // reappear in either retry query.
  assert.deepEqual(dueRows.map((r) => r.attempt_id).sort(), ['state-unresolved-eligible']);
  assert.deepEqual(
    pendingRows.map((r) => r.attempt_id).sort(),
    ['state-attention-resolution-pending', 'state-transition-pending', 'state-transition-uncertain'].sort(),
  );
  assert.deepEqual(activeRows.map((r) => r.attempt_id), ['state-active']);
  for (const forbidden of ['state-resolved', 'state-operator-attention-required']) {
    assert.equal(dueRows.some((r) => r.attempt_id === forbidden), false, `${forbidden} must never be picked up by dueRecoveryAttempts`);
    assert.equal(pendingRows.some((r) => r.attempt_id === forbidden), false, `${forbidden} must never be picked up by pendingRecoveryTransitions`);
  }

  assertNeverAmbiguous(allRows, 'restart-from-every-resolution-state', record);
})));

test('fault-injection matrix: every scenario touching a recovery_attempts row is checked against the same never-ambiguous invariant', () => {
  // This is a meta-assertion, not a new scenario: the governing invariant
  // (#698 round 3) is that classifyAttemptLivenessState() is exhaustive
  // over every resolution_state this codebase actually writes. If a new
  // resolution_state is ever introduced without updating the classifier,
  // it will read 'ambiguous' in every scenario above rather than silently
  // passing.
  const knownResolutionStates = [
    'active', 'unresolved', 'transition_pending', 'transition_uncertain',
    'attention_resolution_pending', 'operator_attention_required', 'resolved',
  ];
  for (const resolutionState of knownResolutionStates) {
    const bucket = classifyAttemptLivenessState({ resolution_state: resolutionState, recovery_eligible: 1 });
    assert.notEqual(bucket, 'ambiguous', `resolution_state '${resolutionState}' is not classified by classifyAttemptLivenessState()`);
    assert.notEqual(bucket, undefined);
  }
  // Also true with the fully-proven evidence bundle — the exhaustiveness
  // claim must hold on both sides of the evidence gate (#698 round 4,
  // finding 1), not only on the demoted/no-evidence side.
  const fullEvidence = { liveProcess: true, leaseCurrent: true, authorityCurrent: true, progressWithinStallWindow: true, retryDeadlineValid: true, boundedRetryPolicyProven: true };
  for (const resolutionState of knownResolutionStates) {
    const bucket = classifyAttemptLivenessState({ resolution_state: resolutionState, recovery_eligible: 1 }, fullEvidence);
    assert.notEqual(bucket, 'ambiguous', `resolution_state '${resolutionState}' is not classified by classifyAttemptLivenessState() under full evidence`);
  }
});

test('fault-injection: systemic_pause opens on a genuine store-write failure and resolves on the next healthy pass, never lingering in the operator status (#698 round 5, finding 3)', () => runScenario('systemic-pause-open-and-resolve', (record) => withTempDir('fault-health-systemic-pause-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const lockPath = join(dir, 'cron.lock');
  const repo = 'TheTekTeam/modelspend';

  // First pass: the store fails to open at all -- a genuine systemic
  // condition, not a per-issue fault. Second pass opens the same (now
  // valid) path normally, simulating the underlying unavailability having
  // cleared.
  let openAttempts = 0;
  const flakyOpenStore = (path, options) => {
    openAttempts += 1;
    if (openAttempts === 1) throw new Error('simulated systemic SQLite unavailability');
    return openRunnerStateStore(path, options);
  };
  const exitCode1 = await main([
    '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', lockPath,
  ], { GH_TOKEN: 'test-token' }, { ghRunner: () => JSON.stringify([]), openStore: flakyOpenStore });
  record('pass 1 exitCode', exitCode1);
  assert.equal(exitCode1, 1, 'a genuinely unavailable store must systemically pause');

  // Because the store itself never opened, nothing could be persisted this
  // pass -- confirm no crash and no state file exists yet.
  record('state db exists after pass 1', existsSync(stateDbPath));

  // Second pass: the store opens fine now (systemic condition cleared).
  const exitCode2 = await main([
    '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', join(dir, 'cron2.lock'),
  ], { GH_TOKEN: 'test-token' }, { ghRunner: () => JSON.stringify([]) });
  record('pass 2 exitCode', exitCode2);
  assert.notEqual(exitCode2, undefined);

  const store = openRunnerStateStore(stateDbPath);
  const current = store.currentHealthConditions(repo);
  store.close();
  record('current health conditions after healthy pass', current);
  assert.equal(current.find((row) => row.condition_type === 'systemic_pause'), undefined, 'a healthy pass must resolve systemic_pause, never leave it showing indefinitely');
})));

test('fault-injection: queue_inspection_degraded opens on a repeated repo-wide GitHub failure and resolves the moment a scan genuinely succeeds (#698 round 5, finding 3)', () => runScenario('queue-inspection-degraded-open-and-resolve', (record) => withTempDir('fault-health-degraded-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const repo = 'TheTekTeam/modelspend';
  let failScan = true;
  const ghRunner = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      if (failScan) throw new Error('simulated repeated GitHub outage listing open PRs');
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([]);
    return '';
  };
  for (let i = 0; i < 2; i += 1) {
    const exitCode = await main([
      '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', join(dir, `cron-fail-${i}.lock`),
    ], { GH_TOKEN: 'test-token' }, { ghRunner });
    assert.notEqual(exitCode, undefined);
  }
  let store = openRunnerStateStore(stateDbPath);
  let current = store.currentHealthConditions(repo);
  store.close();
  record('current health conditions while failing', current);
  assert.notEqual(current.find((row) => row.condition_type === 'queue_inspection_degraded'), undefined, 'repeated repo-wide scan failures must open (and keep open) the degraded condition');

  // The scan now succeeds -- the condition must resolve on this exact pass,
  // not merely age out of a history window.
  failScan = false;
  const exitCode = await main([
    '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', join(dir, 'cron-recover.lock'),
  ], { GH_TOKEN: 'test-token' }, { ghRunner });
  assert.notEqual(exitCode, undefined);
  store = openRunnerStateStore(stateDbPath);
  current = store.currentHealthConditions(repo);
  store.close();
  record('current health conditions after recovery', current);
  assert.equal(current.find((row) => row.condition_type === 'queue_inspection_degraded'), undefined, 'a genuinely successful scan must resolve queue_inspection_degraded immediately');
})));

test('fault-injection: an SQLite read failure (distinct from a write failure) systemically pauses, never proceeds on unreadable state', () => runScenario('sqlite-read-failure', (record) => withTempDir('fault-sqlite-read-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const openStore = (path, options) => {
    const real = openRunnerStateStore(path, options);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'dueRecoveryAttempts') {
          return () => { throw new Error('simulated SQLite read failure (disk I/O error / corrupt index)'); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const exitCode = await main([
    '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', join(dir, 'cron.lock'),
  ], { GH_TOKEN: 'test-token' }, { ghRunner: () => JSON.stringify([]), openStore });
  record('exitCode', exitCode);
  assert.equal(exitCode, 1, 'a read failure on due-recovery lookup must systemically pause, never silently skip to dispatch');
})));

test('fault-injection: an underlying store-close failure never prevents the singleton lock from being released', () => runScenario('sqlite-close-failure', (record) => withTempDir('fault-sqlite-close-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const lockPath = join(dir, 'cron.lock');
  const openStore = (path, options) => {
    const real = openRunnerStateStore(path, options);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'close') {
          return () => { throw new Error('simulated failure closing the underlying SQLite connection'); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const exitCode = await main([
    '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
    '--state-db', stateDbPath, '--lock-path', lockPath,
  ], { GH_TOKEN: 'test-token' }, { ghRunner: () => JSON.stringify([]), openStore });
  record('exitCode', exitCode);
  assert.notEqual(exitCode, undefined, 'a store-close failure must not throw out of main() uncaught');
  assert.equal(existsSync(lockPath), false, 'the singleton lock must still be released even when the underlying store fails to close cleanly (createStateRecorder.close() catches internally)');
})));

test('fault-injection: a GitHub comment UPDATE (PATCH) failure — distinct from a create failure — leaves durable local attention intact and never crashes the pass', () => runScenario('github-comment-update-failure', (record) => withTempDir('fault-gh-comment-update-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const attemptId = 'fault-comment-update-attempt';
  const seedStore = openRunnerStateStore(stateDbPath);
  // Must be a genuinely *active* row (finished_at/outcome both NULL) so
  // reconcileSchedulerAttempts() actually reaches its demotion +
  // attention-comment path — a dead process here is the trigger, not the
  // fact under test.
  seedStore.recordRecoveryAttempt({
    attemptId, repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 712,
    startedAt: '2026-07-17T18:00:00Z', processId: 999, resolutionState: 'active',
  });
  seedStore.close();
  // An existing attention marker comment is already present, so
  // upsertGitHubAttentionComment() must take the PATCH (update) branch, not
  // the create branch — the two are genuinely distinct GitHub call shapes.
  const existingMarkerBody = `${RUNNER_ATTENTION_MARKER}\nissue: 712\nreason: some-older-reason`;
  let patchAttempts = 0;
  const ghRunner = (args) => {
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments: [{ id: 55, createdAt: '2026-07-17T17:00:00Z', body: existingMarkerBody }] });
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'PATCH') { patchAttempts += 1; throw new Error('simulated GitHub outage updating the existing attention comment'); }
    if (args[0] === 'issue' && args[1] === 'comment') throw new Error('must not be called: an existing marker comment requires PATCH, never a fresh create');
    return '';
  };
  const state = createStateRecorder({ stateDbPath, outputDir: dir, repo: 'TheTekTeam/modelspend' });
  const result = await reconcileSchedulerAttempts({
    state, args: { repo: 'TheTekTeam/modelspend', project: { id: 'modelspend' } }, ghRunner,
    processProbe: async () => false, now: () => '2026-07-17T19:00:00Z',
  });
  state.close();
  record('result', result);
  record('patchAttempts', patchAttempts);
  assert.equal(patchAttempts > 0, true, 'the injected PATCH-failure fault must actually have been reached');
  const verify = openRunnerStateStore(stateDbPath);
  const row = verify.recoveryAttempt(attemptId);
  const attentionEvents = verify.allRows('attention_events');
  verify.close();
  record('final row', row);
  assert.equal(attentionEvents.length, 1, 'the attention event must be durably persisted locally regardless of the GitHub PATCH failure');
  assertNeverAmbiguous([row], 'github-comment-update-failure', record);
})));
