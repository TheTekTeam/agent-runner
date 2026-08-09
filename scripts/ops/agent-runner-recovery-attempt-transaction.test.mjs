/**
 * #158 (RUNNER.STATE.TXN.1): exactly one layer may own the recovery-attempt
 * identity transaction.
 *
 * The live failure was a nested `BEGIN IMMEDIATE` on the single runner-state
 * SQLite connection at `attempt-start`. Both `BEGIN`s came from the *same*
 * #148 guard: `createStateRecorder()` applied `withRecoveryIdentityGuard()`
 * to whatever `openStore` returned, and in production that is the
 * admission-proxy(liveness-proxy(store)) composition built by
 * `agent-runner-atomic-cron.mjs`. Neither proxy defines a `set` trap, so the
 * guard's `store.recordRecoveryAttempt = ...` installation fell through to
 * the innermost store, while the `original` it had captured was the outer
 * admission proxy's own method -- which re-resolves `recordRecoveryAttempt`
 * by property lookup on its target and therefore re-entered the guard.
 *
 * These regressions run the *actual exported production composition*
 * (`openAtomicRunnerStateStore()`) behind the *actual production state
 * recorder* (`createStateRecorder()`) against a disposable temporary SQLite
 * database -- never live runner state -- and assert both the fix and every
 * #148 guarantee it must not weaken.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openAtomicRunnerStateStore } from './agent-runner-atomic-cron.mjs';
import { withRecoveryIdentityGuard } from './agent-runner-recovery-identity-guard.mjs';
import { createStateRecorder } from './claude-runner-cron.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';

const ATTEMPT_ID = 'TheTekTeam/agent-runner#158:2026-08-09T12:00:00.000Z';
const FINGERPRINT = `sha256:${'6'.repeat(64)}`;
const BODY_DIGEST = `sha256:${'7'.repeat(64)}`;

function attemptPayload(overrides = {}) {
  return {
    attemptId: ATTEMPT_ID,
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 158,
    phase: 'starting',
    agent: 'claude-code-cli',
    model: 'claude-opus-5',
    harness: 'claude',
    managerPreflightRevision: 'AR158-MANAGER-2026-08-09.3',
    managerPreflightFingerprint: FINGERPRINT,
    managerPreflightBodyDigest: BODY_DIGEST,
    managerAuthorityKey: 'agent-runner-manager-preflight/v1:AR158-MANAGER-2026-08-09.3',
    startedAt: '2026-08-09T12:00:00.000Z',
    resolutionState: 'active',
    ...overrides,
  };
}

/**
 * The exact production wiring: `createStateRecorder()` over the exported
 * `agent-runner-atomic-cron.mjs` composition, on a temporary database. The
 * innermost store's `db.exec` is traced so every transaction statement that
 * reaches the one connection is observable.
 */
function productionRecorder({ revalidate = () => ({ admission: { allowed: true, reason: 'candidate-admitted' } }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ar158-attempt-txn-'));
  const dbPath = join(dir, 'state.sqlite');
  const transactionStatements = [];
  let inner = null;
  const openStore = (path) => {
    inner = openRunnerStateStore(path);
    const exec = inner.db.exec.bind(inner.db);
    inner.db.exec = (sql) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|END)\b/i.test(String(sql))) transactionStatements.push(String(sql).trim());
      return exec(sql);
    };
    return inner;
  };
  const state = createStateRecorder(
    { stateDbPath: dbPath, outputDir: dir },
    (path) => openAtomicRunnerStateStore(path, { openStore, revalidate }),
  );
  return {
    dir,
    state,
    transactionStatements,
    get store() { return inner; },
    // Reads straight from the connection, bypassing every wrapper (and any
    // reader a test has stubbed) so durability claims are never self-reported.
    rawRow(attemptId = ATTEMPT_ID) {
      return inner.db.prepare('SELECT * FROM recovery_attempts WHERE attempt_id = ?').get(attemptId) || null;
    },
    cleanup() {
      try { state.close(); } catch { /* the store may already be closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function beginCount(statements) {
  return statements.filter((sql) => /^BEGIN\b/i.test(sql)).length;
}

test('#158: a fresh recovery attempt persists through the real production wrapped path inside exactly one transaction', () => {
  const harness = productionRecorder();
  try {
    const persisted = harness.state.record('recordRecoveryAttempt', attemptPayload());

    assert.equal(persisted, true, 'attempt-start must reach durable persistence');
    assert.deepEqual(harness.state.errors, [], 'no state-store error may be recorded');

    const row = harness.rawRow();
    assert.ok(row, 'the attempt row must be committed to the temporary database');
    assert.equal(row.agent, 'claude-code-cli');
    assert.equal(row.model, 'claude-opus-5');
    assert.equal(row.harness, 'claude');
    assert.equal(row.repo, 'TheTekTeam/agent-runner');
    assert.equal(row.issue_number, 158);
    assert.equal(row.manager_preflight_revision, 'AR158-MANAGER-2026-08-09.3');
    assert.equal(row.manager_preflight_fingerprint, FINGERPRINT);
    assert.equal(row.manager_preflight_body_digest, BODY_DIGEST);

    // #148 atomicity is preserved: one BEGIN IMMEDIATE, one COMMIT.
    assert.deepEqual(harness.transactionStatements, ['BEGIN IMMEDIATE', 'COMMIT']);
  } finally {
    harness.cleanup();
  }
});

test('#158: no nested BEGIN reaches the connection, and the composed store is guarded exactly once', () => {
  const harness = productionRecorder();
  try {
    // `createStateRecorder()` already applied `withRecoveryIdentityGuard()`
    // to this composition; re-applying it must be an exact no-op, because a
    // second guard layer is precisely what nested the transaction.
    const composed = openAtomicRunnerStateStore(join(harness.dir, 'state.sqlite'), {
      openStore: () => harness.store,
      revalidate: () => ({ admission: { allowed: true } }),
    });
    assert.equal(withRecoveryIdentityGuard(composed), composed,
      'the guard marker must be visible through the delegating layers');

    harness.transactionStatements.length = 0;
    assert.equal(harness.state.record('recordRecoveryAttempt', attemptPayload()), true);
    // A later, ordinary (terminal) write takes the same single-owner path.
    assert.equal(harness.state.record('recordRecoveryAttempt', attemptPayload({
      phase: 'finished', finishedAt: '2026-08-09T12:30:00.000Z', outcome: 'completed',
      agent: null, model: null, harness: null, resolutionState: 'resolved',
    })), true);

    assert.equal(beginCount(harness.transactionStatements), 2, 'exactly one BEGIN per write');
    assert.deepEqual(harness.transactionStatements, ['BEGIN IMMEDIATE', 'COMMIT', 'BEGIN IMMEDIATE', 'COMMIT']);
    for (let index = 1; index < harness.transactionStatements.length; index += 1) {
      const previous = harness.transactionStatements[index - 1];
      const current = harness.transactionStatements[index];
      assert.equal(/^BEGIN\b/i.test(previous) && /^BEGIN\b/i.test(current), false,
        'a BEGIN must never follow an open BEGIN on the same connection');
    }
    assert.equal(harness.store.db.isTransaction, false, 'no transaction may remain open after success');

    // #148 immutable/fill-once identity survives the terminal write.
    const row = harness.rawRow();
    assert.equal(row.agent, 'claude-code-cli');
    assert.equal(row.model, 'claude-opus-5');
    assert.equal(row.harness, 'claude');
    assert.equal(row.outcome, 'completed');
  } finally {
    harness.cleanup();
  }
});

test('#158: an immutable identity conflict is still refused through the production path, with no partial mutation and no leaked identity', () => {
  const harness = productionRecorder();
  try {
    assert.equal(harness.state.record('recordRecoveryAttempt', attemptPayload()), true);
    const before = harness.rawRow();
    harness.transactionStatements.length = 0;

    const conflicting = harness.state.record('recordRecoveryAttempt', attemptPayload({
      model: 'claude-sonnet-5',
      phase: 'finished', finishedAt: '2026-08-09T12:30:00.000Z', outcome: 'completed', resolutionState: 'resolved',
    }));
    assert.equal(conflicting, false, 'a conflicting identity write must fail closed');

    const [error] = harness.state.errors;
    assert.equal(error.stage, 'recordRecoveryAttempt');
    assert.equal(error.message, 'recovery attempt identity conflict: persisted-model-conflict');
    // Bounded/redacted reporting (#148): never the attempt id, never either value.
    assert.equal(error.message.includes(ATTEMPT_ID), false);
    assert.equal(error.message.includes('claude-opus-5'), false);
    assert.equal(error.message.includes('claude-sonnet-5'), false);

    // No partial mutation: the refused write must not have landed any of the
    // mutable columns it also carried.
    assert.deepEqual(harness.rawRow(), before);
    assert.equal(harness.rawRow().outcome, null);
    assert.equal(harness.rawRow().finished_at, null);

    assert.deepEqual(harness.transactionStatements, ['BEGIN IMMEDIATE', 'ROLLBACK']);
    assert.equal(harness.store.db.isTransaction, false, 'the refusal must close its transaction');
  } finally {
    harness.cleanup();
  }
});

test('#158: a readback mismatch rolls the whole transaction back, closes it, and leaves the store usable', () => {
  const harness = productionRecorder();
  try {
    // Simulate a post-write readback that disagrees with what was written.
    // The guard reads through the innermost store, so stub it there.
    const realReader = harness.store.recoveryAttempt.bind(harness.store);
    let reads = 0;
    harness.store.recoveryAttempt = (attemptId) => {
      reads += 1;
      const row = realReader(attemptId);
      // Read 1 is the guard's pre-write conflict read; read 2 is the
      // post-write readback that must be verified against the payload.
      return reads >= 2 && row ? { ...row, agent: 'some-other-agent' } : row;
    };

    const persisted = harness.state.record('recordRecoveryAttempt', attemptPayload());
    assert.equal(persisted, false, 'a mismatching readback must fail closed');
    const [error] = harness.state.errors;
    assert.equal(error.stage, 'recordRecoveryAttempt');
    assert.equal(error.message, 'recovery attempt identity conflict: readback-verification-failed');

    // Complete rollback: the fresh row must not exist at all.
    harness.store.recoveryAttempt = realReader;
    assert.equal(harness.rawRow(), null, 'the rolled-back write must leave no row behind');
    assert.deepEqual(harness.transactionStatements, ['BEGIN IMMEDIATE', 'ROLLBACK']);

    // The connection is not left inside a transaction after the failure.
    assert.equal(harness.store.db.isTransaction, false);
    assert.equal(harness.store.assertWritable(), true, 'the write probe proves the connection is unlocked');

    // Another valid operation succeeds on the same temporary store afterwards.
    harness.transactionStatements.length = 0;
    const recovered = harness.state.record('recordRecoveryAttempt', attemptPayload({
      attemptId: 'TheTekTeam/agent-runner#158:2026-08-09T13:00:00.000Z',
    }));
    assert.equal(recovered, true, 'a later valid write must succeed after a rolled-back failure');
    assert.ok(harness.rawRow('TheTekTeam/agent-runner#158:2026-08-09T13:00:00.000Z'));
    assert.equal(beginCount(harness.transactionStatements), 1);
    assert.equal(harness.store.db.isTransaction, false);

    // A non-recovery write on the same connection is unaffected too.
    assert.equal(harness.state.record('recordQueueEvent', {
      repo: 'TheTekTeam/agent-runner', eventType: 'liveness-recovery-withheld', issueNumber: 158, reason: 'test',
    }), true);
  } finally {
    harness.cleanup();
  }
});

test('#158: a store write that throws inside the transaction rolls back and never leaves the connection in a transaction', () => {
  const harness = productionRecorder();
  try {
    // Fault injection at the innermost UPSERT, inside the guard's already
    // open transaction: the crash/restart-equivalent case for the write the
    // guard is meant to make atomic.
    const realPrepare = harness.store.db.prepare.bind(harness.store.db);
    let injectWriteFault = true;
    harness.store.db.prepare = (sql) => {
      if (injectWriteFault && /INSERT INTO recovery_attempts/i.test(String(sql))) {
        throw new Error('injected recovery-attempt write fault');
      }
      return realPrepare(sql);
    };

    assert.equal(harness.state.record('recordRecoveryAttempt', attemptPayload()), false);
    assert.equal(harness.state.errors[0].stage, 'recordRecoveryAttempt');
    assert.equal(harness.state.errors[0].message, 'injected recovery-attempt write fault');
    assert.deepEqual(harness.transactionStatements, ['BEGIN IMMEDIATE', 'ROLLBACK']);
    assert.equal(harness.store.db.isTransaction, false, 'the failed write must close its transaction');
    assert.equal(harness.rawRow(), null, 'nothing may be left behind by the failed write');

    injectWriteFault = false;
    harness.transactionStatements.length = 0;
    assert.equal(harness.state.record('recordRecoveryAttempt', attemptPayload()), true,
      'the same temporary store must remain fully usable after the failure');
    assert.ok(harness.rawRow());
    assert.equal(beginCount(harness.transactionStatements), 1);
    assert.equal(harness.store.db.isTransaction, false);
  } finally {
    harness.cleanup();
  }
});
