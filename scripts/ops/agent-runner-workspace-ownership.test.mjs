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

test('inspectWorkspaceOwnership uses a non-creating availability probe by default (#90)', async () => {
  const calls = [];
  const rootPath = '/repo';
  const baseHead = '7b9969e56dc3aed29cee19657bb5a83766bf0019';
  const runner = (command, args, options = {}) => {
    assert.equal(command, 'git');
    calls.push({ args: [...args], cwd: options.cwd });
    const joined = args.join(' ');
    if (joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${rootPath}\n`, stderr: '' };
    if (joined === 'fetch --quiet origin main') return { status: 0, stdout: '', stderr: '' };
    if (joined === 'rev-parse origin/main') return { status: 0, stdout: `${baseHead}\n`, stderr: '' };
    if (joined === 'symbolic-ref refs/remotes/origin/HEAD') return { status: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' };
    if (joined === `show-ref --verify --quiet refs/heads/${WORKTREE_IDENTITY.expectedBranch}`) return { status: 1, stdout: '', stderr: '' };
    if (joined === 'worktree list --porcelain') return { status: 0, stdout: '', stderr: '' };
    if (joined === 'rev-parse HEAD') return { status: 0, stdout: `${baseHead}\n`, stderr: '' };
    if (joined === 'branch --show-current') return { status: 0, stdout: 'main\n', stderr: '' };
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected git command: ${joined}` };
  };

  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    implementationCheckout: rootPath,
    attemptId: 'attempt-1',
    issueNumber: 686,
    env: { CLAUDE_RUNNER_BASE_REF: 'origin/main' },
    runner,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.action, 'create');
  assert.equal(result.worktreePath, `${rootPath}/.claude/worktrees/${WORKTREE_IDENTITY.name}`);
  assert.equal(calls.some(({ args }) => args[0] === 'worktree' && args[1] === 'add'), false);
  assert.equal(calls.some(({ args }) => args[0] === 'check-ref-format'), false);
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

test('inspectWorkspaceOwnership attributes a conflict to an attempt row whose persisted worktree_identity_json exactly matches (production shape, post-migration)', async () => {
  // `recovery_attempts.worktree_identity_json` (#686 spec section 5) is the
  // durable, write-once column a fresh dispatch persists its exact
  // branch/worktree identity into. Attribution requires an exact match
  // against it -- never mere issue-scoping.
  const activeAttempts = [{
    attempt_id: 'attempt-old', issue_number: 686, worktree_available: 1, branch_available: 1,
    worktree_identity_json: JSON.stringify(WORKTREE_IDENTITY),
  }];
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

test('inspectWorkspaceOwnership rejects issue-number-only attribution: a same-issue row with a different persisted branch is not the owner', async () => {
  const activeAttempts = [{
    attempt_id: 'attempt-old', issue_number: 686, worktree_available: 1, branch_available: 1,
    worktree_identity_json: JSON.stringify({ name: 'agent-runner-686-other', expectedBranch: 'worktree-agent-runner-686-other' }),
  }];
  const result = await inspectWorkspaceOwnership({
    worktreeIdentity: WORKTREE_IDENTITY,
    attemptId: 'attempt-new',
    issueNumber: 686,
    activeAttempts,
    processProbe: async () => false,
    prepareWorkspace: fakePrepareWorkspace({ allowed: false, failureReason: 'implementation-worktree-branch-already-exists' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'workspace-ownership-unknown');
  assert.equal(result.evidence.matchingAttempt, null);
});

test('inspectWorkspaceOwnership fails closed to workspace-ownership-unknown for a legacy attempt row with no persisted workspace identity', async () => {
  // A row written before the worktree_identity_json column existed (or by a
  // caller that never populated it) must never be inferred as the owner
  // merely because it is scoped to the same issue -- issue N can have many
  // historical attempts (#686 spec section 5).
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
  assert.equal(result.reason, 'workspace-ownership-unknown');
  assert.deepEqual(result.safeActions, ['preserve-untouched', 'manual-operator-inspection']);
  assert.equal(result.evidence.matchingAttempt, null);
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
