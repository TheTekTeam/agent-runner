import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateGuardedCleanupPrecondition,
  evaluateSameAttemptReuse,
  inspectWorkspaceOwnership,
} from './agent-runner-workspace-ownership.mjs';

const WORKTREE_IDENTITY = { name: 'agent-runner-686-abc123', expectedBranch: 'worktree-agent-runner-686-abc123' };

function fakePrepareWorkspace(result) {
  return () => result;
}

test('inspectWorkspaceOwnership allows a genuinely fresh workspace', async () => {
  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    attemptId: 'attempt-1',
    issueNumber: 686,
    prepareWorkspace: fakePrepareWorkspace({ allowed: true, worktreePath: '/repo/.claude/worktrees/agent-runner-686-abc123' }),
  });
  assert.equal(result.allowed, true);
  assert.equal(result.action, 'create');
  assert.equal(result.ownership, 'new');
  assert.equal(result.worktreePath, '/repo/.claude/worktrees/agent-runner-686-abc123');
  assert.equal(result.branchName, WORKTREE_IDENTITY.expectedBranch);
});

test('inspectWorkspaceOwnership passes a pre-existing git/infra failure through unchanged', async () => {
  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    attemptId: 'attempt-1',
    issueNumber: 686,
    prepareWorkspace: fakePrepareWorkspace({ allowed: false, failureReason: 'implementation-base-fetch-failed' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'implementation-base-fetch-failed');
});

test('inspectWorkspaceOwnership reports workspace-ownership-unknown for a conflicting branch no attempt row references (#686 proven failure shape)', async () => {
  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    attemptId: 'attempt-1',
    issueNumber: 686,
    activeAttempts: [],
    prepareWorkspace: fakePrepareWorkspace({ allowed: false, failureReason: 'implementation-worktree-branch-already-exists' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'workspace-ownership-unknown');
  assert.deepEqual(result.safeActions, ['preserve-untouched', 'manual-operator-inspection']);
  assert.equal(result.evidence.gitFailureReason, 'implementation-worktree-branch-already-exists');
});

test('inspectWorkspaceOwnership attributes a conflict to the issue-scoped attempt row even though real recovery_attempts rows carry no branch/worktree column (production shape)', async () => {
  // `recovery_attempts` only ever persists `worktree_available`/
  // `branch_available` booleans, never the actual branch/worktree name --
  // this fixture deliberately omits `expected_branch`/`worktree_name` to
  // match what a real row looks like. Attribution must not degrade to
  // workspace-ownership-unknown just because that column doesn't exist.
  const activeAttempts = [{ attempt_id: 'attempt-old', issue_number: 686, worktree_available: 1, branch_available: 1 }];
  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    attemptId: 'attempt-new',
    issueNumber: 686,
    activeAttempts,
    processProbe: async () => false,
    prepareWorkspace: fakePrepareWorkspace({ allowed: false, failureReason: 'implementation-worktree-branch-already-exists' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'workspace-owned-by-unresolved-attempt');
  assert.equal(result.evidence.matchingAttempt.attemptId, 'attempt-old');
});

test('inspectWorkspaceOwnership attributes a conflict to a live other attempt', async () => {
  const activeAttempts = [{ attempt_id: 'attempt-old', expected_branch: WORKTREE_IDENTITY.expectedBranch, process_id: 123, process_boot_id: 'boot', process_start_ticks: '1' }];
  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    attemptId: 'attempt-new',
    issueNumber: 686,
    activeAttempts,
    processProbe: async () => true,
    prepareWorkspace: fakePrepareWorkspace({ allowed: false, failureReason: 'implementation-worktree-branch-already-exists' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'workspace-owned-by-live-attempt');
  assert.equal(result.evidence.matchingAttempt.attemptId, 'attempt-old');
});

test('inspectWorkspaceOwnership attributes a conflict to an unresolved (dead-process) other attempt', async () => {
  const activeAttempts = [{ attempt_id: 'attempt-old', expected_branch: WORKTREE_IDENTITY.expectedBranch }];
  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    attemptId: 'attempt-new',
    issueNumber: 686,
    activeAttempts,
    processProbe: async () => false,
    prepareWorkspace: fakePrepareWorkspace({ allowed: false, failureReason: 'implementation-worktree-already-exists' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'workspace-owned-by-unresolved-attempt');
});

test('inspectWorkspaceOwnership attributes a conflict to a resolved/terminal attempt as recovery-required, not a bare branch-exists reason', async () => {
  const activeAttempts = [{ attempt_id: 'attempt-old', expected_branch: WORKTREE_IDENTITY.expectedBranch, finished_at: '2026-01-01T00:00:00Z', outcome: 'completed' }];
  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    attemptId: 'attempt-new',
    issueNumber: 686,
    activeAttempts,
    prepareWorkspace: fakePrepareWorkspace({ allowed: false, failureReason: 'implementation-worktree-branch-already-exists' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'workspace-owned-by-unresolved-attempt');
  assert.equal(result.evidence.matchingAttempt.outcome, 'completed');
});

test('inspectWorkspaceOwnership never leaks raw process identifiers or attempt payloads into evidence', async () => {
  const activeAttempts = [{ attempt_id: 'attempt-old', expected_branch: WORKTREE_IDENTITY.expectedBranch, process_id: 999, restricted_evidence: { secret: 'token-should-not-leak' } }];
  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    attemptId: 'attempt-new',
    issueNumber: 686,
    activeAttempts,
    processProbe: async () => false,
    prepareWorkspace: fakePrepareWorkspace({ allowed: false, failureReason: 'implementation-worktree-branch-already-exists' }),
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('token-should-not-leak'));
  assert.ok(!serialized.includes('999'));
});

test('evaluateSameAttemptReuse only allows reuse when every ownership fact matches', () => {
  const allTrue = {
    repositoryMatches: true, issueMatches: true, managerPreflightRevisionMatches: true, attemptIdMatches: true,
    expectedBranchMatches: true, expectedWorktreeMatches: true, leaseMatches: true, processIdentityMatches: true,
    worktreeHeadMatches: true,
  };
  assert.equal(evaluateSameAttemptReuse(allTrue).allowed, true);
  assert.equal(evaluateSameAttemptReuse({ ...allTrue, leaseMatches: false }).allowed, false);
  assert.deepEqual(evaluateSameAttemptReuse({ ...allTrue, leaseMatches: false }).failedFacts, ['leaseMatches']);
  // A resumable checkpoint substitutes for a live process identity match.
  assert.equal(evaluateSameAttemptReuse({ ...allTrue, processIdentityMatches: false, resumableCheckpointValid: true }).allowed, true);
  assert.equal(evaluateSameAttemptReuse({}).allowed, false);
});

test('evaluateGuardedCleanupPrecondition fails closed on any missing fact', () => {
  const allTrue = {
    noLiveProcess: true, noCurrentLease: true, noUnresolvedClaim: true, noUnpushedCommit: true,
    noDirtyFiles: true, noLinkedOpenPr: true, identityBelongsToTerminalAttempt: true,
  };
  assert.equal(evaluateGuardedCleanupPrecondition(allTrue).allowed, true);
  assert.equal(evaluateGuardedCleanupPrecondition({ ...allTrue, noLinkedOpenPr: false }).allowed, false);
  assert.equal(evaluateGuardedCleanupPrecondition().allowed, false);
});
