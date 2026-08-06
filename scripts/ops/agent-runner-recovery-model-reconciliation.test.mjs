import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openRunnerStateStore } from './claude-runner-state.mjs';
import { restrictedHandleBindingDigest } from './claude-runner-recovery-adapter.mjs';
import { fingerprintGitStatus } from './claude-runner-execution-policy.mjs';
import {
  reconcileRecoveryAttemptModel, RECOVERY_MODEL_RECONCILIATION_FAILURE_CODES, SUPPORTED_HISTORICAL_ATTEMPT_SHAPE,
} from './agent-runner-recovery-model-reconciliation.mjs';

const ATTEMPT_ID = 'TheTekTeam/agent-runner#136:2026-08-03T17:27:49.192Z';
const EXPECTED_REPO = 'TheTekTeam/agent-runner';
const EXPECTED_AGENT = 'claude-code-cli';
const EXPECTED_HARNESS = 'claude';
const EXPECTED_MODEL = 'sonnet';
const EXPECTED_BRANCH = 'codex/pr-contract-136-r2';
const EXPECTED_WORKTREE_NAME = 'agent-runner-136-abc';
const MANAGER_REVISION = 'AR136-PR-CONTRACT-IMPLEMENTATION-2026-08-03.12';
const MANAGER_FINGERPRINT = 'sha256:34f501b0588760165dbe22716b055c152c9d0cca737cfc3da5d63a4e984682e6';
const MANAGER_BODY_DIGEST = 'sha256:1ee66684b548c31d31ee899af4309f5435168d5f486ee270d66c80a88af92ebf';
const CHECKPOINT_HEAD = 'ec81d1adc41f31a51281fc4d4ad34f56c53535ed';
const CHECKPOINT_STATUS_FINGERPRINT = fingerprintGitStatus('').statusFingerprint;

// The exact preserved #136 recovery-resolution shape (`SUPPORTED_HISTORICAL_
// ATTEMPT_SHAPE`'s camelCase `recordRecoveryAttempt()` equivalent), spread
// into every seeded fixture row below. Only the field(s) a given test is
// actually exercising ever deviate from this.
const EXACT_SHAPE_ATTEMPT_FIELDS = Object.freeze({
  phase: 'starting',
  outcome: 'unknown_failure',
  exitCode: 1,
  recoveryEligible: false,
  recoveryAction: 'attention_required',
  recoveryAttemptCount: 0,
  checkpointAvailable: true,
  sessionAvailable: true,
  worktreeAvailable: true,
  branchAvailable: false,
  prAvailable: false,
  attentionStatus: 'attention_required',
});

function baseHandle(overrides = {}) {
  return {
    attemptId: ATTEMPT_ID,
    agent: EXPECTED_AGENT,
    model: EXPECTED_MODEL,
    harness: EXPECTED_HARNESS,
    worktreeName: EXPECTED_WORKTREE_NAME,
    expectedBranch: EXPECTED_BRANCH,
    checkpointHead: CHECKPOINT_HEAD,
    checkpointStatusFingerprint: CHECKPOINT_STATUS_FINGERPRINT,
    ...overrides,
  };
}

function bindingDigestFor(handle) {
  return restrictedHandleBindingDigest({
    attemptId: handle.attemptId,
    agent: handle.agent,
    model: handle.model,
    harness: handle.harness,
    checkpointHead: handle.checkpointHead,
    checkpointStatusFingerprint: handle.checkpointStatusFingerprint,
  });
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-model-reconciliation-'));
  const path = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(path);
  return { dir, path, store };
}

/** Seeds a row matching the exact supported #136 historical shape, unless `overrides` deliberately deviates it. */
function seedAttempt(store, { model = null, handle = baseHandle(), overrides = {} } = {}) {
  store.recordRecoveryAttempt({
    attemptId: ATTEMPT_ID, repo: EXPECTED_REPO, issueNumber: 136,
    startedAt: '2026-08-03T17:27:49.192Z', resolutionState: 'unresolved',
    agent: EXPECTED_AGENT, harness: EXPECTED_HARNESS, model,
    ...EXACT_SHAPE_ATTEMPT_FIELDS,
    managerPreflightRevision: MANAGER_REVISION,
    managerPreflightFingerprint: MANAGER_FINGERPRINT,
    managerPreflightBodyDigest: MANAGER_BODY_DIGEST,
    restrictedHandleDigest: bindingDigestFor(handle),
    ...overrides,
  });
}

function handleReader(handle, { available = true, permissionSafe = true } = {}) {
  return () => ({ available, permissionSafe, handle: available ? handle : null });
}

function currentWorktreeVerifier({ preservedWorktreeCurrent = true, checkpointCurrent = true } = {}) {
  return () => ({ preservedWorktreeCurrent, checkpointCurrent });
}

function countingProvider(fn) {
  const provider = (...args) => { provider.calls += 1; return fn(...args); };
  provider.calls = 0;
  return provider;
}

function baseArgs(overrides = {}) {
  return {
    attemptId: ATTEMPT_ID,
    outputDir: '.var/claude-runner',
    repoRoot: '/tmp/does-not-matter',
    expectedRepo: EXPECTED_REPO,
    expectedAgent: EXPECTED_AGENT,
    expectedHarness: EXPECTED_HARNESS,
    expectedModel: EXPECTED_MODEL,
    expectedBranch: EXPECTED_BRANCH,
    expectedWorktreeName: EXPECTED_WORKTREE_NAME,
    expectedManagerRevision: MANAGER_REVISION,
    expectedManagerFingerprint: MANAGER_FINGERPRINT,
    expectedManagerBodyDigest: MANAGER_BODY_DIGEST,
    remoteBranchPublishedProvider: () => false,
    remotePrPublishedProvider: () => false,
    restrictedHandleReader: handleReader(baseHandle()),
    worktreeVerifier: currentWorktreeVerifier(),
    ...overrides,
  };
}

test('RECOVERY_MODEL_RECONCILIATION_FAILURE_CODES is the exact fixed vocabulary this issue requires', () => {
  const required = [
    'attempt-not-found', 'restricted-handle-unavailable', 'restricted-handle-permissions-unsafe',
    'stored-binding-invalid', 'persisted-agent-mismatch', 'persisted-harness-mismatch',
    'persisted-model-conflict', 'captured-model-invalid', 'manager-identity-missing',
    'manager-identity-mismatch', 'worktree-identity-mismatch', 'checkpoint-not-current',
    'remote-publication-conflict', 'compare-and-set-conflict', 'readback-verification-failed',
    'reconciliation-complete', 'reconciliation-replay',
  ];
  for (const code of required) assert.ok(RECOVERY_MODEL_RECONCILIATION_FAILURE_CODES.includes(code), code);
});

test('SUPPORTED_HISTORICAL_ATTEMPT_SHAPE is exactly the #136 preserved checkpoint shape', () => {
  assert.deepEqual(SUPPORTED_HISTORICAL_ATTEMPT_SHAPE, {
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 136,
    phase: 'starting',
    outcome: 'unknown_failure',
    exitCode: 1,
    recoveryEligible: 0,
    recoveryAction: 'attention_required',
    recoveryAttemptCount: 0,
    checkpointAvailable: 1,
    sessionAvailable: 1,
    worktreeAvailable: 1,
    branchAvailable: 0,
    prAvailable: 0,
    attentionStatus: 'attention_required',
    resolutionState: 'unresolved',
  });
});

test('reconcileRecoveryAttemptModel: exact historical null-model reconciliation succeeds when the stored digest authenticates the handle (#136 fixture)', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.code, 'reconciliation-complete');
    assert.equal(outcome.model, EXPECTED_MODEL);
    const row = store.recoveryAttempt(ATTEMPT_ID);
    assert.equal(row.model, EXPECTED_MODEL);
    // Only the model column changed -- agent/harness/manager identity/digest
    // are exactly what was already persisted.
    assert.equal(row.agent, EXPECTED_AGENT);
    assert.equal(row.harness, EXPECTED_HARNESS);
    assert.equal(row.manager_preflight_revision, MANAGER_REVISION);
    assert.equal(row.restricted_handle_digest, bindingDigestFor(baseHandle()));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [field, value] of [
  ['repo', 'someone-else/agent-runner'],
  ['issueNumber', 999],
  ['phase', 'running'],
  ['outcome', 'completed'],
  ['exitCode', 0],
  ['recoveryEligible', true],
  ['recoveryAction', 'none'],
  ['recoveryAttemptCount', 1],
  ['checkpointAvailable', false],
  ['sessionAvailable', false],
  ['worktreeAvailable', false],
  ['branchAvailable', true],
  ['prAvailable', true],
  ['attentionStatus', 'none'],
]) {
  test(`reconcileRecoveryAttemptModel: fails closed with attempt-shape-unsupported when persisted ${field} deviates from the exact #136 shape`, () => {
    const { dir, store } = tempStore();
    try {
      seedAttempt(store, { model: null, overrides: { [field]: value } });
      const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
      assert.equal(outcome.ok, false, JSON.stringify(outcome));
      assert.equal(outcome.code, 'attempt-shape-unsupported');
      assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('reconcileRecoveryAttemptModel: fails closed with attempt-shape-unsupported when resolution_state is not exactly "unresolved"', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null, overrides: { resolutionState: 'resolved' } });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.equal(outcome.code, 'attempt-shape-unsupported');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed with attempt-shape-unsupported when the operator-supplied --repo disagrees with the persisted row, even if the persisted row otherwise matches the exact shape', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store, expectedRepo: 'someone-else/agent-runner' });
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.equal(outcome.code, 'attempt-shape-unsupported');
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: performs the remote-publication check twice -- once before the transaction and once after readback, immediately before COMMIT', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const branchProvider = countingProvider(() => false);
    const prProvider = countingProvider(() => false);
    const outcome = reconcileRecoveryAttemptModel({
      ...baseArgs(), store, remoteBranchPublishedProvider: branchProvider, remotePrPublishedProvider: prProvider,
    });
    assert.equal(outcome.code, 'reconciliation-complete', JSON.stringify(outcome));
    assert.equal(branchProvider.calls, 2);
    assert.equal(prProvider.calls, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: a branch/PR that appears only between the first and second publication check still fails closed and applies no mutation', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    let branchCalls = 0;
    const outcome = reconcileRecoveryAttemptModel({
      ...baseArgs(),
      store,
      remoteBranchPublishedProvider: () => { branchCalls += 1; return branchCalls > 1; },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'remote-publication-conflict');
    assert.equal(branchCalls, 2);
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: deterministic replay reruns full evidence validation (including exact shape and both publication checks) and returns the same completed result without another mutation', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const first = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
    assert.equal(first.code, 'reconciliation-complete', JSON.stringify(first));
    const rowAfterFirst = store.recoveryAttempt(ATTEMPT_ID);

    const branchProvider = countingProvider(() => false);
    const prProvider = countingProvider(() => false);
    const second = reconcileRecoveryAttemptModel({
      ...baseArgs(), store, remoteBranchPublishedProvider: branchProvider, remotePrPublishedProvider: prProvider,
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.code, 'reconciliation-replay');
    assert.equal(second.model, EXPECTED_MODEL);
    // Replay reruns both publication checks (pre-transaction fail-fast, plus
    // the replay-path recheck immediately before its own success return).
    assert.equal(branchProvider.calls, 2);
    assert.equal(prProvider.calls, 2);
    const rowAfterSecond = store.recoveryAttempt(ATTEMPT_ID);
    assert.deepEqual(rowAfterSecond, rowAfterFirst);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: replay still fails closed if evidence has since diverged (manager identity changed) -- it never short-circuits on "model already non-null" alone', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const first = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
    assert.equal(first.code, 'reconciliation-complete', JSON.stringify(first));

    const second = reconcileRecoveryAttemptModel({ ...baseArgs(), store, expectedManagerRevision: 'SOME-OTHER-REVISION' });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'manager-identity-mismatch');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: replay fails closed if a branch/PR has appeared since the original reconciliation', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const first = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
    assert.equal(first.code, 'reconciliation-complete', JSON.stringify(first));

    const second = reconcileRecoveryAttemptModel({ ...baseArgs(), store, remotePrPublishedProvider: () => true });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'remote-publication-conflict');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: attempt-not-found for a missing attempt id', () => {
  const { dir, store } = tempStore();
  try {
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store, attemptId: 'no-such-attempt' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'attempt-not-found');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed on unsafe restricted-handle permissions (tampered owner/mode/type/symlink)', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({
      ...baseArgs(), store, restrictedHandleReader: handleReader(baseHandle(), { permissionSafe: false }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'restricted-handle-permissions-unsafe');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when the restricted handle is unavailable', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({
      ...baseArgs(), store, restrictedHandleReader: handleReader(baseHandle(), { available: false }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'restricted-handle-unavailable');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when the stored binding digest does not authenticate the captured handle (tampered handle)', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const tamperedHandle = baseHandle({ checkpointHead: 'f'.repeat(40) });
    const outcome = reconcileRecoveryAttemptModel({
      ...baseArgs(), store, restrictedHandleReader: handleReader(tamperedHandle),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'stored-binding-invalid');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when the persisted restricted_handle_digest column itself is missing', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null, overrides: { restrictedHandleDigest: undefined } });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'stored-binding-invalid');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed on a persisted-vs-expected agent mismatch', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store, expectedAgent: 'codex-cli' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'persisted-agent-mismatch');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed on a persisted-vs-expected harness mismatch', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store, expectedHarness: 'codex' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'persisted-harness-mismatch');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: refuses to replace a non-null persisted model that differs from the captured value', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: 'opus' });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'persisted-model-conflict');
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, 'opus');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed on an invalid/unbounded captured model, even if it is a syntactically safe token', () => {
  const { dir, store } = tempStore();
  try {
    const unboundedHandle = baseHandle({ model: 'claude-super-max-9000' });
    seedAttempt(store, { model: null, handle: unboundedHandle });
    const outcome = reconcileRecoveryAttemptModel({
      ...baseArgs(), store, expectedModel: 'sonnet', restrictedHandleReader: handleReader(unboundedHandle),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'captured-model-invalid');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed on a differently-cased captured model -- membership is exact and never normalized into validity', () => {
  const { dir, store } = tempStore();
  try {
    const casedHandle = baseHandle({ model: 'Sonnet' });
    seedAttempt(store, { model: null, handle: casedHandle });
    const outcome = reconcileRecoveryAttemptModel({
      ...baseArgs(), store, restrictedHandleReader: handleReader(casedHandle),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'captured-model-invalid');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when expectedModel is missing or is not one of this runner\'s bounded supported model identifiers', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store, expectedModel: null }).code, 'captured-model-invalid');
    assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store, expectedModel: '' }).code, 'captured-model-invalid');
    assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store, expectedModel: 'claude-super-max-9000' }).code, 'captured-model-invalid');
    // No mutation occurred for any of the above.
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when the persisted manager identity is missing', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, {
      model: null,
      overrides: { managerPreflightRevision: undefined, managerPreflightFingerprint: undefined, managerPreflightBodyDigest: undefined },
    });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'manager-identity-missing');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when the persisted manager identity differs from the operator-supplied expected value', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store, expectedManagerFingerprint: 'sha256:different' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'manager-identity-mismatch');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when the branch has moved (handle branch/worktree does not match expected)', () => {
  const { dir, store } = tempStore();
  try {
    // The binding digest material deliberately excludes branch/worktree (it
    // binds identity + checkpoint only), so a handle whose branch moved
    // still authenticates against the originally-stored digest -- it is the
    // dedicated branch/worktree comparison below that must catch this, not
    // the digest check.
    seedAttempt(store, { model: null });
    const movedHandle = baseHandle({ expectedBranch: 'codex/some-other-branch' });
    const outcome = reconcileRecoveryAttemptModel({
      ...baseArgs(), store, restrictedHandleReader: handleReader(movedHandle),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'worktree-identity-mismatch');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when the checkpoint HEAD/status fingerprint is no longer current', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({
      ...baseArgs(), store, worktreeVerifier: currentWorktreeVerifier({ checkpointCurrent: false }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'checkpoint-not-current');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when a remote branch has already been published unexpectedly', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store, remoteBranchPublishedProvider: () => true });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'remote-publication-conflict');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: fails closed when a remote PR (in any state) has already been published unexpectedly', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store, remotePrPublishedProvider: () => true });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'remote-publication-conflict');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: remote-publication evidence fails closed on missing, non-function, throwing or non-boolean providers -- only a literal false rules publication out', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store, remoteBranchPublishedProvider: undefined }).code, 'remote-publication-conflict');
    assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store, remoteBranchPublishedProvider: () => { throw new Error('boom'); } }).code, 'remote-publication-conflict');
    assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store, remoteBranchPublishedProvider: () => undefined }).code, 'remote-publication-conflict');
    assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store, remoteBranchPublishedProvider: () => 'false' }).code, 'remote-publication-conflict');
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
    // Only an explicit boolean `false` from both providers reaches success.
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store, remoteBranchPublishedProvider: () => false, remotePrPublishedProvider: () => false });
    assert.equal(outcome.code, 'reconciliation-complete', JSON.stringify(outcome));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: the compare-and-set UPDATE binds every required identity, manager and recovery-resolution field, not only attempt_id/model/agent/harness', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const realDb = store.db;
    let capturedSql = null;
    const sqlCapturingStore = {
      recoveryAttempt: (id) => store.recoveryAttempt(id),
      db: {
        exec: (sql) => realDb.exec(sql),
        prepare: (sql) => {
          if (sql.trim().startsWith('UPDATE recovery_attempts SET model = ?')) capturedSql = sql;
          return realDb.prepare(sql);
        },
      },
    };
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store: sqlCapturingStore });
    assert.equal(outcome.code, 'reconciliation-complete', JSON.stringify(outcome));
    assert.ok(capturedSql, 'the compare-and-set UPDATE statement was prepared');
    for (const requiredColumn of [
      'attempt_id', 'model IS NULL', 'agent', 'harness', 'repo', 'issue_number',
      'manager_preflight_revision', 'manager_preflight_fingerprint', 'manager_preflight_body_digest',
      'restricted_handle_digest', 'phase', 'outcome', 'exit_code', 'recovery_eligible', 'recovery_action',
      'recovery_attempt_count', 'checkpoint_available', 'session_available', 'worktree_available',
      'branch_available', 'pr_available', 'attention_status', 'resolution_state',
    ]) {
      assert.ok(capturedSql.includes(requiredColumn), `predicate missing ${requiredColumn}: ${capturedSql}`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: compare-and-set race refusal -- a lost 0-row UPDATE never succeeds and never applies a second mutation', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const realDb = store.db;
    const racedStore = {
      recoveryAttempt: (id) => store.recoveryAttempt(id),
      db: {
        exec: (sql) => realDb.exec(sql),
        prepare: (sql) => {
          if (sql.trim().startsWith('UPDATE recovery_attempts SET model = ?')) {
            return { run: () => ({ changes: 0 }) };
          }
          return realDb.prepare(sql);
        },
      },
    };
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store: racedStore });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'compare-and-set-conflict');
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: readback verification failure rolls back and never reports success', () => {
  const { dir, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const realDb = store.db;
    const tamperedStore = {
      recoveryAttempt: (id) => store.recoveryAttempt(id),
      db: {
        exec: (sql) => realDb.exec(sql),
        prepare: (sql) => {
          const stmt = realDb.prepare(sql);
          if (sql.trim().startsWith('SELECT * FROM recovery_attempts WHERE attempt_id = ?')) {
            return { get: (...args) => ({ ...stmt.get(...args), model: 'a-tampered-readback-value' }) };
          }
          return stmt;
        },
      },
    };
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store: tamperedStore });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'readback-verification-failed');
    // The rollback must have actually happened -- the real row's model must
    // remain the freshly-written candidate value or null, never the tampered
    // readback value, which never touched the real database.
    assert.notEqual(store.recoveryAttempt(ATTEMPT_ID).model, 'a-tampered-readback-value');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: every prerequisite is re-established under the transaction lock -- a second connection cannot interleave a conflicting write between validation and the compare-and-set', () => {
  const { dir, path, store } = tempStore();
  const racingStore = openRunnerStateStore(path);
  try {
    seedAttempt(store, { model: null });

    // Hold a raw write lock open on a second connection, standing in for a
    // competing writer that could, under pre-transaction-only validation,
    // have committed a conflicting identity in the window between this
    // reconciliation's checks and its own write. The guarded reconciliation
    // must not be able to proceed at all while that lock is held -- its own
    // BEGIN IMMEDIATE must fail, not silently reuse evidence gathered before
    // the lock existed.
    racingStore.db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => reconcileRecoveryAttemptModel({ ...baseArgs(), store }));
    } finally {
      racingStore.db.exec('COMMIT');
    }
    // Nothing was mutated by the blocked attempt.
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);

    // With the competing lock released, reconciliation now proceeds and
    // succeeds normally against the current (unmodified) row.
    const outcome = reconcileRecoveryAttemptModel({ ...baseArgs(), store });
    assert.equal(outcome.code, 'reconciliation-complete', JSON.stringify(outcome));
  } finally {
    store.close();
    racingStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileRecoveryAttemptModel: attempt-not-found for a non-transactional or malformed store never throws', () => {
  assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store: null }).code, 'attempt-not-found');
  assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store: {} }).code, 'attempt-not-found');
  assert.equal(reconcileRecoveryAttemptModel({ ...baseArgs(), store: { recoveryAttempt: () => null } }).code, 'attempt-not-found');
});
