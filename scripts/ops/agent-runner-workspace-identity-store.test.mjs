import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openRunnerStateStore } from './claude-runner-state.mjs';
import { withWorkspaceIdentitySupport } from './agent-runner-workspace-identity-store.mjs';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-identity-store-'));
  const store = withWorkspaceIdentitySupport(openRunnerStateStore(join(dir, 'state.sqlite')));
  return { dir, store };
}

test('withWorkspaceIdentitySupport adds the column lazily and recordWorktreeIdentity persists it', () => {
  const { dir, store } = tempStore();
  try {
    store.recordRecoveryAttempt({
      attemptId: 'attempt-1', repo: 'TheTekTeam/modelspend', issueNumber: 686,
      startedAt: '2026-07-23T00:00:00Z', resolutionState: 'active',
    });
    const identity = { name: 'agent-runner-686-abc', expectedBranch: 'worktree-agent-runner-686-abc' };
    const persisted = store.recordWorktreeIdentity({ attemptId: 'attempt-1', worktreeIdentity: identity });
    assert.equal(persisted, true);
    const row = store.allRows('recovery_attempts').find((r) => r.attempt_id === 'attempt-1');
    assert.deepEqual(JSON.parse(row.worktree_identity_json), identity);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordWorktreeIdentity is write-once: a later call never overwrites an already-persisted identity', () => {
  const { dir, store } = tempStore();
  try {
    store.recordRecoveryAttempt({
      attemptId: 'attempt-2', repo: 'TheTekTeam/modelspend', issueNumber: 686,
      startedAt: '2026-07-23T00:00:00Z', resolutionState: 'active',
    });
    const first = { name: 'agent-runner-686-first', expectedBranch: 'worktree-agent-runner-686-first' };
    const second = { name: 'agent-runner-686-second', expectedBranch: 'worktree-agent-runner-686-second' };
    store.recordWorktreeIdentity({ attemptId: 'attempt-2', worktreeIdentity: first });
    store.recordWorktreeIdentity({ attemptId: 'attempt-2', worktreeIdentity: second });
    const row = store.allRows('recovery_attempts').find((r) => r.attempt_id === 'attempt-2');
    assert.deepEqual(JSON.parse(row.worktree_identity_json), first);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordWorktreeIdentity is a no-op that returns false for a missing attemptId or worktreeIdentity', () => {
  const { dir, store } = tempStore();
  try {
    assert.equal(store.recordWorktreeIdentity({ attemptId: null, worktreeIdentity: { name: 'x' } }), false);
    assert.equal(store.recordWorktreeIdentity({ attemptId: 'attempt-3', worktreeIdentity: null }), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withWorkspaceIdentitySupport is idempotent across repeated calls on the same store', () => {
  const { dir, store } = tempStore();
  try {
    const again = withWorkspaceIdentitySupport(store);
    assert.equal(again, store);
    assert.doesNotThrow(() => withWorkspaceIdentitySupport(store));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
