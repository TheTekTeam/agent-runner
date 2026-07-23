import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStateRecorder } from './claude-runner-cron.mjs';
import {
  collectWorkspaceReconciliationReport,
  executeGuardedWorkspaceCleanup,
  parseArgs,
  scanLocalWorkspaceEvidence,
} from './agent-runner-reconcile-workspace.mjs';

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepoWithIssueBranch(issueNumber) {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-root-'));
  git(['init', '--quiet', '-b', 'main'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'Test'], root);
  execFileSync('sh', ['-c', 'echo hello > file.txt'], { cwd: root });
  git(['add', 'file.txt'], root);
  git(['commit', '--quiet', '-m', 'init'], root);
  const branch = `worktree-agent-runner-${issueNumber}-abc123`;
  git(['branch', branch], root);
  const worktreePath = join(root, '.claude', 'worktrees', `agent-runner-${issueNumber}-abc123`);
  git(['worktree', 'add', worktreePath, branch], root);
  return { root, branch, worktreePath };
}

test('parseArgs requires --project and --issue, and requires exact identifiers for --execute', () => {
  assert.throws(() => parseArgs(['--issue', '686']), /--project is required/);
  assert.throws(() => parseArgs(['--project', 'modelspend']), /--issue must be a positive integer/);
  assert.throws(() => parseArgs(['--project', 'modelspend', '--issue', '686', '--execute']), /requires --attempt-id/);
  const inspectArgs = parseArgs(['--project', 'modelspend', '--issue', '686']);
  assert.equal(inspectArgs.inspectOnly, true);
  assert.equal(inspectArgs.execute, false);
  const executeArgs = parseArgs(['--project', 'modelspend', '--issue', '686', '--attempt-id', 'a1', '--branch', 'b', '--worktree', '/w', '--execute']);
  assert.equal(executeArgs.execute, true);
  assert.equal(executeArgs.inspectOnly, false);
});

test('scanLocalWorkspaceEvidence finds only branches/worktrees referencing the exact issue number', () => {
  const { root, branch, worktreePath } = initRepoWithIssueBranch(686);
  try {
    const evidence = scanLocalWorkspaceEvidence(root, 686);
    assert.equal(evidence.available, true);
    assert.ok(evidence.branches.some((b) => b.name === branch));
    assert.ok(evidence.worktrees.some((w) => w.path === worktreePath && w.branch === branch));
    assert.equal(evidence.worktrees.find((w) => w.path === worktreePath).dirty, false);
    // A different issue number sharing a common prefix must not match.
    const unrelated = scanLocalWorkspaceEvidence(root, 68);
    assert.equal(unrelated.branches.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanLocalWorkspaceEvidence reports available:false for a missing checkout, never throws', () => {
  const evidence = scanLocalWorkspaceEvidence('/nonexistent/path/for/reconcile-test', 686);
  assert.equal(evidence.available, false);
  assert.deepEqual(evidence.branches, []);
  assert.deepEqual(evidence.worktrees, []);
});

test('collectWorkspaceReconciliationReport recommends preserving a workspace with a linked open PR', async () => {
  const { root } = initRepoWithIssueBranch(686);
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-db-'));
  try {
    const dbPath = join(dir, 'state.sqlite');
    const state = createStateRecorder({ repo: 'TheTekTeam/modelspend', stateDbPath: dbPath, outputDir: dir });
    state.record('recordRecoveryAttempt', {
      attemptId: 'attempt-686', repo: 'TheTekTeam/modelspend', issueNumber: 686,
      startedAt: '2026-07-23T00:00:00Z', finishedAt: '2026-07-23T00:05:00Z', outcome: 'implementation_worktree_branch_already_exists',
      resolutionState: 'unresolved',
    });
    state.close();

    const report = await collectWorkspaceReconciliationReport({
      repo: 'TheTekTeam/modelspend', issueNumber: 686, dbPath, localRepoPath: root,
      processProbe: async () => false,
      ghRunner: () => ({ ok: true, stdout: JSON.stringify([{ number: 42, title: 'Fix #686', url: 'https://example/42', headRefName: 'worktree-agent-runner-686-abc123', isDraft: true }]) }),
    });
    assert.equal(report.matchingAttempts.length, 1);
    assert.equal(report.matchingAttempts[0].attemptId, 'attempt-686');
    assert.equal(report.linkedOpenPullRequests.length, 1);
    assert.equal(report.recommendedSafeAction, 'preserve-linked-open-pr-requires-explicit-decision');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectWorkspaceReconciliationReport recommends nothing-to-reconcile when no evidence exists anywhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-empty-'));
  try {
    const dbPath = join(dir, 'state.sqlite');
    const report = await collectWorkspaceReconciliationReport({
      repo: 'TheTekTeam/modelspend', issueNumber: 999999, dbPath, localRepoPath: null,
      ghRunner: () => ({ ok: true, stdout: '[]' }),
    });
    assert.equal(report.matchingAttempts.length, 0);
    assert.equal(report.recommendedSafeAction, 'nothing-to-reconcile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeGuardedWorkspaceCleanup refuses when a linked open PR exists, and mutates nothing', async () => {
  const { root, branch, worktreePath } = initRepoWithIssueBranch(777);
  try {
    const result = await executeGuardedWorkspaceCleanup({
      repo: 'TheTekTeam/modelspend', issueNumber: 777, attemptId: 'attempt-777', branch, worktree: worktreePath,
      dbPath: join(root, 'does-not-exist.sqlite'), localRepoPath: root,
      ghRunner: () => ({ ok: true, stdout: JSON.stringify([{ number: 1, title: 'x', url: 'y', headRefName: branch, isDraft: true }]) }),
    });
    assert.equal(result.executed, false);
    assert.equal(result.reason, 'guarded-cleanup-precondition-failed');
    assert.ok(result.failedFacts.includes('noLinkedOpenPr'));
    // Nothing was removed.
    const evidence = scanLocalWorkspaceEvidence(root, 777);
    assert.equal(evidence.worktrees.length, 1);
    assert.equal(evidence.branches.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executeGuardedWorkspaceCleanup performs a narrow worktree/branch removal only once every precondition is proven', async () => {
  const { root, branch, worktreePath } = initRepoWithIssueBranch(888);
  // The guarded cleanup requires proof the branch was pushed to origin
  // (fail-closed on "no remote configured" is correct — a real production
  // checkout always has one). Set up a bare remote and push so this test
  // exercises the fully-eligible path rather than the missing-remote one.
  const remote = mkdtempSync(join(tmpdir(), 'reconcile-remote-'));
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-cleanup-db-'));
  try {
    git(['init', '--quiet', '--bare'], remote);
    git(['remote', 'add', 'origin', remote], root);
    git(['push', '--quiet', 'origin', branch], root);
    // A terminal (resolved) attempt row is required: an unknown/manual
    // workspace with no attempt bookkeeping at all must never be treated as
    // cleanup-eligible (spec section 3, "unknown or manual workspace").
    const dbPath = join(dir, 'state.sqlite');
    const state = createStateRecorder({ repo: 'TheTekTeam/modelspend', stateDbPath: dbPath, outputDir: dir });
    state.record('recordRecoveryAttempt', {
      attemptId: 'attempt-888', repo: 'TheTekTeam/modelspend', issueNumber: 888,
      startedAt: '2026-07-23T00:00:00Z', finishedAt: '2026-07-23T00:05:00Z', outcome: 'workspace_owned_by_unresolved_attempt',
      resolutionState: 'resolved',
    });
    state.close();
    const result = await executeGuardedWorkspaceCleanup({
      repo: 'TheTekTeam/modelspend', issueNumber: 888, attemptId: 'attempt-888', branch, worktree: worktreePath,
      dbPath, localRepoPath: root,
      ghRunner: () => ({ ok: true, stdout: '[]' }),
    });
    assert.equal(result.executed, true);
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchDeleted, true);
    const evidence = scanLocalWorkspaceEvidence(root, 888);
    assert.equal(evidence.worktrees.length, 0);
    assert.equal(evidence.branches.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
