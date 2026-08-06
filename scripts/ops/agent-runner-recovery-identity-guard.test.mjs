import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openRunnerStateStore } from './claude-runner-state.mjs';
import { RecoveryAttemptIdentityConflictError, withRecoveryIdentityGuard } from './agent-runner-recovery-identity-guard.mjs';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-identity-guard-'));
  const path = join(dir, 'state.sqlite');
  const store = withRecoveryIdentityGuard(openRunnerStateStore(path));
  return { dir, path, store };
}

test('withRecoveryIdentityGuard persists the resolved model on a fresh attempt row', () => {
  const { dir, store } = tempStore();
  try {
    store.recordRecoveryAttempt({
      attemptId: 'attempt-1', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'sonnet', harness: 'claude',
    });
    const row = store.recoveryAttempt('attempt-1');
    assert.equal(row.agent, 'claude-code-cli');
    assert.equal(row.model, 'sonnet');
    assert.equal(row.harness, 'claude');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withRecoveryIdentityGuard: a terminal write with a null model never erases an already-persisted model', () => {
  const { dir, store } = tempStore();
  try {
    store.recordRecoveryAttempt({
      attemptId: 'attempt-2', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'sonnet', harness: 'claude',
    });
    store.recordRecoveryAttempt({
      attemptId: 'attempt-2', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', finishedAt: '2026-08-03T00:05:00Z', outcome: 'completed',
      agent: null, model: null, harness: null, resolutionState: 'resolved',
    });
    const row = store.recoveryAttempt('attempt-2');
    assert.equal(row.model, 'sonnet');
    assert.equal(row.agent, 'claude-code-cli');
    assert.equal(row.harness, 'claude');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withRecoveryIdentityGuard: a later write with a different non-null model throws a fixed persisted-model-conflict error whose message and shape never leak the raw values or the attempt id', () => {
  const { dir, store } = tempStore();
  try {
    store.recordRecoveryAttempt({
      attemptId: 'attempt-3', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'sonnet', harness: 'claude',
    });
    assert.throws(() => store.recordRecoveryAttempt({
      attemptId: 'attempt-3', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'opus', harness: 'claude',
    }), (error) => {
      assert.ok(error instanceof RecoveryAttemptIdentityConflictError);
      assert.equal(error.code, 'persisted-model-conflict');
      // The error carries only a fixed code and fixed message -- never the
      // attempt id, the persisted value ('sonnet') or the incoming value
      // ('opus') -- because it can flow into createStateRecorder()'s bounded
      // errors/statePersistenceErrors diagnostics in claude-runner-cron.mjs.
      assert.ok(!error.message.includes('attempt-3'));
      assert.ok(!error.message.includes('sonnet'));
      assert.ok(!error.message.includes('opus'));
      assert.equal(error.message, 'recovery attempt identity conflict: persisted-model-conflict');
      assert.equal(error.attemptId, undefined);
      assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
      return true;
    });
    // The conflicting write must never have been applied -- the original
    // persisted model is still current.
    assert.equal(store.recoveryAttempt('attempt-3').model, 'sonnet');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withRecoveryIdentityGuard: a differing agent or harness also throws its own fixed conflict code', () => {
  const { dir, store } = tempStore();
  try {
    store.recordRecoveryAttempt({
      attemptId: 'attempt-4', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'sonnet', harness: 'claude',
    });
    assert.throws(() => store.recordRecoveryAttempt({
      attemptId: 'attempt-4', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'codex-cli', model: 'sonnet', harness: 'claude',
    }), (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'persisted-agent-mismatch');
    assert.throws(() => store.recordRecoveryAttempt({
      attemptId: 'attempt-4', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'sonnet', harness: 'codex',
    }), (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'persisted-harness-mismatch');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withRecoveryIdentityGuard: a null persisted value never conflicts with a later non-null write, and a first-ever write for an attempt id never conflicts', () => {
  const { dir, store } = tempStore();
  try {
    // A persisted-null identity (the historical #136 shape this issue
    // reconciles) has nothing to disagree with yet, so a later write
    // carrying a real identity must not throw -- the guard's own
    // responsibility is limited to refusing genuine non-null-vs-non-null
    // conflicts; it does not (and, given `recordRecoveryAttempt()`'s
    // `agent`/`model`/`harness` columns being intentionally absent from its
    // `ON CONFLICT DO UPDATE SET` clause, cannot) retroactively fill in an
    // already-persisted-null column through the ordinary write path. Filling
    // in a historical null is `reconcileRecoveryAttemptModel()`'s job.
    store.recordRecoveryAttempt({
      attemptId: 'attempt-5', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: null, model: null, harness: null,
    });
    assert.doesNotThrow(() => store.recordRecoveryAttempt({
      attemptId: 'attempt-5', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'sonnet', harness: 'claude',
    }));

    // A genuinely first-ever write for a brand-new attempt id never
    // conflicts (there is nothing persisted yet), and the resolved model is
    // durably stored when it is present on that very first write.
    store.recordRecoveryAttempt({
      attemptId: 'attempt-6', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'sonnet', harness: 'claude',
    });
    const row = store.recoveryAttempt('attempt-6');
    assert.equal(row.model, 'sonnet');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withRecoveryIdentityGuard is idempotent across repeated calls on the same store', () => {
  const { dir, store } = tempStore();
  try {
    const again = withRecoveryIdentityGuard(store);
    assert.equal(again, store);
    assert.doesNotThrow(() => withRecoveryIdentityGuard(store));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withRecoveryIdentityGuard feature-detects an injected store without recordRecoveryAttempt, leaving it unwrapped and usable', () => {
  const narrowStub = { someOtherMethod: () => 'ok' };
  const wrapped = withRecoveryIdentityGuard(narrowStub);
  assert.equal(wrapped, narrowStub);
  assert.equal(wrapped.someOtherMethod(), 'ok');
});

test('withRecoveryIdentityGuard: a recovery-capable store missing a recoveryAttempt() reader or a transactional db is unverifiable and must never write', () => {
  const calls = [];
  const noReaderStore = {
    recordRecoveryAttempt(record) { calls.push(record); return true; },
    db: { exec() {}, prepare() { return { run: () => ({ changes: 0 }), get: () => null }; } },
  };
  const wrapped = withRecoveryIdentityGuard(noReaderStore);
  assert.throws(
    () => wrapped.recordRecoveryAttempt({ attemptId: 'attempt-x', model: 'sonnet' }),
    (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'unverifiable-recovery-store',
  );
  assert.equal(calls.length, 0, 'the unguarded original write must never have been reached');

  const noDbStore = {
    recordRecoveryAttempt(record) { calls.push(record); return true; },
    recoveryAttempt() { return null; },
  };
  const wrappedNoDb = withRecoveryIdentityGuard(noDbStore);
  assert.throws(
    () => wrappedNoDb.recordRecoveryAttempt({ attemptId: 'attempt-x', model: 'sonnet' }),
    (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'unverifiable-recovery-store',
  );
  assert.equal(calls.length, 0);
});

test('withRecoveryIdentityGuard: a recovery-capable, otherwise-verifiable store refuses to write when the incoming attemptId is missing, empty or not a bounded string', () => {
  const calls = [];
  const store = {
    recordRecoveryAttempt(record) { calls.push(record); return true; },
    recoveryAttempt() { return null; },
    db: { exec() {}, prepare() { return { run: () => ({ changes: 0 }), get: () => null }; } },
  };
  const wrapped = withRecoveryIdentityGuard(store);
  for (const badAttemptId of [undefined, null, '', 42, 'x'.repeat(301)]) {
    assert.throws(
      () => wrapped.recordRecoveryAttempt({ attemptId: badAttemptId, model: 'sonnet' }),
      (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'unverifiable-recovery-store',
    );
  }
  assert.equal(calls.length, 0);
});

test('withRecoveryIdentityGuard returns the store unchanged for a null/undefined store', () => {
  assert.equal(withRecoveryIdentityGuard(null), null);
  assert.equal(withRecoveryIdentityGuard(undefined), undefined);
});

test('withRecoveryIdentityGuard: a post-write readback mismatch on an immutable column rolls back the write and throws readback-verification-failed', () => {
  const { dir, path, store: realStoreForSeed } = tempStore();
  try {
    realStoreForSeed.recordRecoveryAttempt({
      attemptId: 'attempt-drift', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'sonnet', harness: 'claude',
      restrictedHandleDigest: 'a'.repeat(64),
    });

    // A store whose `recoveryAttempt()` reader reports a tampered digest
    // only on its *second* call (the post-write readback) -- standing in
    // for the write-once `restricted_handle_digest` column somehow drifting
    // out from under a guarded write. The guard's own post-write projection
    // check must catch this and roll back rather than commit.
    const realStore = openRunnerStateStore(path);
    let readCount = 0;
    const driftingStore = {
      db: realStore.db,
      recordRecoveryAttempt: realStore.recordRecoveryAttempt.bind(realStore),
      recoveryAttempt(attemptId) {
        readCount += 1;
        const row = realStore.recoveryAttempt(attemptId);
        if (readCount === 2 && row) return { ...row, restricted_handle_digest: 'tampered-digest-value' };
        return row;
      },
    };
    const wrapped = withRecoveryIdentityGuard(driftingStore);
    assert.throws(
      () => wrapped.recordRecoveryAttempt({
        attemptId: 'attempt-drift', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
        startedAt: '2026-08-03T00:00:00Z', finishedAt: '2026-08-03T00:05:00Z', outcome: 'completed',
        agent: 'claude-code-cli', model: 'sonnet', harness: 'claude', resolutionState: 'resolved',
      }),
      (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'readback-verification-failed',
    );
    // The write must have been rolled back, not committed.
    assert.equal(realStoreForSeed.recoveryAttempt('attempt-drift').resolution_state, 'active');
    realStore.close();
  } finally {
    realStoreForSeed.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withRecoveryIdentityGuard: the guarded read-then-write is atomic against a second connection -- a competing writer cannot interleave between the read and the write (#148 TOCTOU fix)', () => {
  const { dir, path, store: storeA } = tempStore();
  const storeB = withRecoveryIdentityGuard(openRunnerStateStore(path));
  try {
    storeA.recordRecoveryAttempt({
      attemptId: 'attempt-race', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'sonnet', harness: 'claude',
    });

    // Connection A holds a raw write lock open (standing in for another
    // guarded operation already in flight against this exact row), to
    // simulate the window the old read-then-write guard was vulnerable to:
    // a second connection reading a persisted identity and deciding whether
    // it conflicts, before the first connection's own write has landed.
    storeA.db.exec('BEGIN IMMEDIATE');
    try {
      // Connection B's own guarded write must not be able to acquire its
      // own BEGIN IMMEDIATE while A's is open -- proving the read that
      // decides conflict/no-conflict and the write it gates are genuinely
      // serialized at the database level against a second connection, not
      // merely guarded by an in-process check that a same-process race
      // could still slip through.
      assert.throws(() => storeB.recordRecoveryAttempt({
        attemptId: 'attempt-race', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
        startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
        agent: 'claude-code-cli', model: 'opus', harness: 'claude',
      }));
    } finally {
      storeA.db.exec('COMMIT');
    }
    // The blocked attempt above must never have applied its conflicting
    // model -- A's held-open transaction made no changes, so the row is
    // exactly as it was before the race.
    assert.equal(storeA.recoveryAttempt('attempt-race').model, 'sonnet');

    // With A's lock released, B can now acquire its own guarded
    // transaction, re-read the persisted row fresh, and correctly detect
    // the genuine conflict its earlier, blocked attempt carried.
    assert.throws(() => storeB.recordRecoveryAttempt({
      attemptId: 'attempt-race', repo: 'TheTekTeam/agent-runner', issueNumber: 148,
      startedAt: '2026-08-03T00:00:00Z', resolutionState: 'active',
      agent: 'claude-code-cli', model: 'opus', harness: 'claude',
    }), (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'persisted-model-conflict');
    assert.equal(storeA.recoveryAttempt('attempt-race').model, 'sonnet');
  } finally {
    storeA.close();
    storeB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
