import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CandidateRevalidationUnavailableError } from './agent-runner-atomic-candidate-store.mjs';
import { main } from './agent-runner-atomic-cron.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';

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
