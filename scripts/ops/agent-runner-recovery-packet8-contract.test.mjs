import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RecoveryAttemptIdentityConflictError,
  withRecoveryIdentityGuard,
} from './agent-runner-recovery-identity-guard.mjs';
import {
  reconcileRecoveryAttemptModel,
} from './agent-runner-recovery-model-reconciliation.mjs';
import {
  restrictedHandleBindingDigest,
} from './claude-runner-recovery-adapter.mjs';
import {
  fingerprintGitStatus,
} from './claude-runner-execution-policy.mjs';
import {
  runnerArgs,
} from './claude-runner-cron.mjs';

const ATTEMPT_ID = 'TheTekTeam/agent-runner#136:2026-08-03T17:27:49.192Z';
const EXPECTED_REPO = 'TheTekTeam/agent-runner';
const EXPECTED_AGENT = 'claude-code-cli';
const EXPECTED_HARNESS = 'claude';
const EXPECTED_MODEL = 'sonnet';
const EXPECTED_BRANCH = 'codex/pr-contract-136-r2';
const EXPECTED_WORKTREE_NAME = 'agent-runner-136-real-fixture';
const MANAGER_REVISION = 'AR136-PR-CONTRACT-IMPLEMENTATION-2026-08-03.12';
const MANAGER_FINGERPRINT = 'sha256:34f501b0588760165dbe22716b055c152c9d0cca737cfc3da5d63a4e984682e6';
const MANAGER_BODY_DIGEST = 'sha256:1ee66684b548c31d31ee899af4309f5435168d5f486ee270d66c80a88af92ebf';
const MANAGER_AUTHORITY_KEY = `manager-preflight:${MANAGER_REVISION}:${MANAGER_FINGERPRINT}`;
const CLAIM_ID = MANAGER_AUTHORITY_KEY;
const CLAIM_IDENTITY_JSON = JSON.stringify({ kind: 'manager-preflight', revision: MANAGER_REVISION, fingerprint: MANAGER_FINGERPRINT });

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function mappedAttempt(attempt) {
  return {
    attempt_id: attempt.attemptId ?? null,
    repo: attempt.repo ?? null,
    issue_number: attempt.issueNumber ?? null,
    agent: attempt.agent ?? null,
    model: attempt.model ?? null,
    harness: attempt.harness ?? null,
    restricted_handle_digest: attempt.restrictedHandleDigest ?? null,
    manager_preflight_revision: attempt.managerPreflightRevision ?? null,
    manager_preflight_fingerprint: attempt.managerPreflightFingerprint ?? null,
    manager_preflight_body_digest: attempt.managerPreflightBodyDigest ?? null,
    manager_authority_key: attempt.managerAuthorityKey ?? null,
    claim_id: attempt.claimId ?? null,
    claim_identity_json: attempt.claimIdentityJson ?? null,
    preflight_revision: attempt.preflightRevision ?? null,
    phase: attempt.phase ?? null,
    outcome: attempt.outcome ?? null,
    exit_code: attempt.exitCode ?? null,
    resolution_state: attempt.resolutionState ?? null,
  };
}

function guardStore({ initial = null, readOverride = null, writeOverride = null } = {}) {
  let row = clone(initial);
  let transactionSnapshot = null;
  let readCount = 0;
  const store = {
    db: {
      exec(sql) {
        if (sql === 'BEGIN IMMEDIATE') transactionSnapshot = clone(row);
        else if (sql === 'ROLLBACK') row = clone(transactionSnapshot);
        else if (sql !== 'COMMIT') throw new Error(`unexpected-sql:${sql}`);
      },
      prepare() { return { run: () => ({ changes: 0 }), get: () => null }; },
    },
    recordRecoveryAttempt(attempt) {
      if (writeOverride) return writeOverride({ attempt, get row() { return row; }, set row(value) { row = value; } });
      if (!row) row = mappedAttempt(attempt);
      return true;
    },
    recoveryAttempt() {
      readCount += 1;
      return readOverride ? readOverride({ readCount, row: clone(row) }) : clone(row);
    },
    current() { return clone(row); },
  };
  return withRecoveryIdentityGuard(store);
}

function fullGuardAttempt(overrides = {}) {
  return {
    attemptId: 'attempt-packet8',
    repo: EXPECTED_REPO,
    issueNumber: 148,
    agent: EXPECTED_AGENT,
    model: EXPECTED_MODEL,
    harness: EXPECTED_HARNESS,
    restrictedHandleDigest: 'a'.repeat(64),
    managerPreflightRevision: MANAGER_REVISION,
    managerPreflightFingerprint: MANAGER_FINGERPRINT,
    managerPreflightBodyDigest: MANAGER_BODY_DIGEST,
    managerAuthorityKey: MANAGER_AUTHORITY_KEY,
    claimId: CLAIM_ID,
    claimIdentityJson: CLAIM_IDENTITY_JSON,
    preflightRevision: MANAGER_REVISION,
    phase: 'starting',
    outcome: null,
    exitCode: null,
    resolutionState: 'active',
    ...overrides,
  };
}

test('packet8 guard fresh row readback exactly matches the complete incoming immutable identity', () => {
  const store = guardStore();
  assert.doesNotThrow(() => store.recordRecoveryAttempt(fullGuardAttempt()));
  const row = store.current();
  assert.equal(row.agent, EXPECTED_AGENT);
  assert.equal(row.model, EXPECTED_MODEL);
  assert.equal(row.harness, EXPECTED_HARNESS);
  assert.equal(row.claim_id, CLAIM_ID);
  assert.equal(row.claim_identity_json, CLAIM_IDENTITY_JSON);
  assert.equal(row.manager_authority_key, MANAGER_AUTHORITY_KEY);
});

test('packet8 guard missing readback rolls back with readback-verification-failed', () => {
  const store = guardStore({ readOverride: () => null });
  assert.throws(
    () => store.recordRecoveryAttempt(fullGuardAttempt()),
    (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'readback-verification-failed',
  );
});

test('packet8 guard non-object malformed readback rolls back with readback-verification-failed', () => {
  const store = guardStore({ readOverride: ({ readCount }) => (readCount === 1 ? null : 'malformed-readback') });
  assert.throws(
    () => store.recordRecoveryAttempt(fullGuardAttempt()),
    (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'readback-verification-failed',
  );
});

test('packet8 guard ordinary previously null identity fill is refused outside historical reconciliation', () => {
  const initial = mappedAttempt(fullGuardAttempt({ model: null }));
  const store = guardStore({ initial });
  assert.throws(
    () => store.recordRecoveryAttempt(fullGuardAttempt({ model: EXPECTED_MODEL })),
    (error) => error instanceof RecoveryAttemptIdentityConflictError,
  );
  assert.equal(store.current().model, null);
});

test('packet8 guard complete immutable projection detects claim authority drift and rolls back', () => {
  const initial = mappedAttempt(fullGuardAttempt());
  const store = guardStore({
    initial,
    writeOverride(context) {
      context.row = { ...context.row, claim_id: 'changed-claim', manager_authority_key: 'changed-authority' };
      return true;
    },
  });
  assert.throws(
    () => store.recordRecoveryAttempt(fullGuardAttempt({ outcome: 'completed' })),
    (error) => error instanceof RecoveryAttemptIdentityConflictError && error.code === 'readback-verification-failed',
  );
  assert.equal(store.current().claim_id, CLAIM_ID);
  assert.equal(store.current().manager_authority_key, MANAGER_AUTHORITY_KEY);
});

function baseHandle(overrides = {}) {
  return {
    attemptId: ATTEMPT_ID,
    agent: EXPECTED_AGENT,
    model: EXPECTED_MODEL,
    harness: EXPECTED_HARNESS,
    worktreeName: EXPECTED_WORKTREE_NAME,
    expectedBranch: EXPECTED_BRANCH,
    checkpointHead: 'a'.repeat(40),
    checkpointStatusFingerprint: fingerprintGitStatus('').statusFingerprint,
    ...overrides,
  };
}

function bindingFor(handle, attemptId = ATTEMPT_ID) {
  return restrictedHandleBindingDigest({
    attemptId,
    agent: handle.agent,
    model: handle.model,
    harness: handle.harness,
    checkpointHead: handle.checkpointHead,
    checkpointStatusFingerprint: handle.checkpointStatusFingerprint,
  });
}

function historicalRow(handle = baseHandle(), overrides = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    repo: EXPECTED_REPO,
    issue_number: 136,
    phase: 'starting',
    outcome: 'unknown_failure',
    exit_code: 1,
    recovery_eligible: 0,
    recovery_action: 'attention_required',
    recovery_attempt_count: 0,
    checkpoint_available: 1,
    session_available: 1,
    worktree_available: 1,
    branch_available: 0,
    pr_available: 0,
    attention_status: 'attention_required',
    resolution_state: 'unresolved',
    agent: EXPECTED_AGENT,
    model: null,
    harness: EXPECTED_HARNESS,
    manager_preflight_revision: MANAGER_REVISION,
    manager_preflight_fingerprint: MANAGER_FINGERPRINT,
    manager_preflight_body_digest: MANAGER_BODY_DIGEST,
    manager_authority_key: MANAGER_AUTHORITY_KEY,
    claim_id: CLAIM_ID,
    claim_identity_json: CLAIM_IDENTITY_JSON,
    preflight_revision: MANAGER_REVISION,
    restricted_handle_digest: bindingFor(handle),
    unrelated_sentinel: 'unchanged',
    ...overrides,
  };
}

function reconciliationStore({ row, selectReadback = undefined } = {}) {
  let current = clone(row);
  let snapshot = null;
  let updates = 0;
  const store = {
    db: {
      exec(sql) {
        if (sql === 'BEGIN IMMEDIATE') snapshot = clone(current);
        else if (sql === 'ROLLBACK') current = clone(snapshot);
        else if (sql !== 'COMMIT') throw new Error(`unexpected-sql:${sql}`);
      },
      prepare(sql) {
        if (/^\s*UPDATE\s+recovery_attempts/iu.test(sql)) {
          return {
            run(model) {
              updates += 1;
              current = { ...current, model };
              return { changes: 1 };
            },
          };
        }
        if (/^\s*SELECT\s+\*/iu.test(sql)) {
          return { get: () => (selectReadback === undefined ? clone(current) : clone(selectReadback)) };
        }
        throw new Error('unexpected-prepared-sql');
      },
    },
    recoveryAttempt() { return clone(current); },
    current() { return clone(current); },
    updates() { return updates; },
  };
  return store;
}

function reconciliationArgs({ store, handle = baseHandle(), repoRoot = '/tmp/not-used', worktreeVerifier = () => ({ preservedWorktreeCurrent: true, checkpointCurrent: true }), overrides = {} }) {
  return {
    attemptId: ATTEMPT_ID,
    store,
    outputDir: '/tmp/not-used',
    repoRoot,
    expectedRepo: EXPECTED_REPO,
    expectedAgent: EXPECTED_AGENT,
    expectedHarness: EXPECTED_HARNESS,
    expectedModel: EXPECTED_MODEL,
    expectedBranch: handle.expectedBranch,
    expectedWorktreeName: handle.worktreeName,
    expectedManagerRevision: MANAGER_REVISION,
    expectedManagerFingerprint: MANAGER_FINGERPRINT,
    expectedManagerBodyDigest: MANAGER_BODY_DIGEST,
    expectedManagerAuthorityKey: MANAGER_AUTHORITY_KEY,
    expectedClaimId: CLAIM_ID,
    expectedClaimIdentityJson: CLAIM_IDENTITY_JSON,
    expectedClaimIdentity: CLAIM_IDENTITY_JSON,
    remoteBranchPublishedProvider: () => false,
    remotePrPublishedProvider: () => false,
    restrictedHandleReader: () => ({ available: true, permissionSafe: true, handle }),
    worktreeVerifier,
    ...overrides,
  };
}

test('packet8 reconciliation handle attempt mismatch is refused before update', () => {
  const handle = baseHandle({ attemptId: 'different-attempt' });
  const row = historicalRow(handle, { restricted_handle_digest: bindingFor(handle, ATTEMPT_ID) });
  const store = reconciliationStore({ row });
  const outcome = reconcileRecoveryAttemptModel(reconciliationArgs({ store, handle }));
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.notEqual(outcome.code, 'reconciliation-complete');
  assert.notEqual(outcome.code, 'reconciliation-replay');
  assert.equal(store.updates(), 0);
});

test('packet8 reconciliation claim mismatch and manager authority mismatch are refused before update', () => {
  for (const overrides of [
    { claim_id: 'different-claim' },
    { claim_identity_json: JSON.stringify({ kind: 'different' }) },
    { manager_authority_key: 'different-authority' },
  ]) {
    const handle = baseHandle();
    const store = reconciliationStore({ row: historicalRow(handle, overrides) });
    const outcome = reconcileRecoveryAttemptModel(reconciliationArgs({ store, handle }));
    assert.equal(outcome.ok, false, JSON.stringify({ overrides, outcome }));
    assert.notEqual(outcome.code, 'reconciliation-complete');
    assert.notEqual(outcome.code, 'reconciliation-replay');
    assert.equal(store.updates(), 0);
  }
});

test('packet8 reconciliation missing readback returns readback-verification-failed without throwing', () => {
  const handle = baseHandle();
  const store = reconciliationStore({ row: historicalRow(handle), selectReadback: null });
  const outcome = reconcileRecoveryAttemptModel(reconciliationArgs({ store, handle }));
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(outcome.code, 'readback-verification-failed');
  assert.equal(store.current().model, null, 'rollback restores the row');
});

test('packet8 reconciliation non-object malformed readback returns readback-verification-failed without throwing', () => {
  const handle = baseHandle();
  const store = reconciliationStore({ row: historicalRow(handle), selectReadback: 'malformed-readback' });
  const outcome = reconcileRecoveryAttemptModel(reconciliationArgs({ store, handle }));
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(outcome.code, 'readback-verification-failed');
  assert.equal(store.current().model, null, 'rollback restores the row');
});

test('packet8 reconciliation complete row proof changes only model and replay is write-free', () => {
  const handle = baseHandle();
  const before = historicalRow(handle);
  const store = reconciliationStore({ row: before });
  const first = reconcileRecoveryAttemptModel(reconciliationArgs({ store, handle }));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.code, 'reconciliation-complete');
  const after = store.current();
  const changed = Object.keys({ ...before, ...after }).filter((key) => !Object.is(before[key], after[key]));
  assert.deepEqual(changed, ['model']);
  assert.equal(after.unrelated_sentinel, 'unchanged');
  const writesAfterFirst = store.updates();
  const replay = reconcileRecoveryAttemptModel(reconciliationArgs({ store, handle }));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.code, 'reconciliation-replay');
  assert.equal(store.updates(), writesAfterFirst);
});

test('packet8 exact #136 real temporary git worktree fixture uses the production verifyPreservedWorktree adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'ar148-real-worktree-'));
  try {
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'config', 'user.email', 'packet8@example.invalid']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Packet 8 Test']);
    writeFileSync(join(root, 'fixture.txt'), 'fixture\n');
    execFileSync('git', ['-C', root, 'add', 'fixture.txt']);
    execFileSync('git', ['-C', root, 'commit', '-m', 'fixture'], { stdio: 'ignore' });
    const worktreeDir = join(root, '.claude', 'worktrees');
    mkdirSync(worktreeDir, { recursive: true });
    const worktreePath = join(worktreeDir, EXPECTED_WORKTREE_NAME);
    execFileSync('git', ['-C', root, 'worktree', 'add', '-b', EXPECTED_BRANCH, worktreePath, 'HEAD'], { stdio: 'ignore' });
    const checkpointHead = String(execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).trim();
    const status = String(execFileSync('git', ['-C', worktreePath, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }));
    const handle = baseHandle({ checkpointHead, checkpointStatusFingerprint: fingerprintGitStatus(status).statusFingerprint });
    const store = reconciliationStore({ row: historicalRow(handle) });
    const args = reconciliationArgs({ store, handle, repoRoot: root, worktreeVerifier: undefined });
    delete args.worktreeVerifier;
    const outcome = reconcileRecoveryAttemptModel(args);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.code, 'reconciliation-complete');
    assert.equal(store.current().model, EXPECTED_MODEL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet8 scheduler resolved model is passed exactly once to initial child argv', () => {
  const argv = runnerArgs(148, {
    repo: EXPECTED_REPO,
    outputDir: '/tmp/packet8-output',
    execute: true,
    configPath: null,
  }, { attemptId: 'attempt-packet8', model: EXPECTED_MODEL });
  const modelIndexes = argv.map((value, index) => value === '--model' ? index : -1).filter((index) => index >= 0);
  assert.equal(modelIndexes.length, 1);
  assert.equal(argv[modelIndexes[0] + 1], EXPECTED_MODEL);
  const attemptIndex = argv.indexOf('--attempt-id');
  assert.ok(attemptIndex >= 0);
  assert.equal(argv[attemptIndex + 1], 'attempt-packet8');
});

test('packet8 scheduler invalid model guard precedes no attempt row, runner start marker, claim or child launch', () => {
  const source = readFileSync(new URL('./claude-runner-cron.mjs', import.meta.url), 'utf8');
  const guardIndex = source.indexOf('freshImplementationDispatch && !modelResolutionValid');
  const attemptIndex = source.indexOf("state.record('recordRecoveryAttempt'", guardIndex);
  const markerIndex = source.indexOf('claimIssueForExecution', guardIndex);
  const childIndex = source.indexOf('runChildWithWatchdog', guardIndex);
  assert.ok(guardIndex >= 0, 'model-resolution refusal must exist');
  assert.ok(attemptIndex > guardIndex, 'attempt persistence must follow model refusal');
  assert.ok(markerIndex > guardIndex, 'claim/runner-start mutation must follow model refusal');
  assert.ok(childIndex > guardIndex, 'child launch must follow model refusal');
});

test('packet8 scheduler terminal write preserves resolved model and conflicting child identity fails closed', () => {
  const source = readFileSync(new URL('./claude-runner-cron.mjs', import.meta.url), 'utf8');
  assert.match(source, /actualModel[\s\S]{0,220}resolvedModel/u, 'actual model fallback must include resolvedModel');
  assert.match(source, /resolvedModel[\s\S]{0,500}(?:disagree|mismatch|conflict|unknown_failure)/iu, 'child model conflict must fail closed');
  assert.match(source, /model\s*:\s*(?:freshImplementationDispatch\s*\?\s*)?resolvedModel|model\s*:\s*actualModel/u, 'terminal persistence must retain resolved identity');
});

test('packet8 scheduler recovery profile compatibility uses resolved model rather than plan agent model', () => {
  const source = readFileSync(new URL('./claude-runner-cron.mjs', import.meta.url), 'utf8');
  const compatibilityWindowStart = source.indexOf('profileCompatible:');
  assert.ok(compatibilityWindowStart >= 0);
  const window = source.slice(compatibilityWindowStart, compatibilityWindowStart + 700);
  assert.ok(window.includes('resolvedModel'), 'profile compatibility must reference resolvedModel');
  assert.ok(!/actualModel\s*===\s*plan\.agent\?\.model/u.test(window), 'modelless plan.agent.model must not be the compatibility reference');
});
