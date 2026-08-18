import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CandidateRevalidationUnavailableError } from './agent-runner-atomic-candidate-store.mjs';
import { main as atomicCronMain } from './agent-runner-atomic-cron.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';


const AVAILABLE_QUOTA_RUNNER = () => ({
  status: 0,
  signal: null,
  stdout: JSON.stringify({
    status: 'available',
    state: {
      quotaUsage: {
        session: { usedPercent: 0, resetAt: null, resetText: null },
        weekly: { usedPercent: 0, resetAt: null, resetText: null },
      },
    },
  }),
  stderr: '',
});

// Historical execute-path fixtures used --skip-quota-preflight only to avoid
// launching a real quota probe. #256 makes that production bypass invalid.
// Adapt those fixtures to execute with positive bounded synthetic quota
// evidence instead: the legacy option is removed before production parsing,
// and the normal quota preflight/admission path still runs through an injected
// process result. Tests that exercise the legacy flag itself call parseArgs or
// assertMandatoryQuotaPreflight directly and therefore remain unadapted.
function main(argv = [], env = {}, dependencies = {}) {
  let execute = ['1', 'true', 'yes', 'on'].includes(
    String(env?.CLAUDE_RUNNER_CRON_EXECUTE || '').trim().toLowerCase(),
  );
  for (const arg of argv) {
    if (arg === '--execute') execute = true;
    else if (arg === '--dry-run') execute = false;
  }
  const legacySkipRequested = argv.includes('--skip-quota-preflight')
    || ['1', 'true', 'yes', 'on'].includes(
      String(env?.CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT || '').trim().toLowerCase(),
    );
  if (!execute || !legacySkipRequested) return atomicCronMain(argv, env, dependencies);

  const effectiveArgv = argv.filter((arg) => arg !== '--skip-quota-preflight');
  const effectiveEnv = { ...env, CLAUDE_RUNNER_CRON_SKIP_QUOTA_PREFLIGHT: 'false' };
  return atomicCronMain(effectiveArgv, effectiveEnv, {
    ...dependencies,
    quotaRunner: dependencies.quotaRunner || AVAILABLE_QUOTA_RUNNER,
  });
}

const TEST_FP = `sha256:${'a'.repeat(64)}`;
// #56: dispatch-resolution authority is now required for every
// implementation packet -- approved_repository_scope/approved_branch/
// base_commit must be present or admission fails closed before this
// fixture's assertions even run.
function managerPacket(id) {
  return { id, databaseId: id, createdAt: '2026-07-17T19:00:00Z', user: { login: 'gpcola' }, body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: ATOMIC.${id}\nfingerprint: ${TEST_FP}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\napproved_repository_scope:\n  - TheTekTeam/modelspend\napproved_branch: test/atomic-${id}\nbase_commit: ${'0'.repeat(40)}\nscope:\n  - bounded test scope\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\`\nBounded task.` };
}

function readyIssueGhRunner({ number, comments, mutatingCalls }) {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    if (args[0] === 'issue' && args[1] === 'list') {
      const labels = args.flatMap((value, index) => value === '--label' ? [args[index + 1]] : []);
      if (labels.includes('status:ready') && labels.includes('agent:claude-code-cli')) {
        return JSON.stringify([{
          number, title: 'Standalone candidate admission', body: 'x', updatedAt: '2026-07-17T19:00:00Z',
          labels: [{ name: 'status:ready' }, { name: 'agent:claude-code-cli' }, { name: 'priority:P0' }],
        }]);
      }
      return JSON.stringify([]);
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ comments });
    if (args[0] === 'issue' && ['edit', 'comment'].includes(args[1])) { mutatingCalls.push(args); return ''; }
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`);
  };
}

test('atomic cron reports a missing candidate-admission module as a code failure, never runner_state_unavailable', async () => {
  // Reproduces the reported #686 canary evidence through the actual
  // production seam (`bin/run-project.sh` execs this module's main()): a
  // real, otherwise-healthy selection reaches the initial-attempt insert,
  // and the atomic revalidation subprocess fails the way it did when
  // `agent-runner-atomic-candidate-store.mjs` pointed the spawned
  // candidate-admission subprocess at the removed
  // `claude-runner-cron-base.mjs` module. Before the fix, the imported
  // scheduler's own state recorder swallowed this as a generic store
  // failure and reported `runner_state_unavailable` even though SQLite
  // never failed; this wrapper must correct that.
  const dir = mkdtempSync(join(tmpdir(), 'atomic-cron-missing-module-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const comments = [managerPacket(7)];
  const mutatingCalls = [];
  let childCalls = 0;
  const diagnostics = [];
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token', CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola', CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true' }, {
      ghRunner: readyIssueGhRunner({ number: 686, comments, mutatingCalls }),
      inspectWorkspaceOwnership: async () => ({ allowed: true }),
      revalidateCandidate: () => {
        throw new CandidateRevalidationUnavailableError(
          "atomic candidate revalidation failed with exit 1: Error [ERR_MODULE_NOT_FOUND]: Cannot find module "
            + "'/repo/scripts/ops/claude-runner-cron-base.mjs' imported from "
            + "'/repo/scripts/ops/agent-runner-candidate-admission.mjs'",
          { missingModule: true },
        );
      },
      runChild: async () => { childCalls += 1; throw new Error('must not launch child'); },
      logger: { error: (message) => diagnostics.push(message) },
    });

    assert.equal(exitCode, 1, 'must stay fail-closed, never the handled exit-0 path');
    assert.equal(mutatingCalls.length, 0, 'no GitHub mutation before fail-closed pause');
    assert.equal(childCalls, 0, 'no child launch before fail-closed pause');

    const printed = diagnostics.map((line) => JSON.parse(line));
    assert.equal(printed.some((payload) => payload.reason === 'runner_state_unavailable'), false,
      'a missing module must never be misreported as a state-store failure');
    const corrected = printed.find((payload) => payload.reason === 'runner_code_unavailable');
    assert.ok(corrected, 'the corrected missing-code evidence must be emitted');
    assert.equal(corrected.systemicPause, true);
    assert.doesNotMatch(corrected.safeNextAction, /SQLite/i);
    assert.match(corrected.candidateRevalidationFailure, /ERR_MODULE_NOT_FOUND/);

    const state = openRunnerStateStore(stateDbPath);
    try {
      assert.equal(state.countRows('recovery_attempts'), 0, 'the paused initial attempt must never be persisted');
      assert.equal(state.countRows('claims'), 0);

      // The imported scheduler's own `emitSystemicStatePause` persists its
      // (mislabelled) reason into `queue_events` and
      // `runner_health_conditions` *before* control returns to this
      // wrapper's main() — a correction that only touches stdout would
      // leave the durable audit trail, and the dashboard that reads
      // `runner_health_conditions` directly, still saying the SQLite store
      // is unavailable. Both persisted rows must carry the corrected reason.
      const queueEvent = state.allRows('queue_events').find((row) => row.event_type === 'systemic-pause');
      assert.ok(queueEvent, 'a systemic-pause queue event must still be recorded (this stays fail-closed/systemic)');
      assert.notEqual(queueEvent.reason, 'runner_state_unavailable');
      assert.equal(queueEvent.reason, 'runner_code_unavailable');

      const healthCondition = state.allRows('runner_health_conditions').find((row) => row.condition_type === 'systemic_pause');
      assert.ok(healthCondition, 'a systemic_pause health condition must still be opened (dashboard-visible, fail-closed)');
      assert.notEqual(healthCondition.reason, 'runner_state_unavailable');
      assert.equal(healthCondition.reason, 'runner_code_unavailable');
    } finally { state.close(); }
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic cron distinguishes a generic candidate-revalidation-subprocess failure from a missing-module failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-cron-revalidation-failure-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const comments = [managerPacket(8)];
  const mutatingCalls = [];
  const diagnostics = [];
  const originalLog = console.log;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token', CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola', CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true' }, {
      ghRunner: readyIssueGhRunner({ number: 687, comments, mutatingCalls }),
      inspectWorkspaceOwnership: async () => ({ allowed: true }),
      revalidateCandidate: () => {
        throw new CandidateRevalidationUnavailableError('atomic candidate revalidation failed with exit 1: TypeError: boom', { missingModule: false });
      },
      runChild: async () => { throw new Error('must not launch child'); },
      logger: { error: (message) => diagnostics.push(message) },
    });

    assert.equal(exitCode, 1);
    const printed = diagnostics.map((line) => JSON.parse(line));
    const corrected = printed.find((payload) => payload.reason === 'candidate_revalidation_unavailable');
    assert.ok(corrected, 'the atomic-revalidation-subprocess-specific evidence must be emitted');
    assert.equal(printed.some((payload) => payload.reason === 'runner_state_unavailable'), false);
    assert.equal(printed.some((payload) => payload.reason === 'runner_code_unavailable'), false);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic cron leaves a genuine candidate denial (not a revalidation-subprocess failure) as the pre-existing handled pause', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-cron-candidate-denied-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const comments = [managerPacket(9)];
  const mutatingCalls = [];
  const originalLog = console.log;
  let printed = null;
  try {
    console.log = (value) => { printed = String(value); };
    const exitCode = await main([
      '--execute', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token', CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola', CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true' }, {
      ghRunner: readyIssueGhRunner({ number: 688, comments, mutatingCalls }),
      inspectWorkspaceOwnership: async () => ({ allowed: true }),
      revalidateCandidate: ({ expected }) => ({
        admission: { allowed: false, reason: 'candidate-preflight-revision-changed' },
        initial: expected,
        current: { ...expected, preflightRevision: 'github-comment:database-id:999' },
      }),
      runChild: async () => { throw new Error('must not launch child'); },
    });
    assert.equal(exitCode, 0, 'a legitimate candidate denial remains the pre-existing handled (exit 0) outcome');
    const payload = JSON.parse(printed);
    assert.equal(payload.candidatePaused, true);
    assert.equal(payload.reason, 'candidate-preflight-revision-changed');
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic cron reaches durable attempt-start persistence through the production wrapped store, with no nested transaction, no GitHub mutation and no child launch', async () => {
  // #158: the production entrypoint (`bin/run-project.sh` ->
  // `agent-runner-pinned-atomic-cron.mjs` -> this module) composes the
  // runner-state store as admission-proxy(liveness-proxy(store)). Attaching
  // the #148 recovery-identity guard *above* those delegating layers made
  // its `original` resolve back into the guard itself, so `attempt-start`
  // opened `BEGIN IMMEDIATE` twice on the one SQLite connection and every
  // implementation dispatch failed with `runner_state_unavailable` /
  // `cannot start a transaction within a transaction`. No existing test
  // covered an *admitted* candidate all the way through this composition --
  // the ones above all deny or break revalidation first -- which is exactly
  // how the defect reached production. This is that missing path.
  const dir = mkdtempSync(join(tmpdir(), 'atomic-cron-attempt-start-'));
  const lockPath = join(dir, 'cron.lock');
  const stateDbPath = join(dir, 'state.sqlite');
  const comments = [managerPacket(10)];
  const mutatingCalls = [];
  const diagnostics = [];
  const originalLog = console.log;
  // Durable evidence read at the child-launch boundary: the attempt must
  // already be persisted before the runner ever considers launching a child.
  let attemptsAtChildBoundary = null;
  let childLaunches = 0;
  try {
    console.log = () => {};
    const exitCode = await main([
      '--execute', '--no-claim', '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', lockPath, '--agent-labels', 'agent:claude-code-cli',
    ], { GH_TOKEN: 'test-token', CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola', CLAUDE_RUNNER_ALLOW_IMPLEMENTATION: 'true' }, {
      ghRunner: readyIssueGhRunner({ number: 689, comments, mutatingCalls }),
      inspectWorkspaceOwnership: async () => ({ allowed: true }),
      revalidateCandidate: ({ expected }) => ({
        admission: { allowed: true, reason: 'candidate-admitted' },
        initial: expected,
        current: expected,
      }),
      // Never spawns a real child: it only records the durable state that
      // already existed when the scheduler reached the launch boundary.
      runChild: async () => {
        childLaunches += 1;
        const probe = openRunnerStateStore(stateDbPath);
        try { attemptsAtChildBoundary = probe.allRows('recovery_attempts'); } finally { probe.close(); }
        return { status: 4, signal: null, error: null, stdout: '', stderr: '' };
      },
      logger: { error: (message) => diagnostics.push(message) },
    });

    // stderr deliberately redacts the raw store errors to
    // `<restricted local log>` (#148), so the unredacted proof that no
    // nested transaction was raised lives in the bounded local run logs.
    const runLogs = readdirSync(dir).filter((name) => name.startsWith('cron-') && name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
    const nested = runLogs.flatMap((payload) => payload.restrictedStateErrors || [])
      .filter((entry) => String(entry.message).includes('cannot start a transaction within a transaction'));
    assert.deepEqual(nested, [], 'the nested recovery-attempt transaction must never occur through the production composition');
    assert.equal(runLogs.some((payload) => payload.systemicPause === true), false,
      'attempt-start must not raise a systemic state pause');
    assert.equal(diagnostics.some((line) => String(line).includes('runner_state_unavailable')), false,
      'attempt-start must not report the state store as unavailable');
    assert.equal(typeof exitCode, 'number');

    assert.equal(childLaunches, 1, 'the scheduler must reach the child-launch boundary');
    assert.ok(Array.isArray(attemptsAtChildBoundary), 'attempt rows must be readable at the child-launch boundary');
    assert.equal(attemptsAtChildBoundary.length, 1, 'exactly one attempt row must be durably persisted before any child launch');
    const persisted = attemptsAtChildBoundary[0];
    assert.equal(persisted.issue_number, 689);
    assert.equal(persisted.agent, 'claude-code-cli');
    assert.equal(persisted.harness, 'claude');
    assert.equal(persisted.phase, 'starting');
    assert.equal(persisted.resolution_state, 'active');
    assert.equal(persisted.manager_preflight_revision, 'ATOMIC.10');
    assert.equal(persisted.manager_preflight_fingerprint, TEST_FP);

    assert.equal(mutatingCalls.length, 0, 'no GitHub label/comment mutation is needed to reach durable attempt persistence');

    const state = openRunnerStateStore(stateDbPath);
    try {
      assert.equal(state.countRows('recovery_attempts'), 1, 'the attempt row must survive the pass');
      assert.equal(state.countRows('claims'), 0, 'no claim is written on the --no-claim path');
      const systemicPause = state.allRows('queue_events').find((row) => row.event_type === 'systemic-pause');
      assert.equal(systemicPause, undefined, 'attempt-start must not raise a systemic state pause');
      // A failed/rolled-back transaction (or a leaked open one) would make
      // this probe throw; the connection must be usable and unlocked.
      assert.equal(state.assertWritable(), true);
    } finally { state.close(); }
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
