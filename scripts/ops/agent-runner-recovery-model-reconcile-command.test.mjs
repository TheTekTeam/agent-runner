import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openRunnerStateStore } from './claude-runner-state.mjs';
import { readRestrictedRecoveryHandle, restrictedHandleBindingDigest, writeRestrictedRecoveryHandle } from './claude-runner-recovery-adapter.mjs';
import { fingerprintGitStatus } from './claude-runner-execution-policy.mjs';
import {
  EXIT_OK, EXIT_RECONCILIATION_FAILED, EXIT_USAGE_ERROR, EXIT_ROOT_FORBIDDEN, EXIT_INTERNAL_ERROR,
  parseRecoveryModelReconcileArgs, runRecoveryModelReconcileCommand,
} from './agent-runner-recovery-model-reconcile-command.mjs';

const ATTEMPT_ID = 'TheTekTeam/agent-runner#136:2026-08-03T17:27:49.192Z';
const REPO = 'TheTekTeam/agent-runner';
const AGENT = 'claude-code-cli';
const HARNESS = 'claude';
const MODEL = 'sonnet';
const BRANCH = 'codex/pr-contract-136-r2';
const WORKTREE = 'agent-runner-136-abc';
const MANAGER_REVISION = 'AR136-PR-CONTRACT-IMPLEMENTATION-2026-08-03.12';
const MANAGER_FINGERPRINT = 'sha256:34f501b0588760165dbe22716b055c152c9d0cca737cfc3da5d63a4e984682e6';
const MANAGER_BODY_DIGEST = 'sha256:1ee66684b548c31d31ee899af4309f5435168d5f486ee270d66c80a88af92ebf';
const CHECKPOINT_HEAD = 'ec81d1adc41f31a51281fc4d4ad34f56c53535ed';
const CHECKPOINT_STATUS_FINGERPRINT = fingerprintGitStatus('').statusFingerprint;

// The exact preserved #136 recovery-resolution shape, spread into every
// seeded fixture row below.
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
    attemptId: ATTEMPT_ID, agent: AGENT, model: MODEL, harness: HARNESS,
    worktreeName: WORKTREE, expectedBranch: BRANCH,
    checkpointHead: CHECKPOINT_HEAD, checkpointStatusFingerprint: CHECKPOINT_STATUS_FINGERPRINT,
    ...overrides,
  };
}

function bindingDigestFor(handle) {
  return restrictedHandleBindingDigest({
    attemptId: handle.attemptId, agent: handle.agent, model: handle.model, harness: handle.harness,
    checkpointHead: handle.checkpointHead, checkpointStatusFingerprint: handle.checkpointStatusFingerprint,
  });
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-model-reconcile-command-'));
  const path = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(path);
  return { dir, path, store };
}

/** Seeds a row matching the exact supported #136 historical shape, unless `overrides` deliberately deviates it. */
function seedAttempt(store, { model = null, handle = baseHandle(), overrides = {} } = {}) {
  store.recordRecoveryAttempt({
    attemptId: ATTEMPT_ID, repo: REPO, issueNumber: 136,
    startedAt: '2026-08-03T17:27:49.192Z', resolutionState: 'unresolved',
    agent: AGENT, harness: HARNESS, model,
    ...EXACT_SHAPE_ATTEMPT_FIELDS,
    managerPreflightRevision: MANAGER_REVISION,
    managerPreflightFingerprint: MANAGER_FINGERPRINT,
    managerPreflightBodyDigest: MANAGER_BODY_DIGEST,
    restrictedHandleDigest: bindingDigestFor(handle),
    ...overrides,
  });
}

function handleReader(handle = baseHandle(), { available = true, permissionSafe = true } = {}) {
  return () => ({ available, permissionSafe, handle: available ? handle : null });
}

function currentWorktreeVerifier({ preservedWorktreeCurrent = true, checkpointCurrent = true } = {}) {
  return () => ({ preservedWorktreeCurrent, checkpointCurrent });
}

/** Forwards every call to `store` unchanged except `close`, which is also observed. */
function closeTrackingStore(store, onClose) {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'close') {
        return (...args) => { onClose(); return Reflect.get(target, prop, receiver).apply(target, args); };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function baseArgv(overrides = {}, { outputDir = '.var/claude-runner', stateDb = '/tmp/does-not-matter-state.sqlite' } = {}) {
  const merged = {
    '--attempt-id': ATTEMPT_ID,
    '--repo': REPO,
    '--agent': AGENT,
    '--harness': HARNESS,
    '--model': MODEL,
    '--branch': BRANCH,
    '--worktree': WORKTREE,
    '--manager-revision': MANAGER_REVISION,
    '--manager-fingerprint': MANAGER_FINGERPRINT,
    '--manager-body-digest': MANAGER_BODY_DIGEST,
    '--repo-root': '/tmp/does-not-matter',
    '--output-dir': outputDir,
    '--state-db': stateDb,
    ...overrides,
  };
  const argv = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    argv.push(key, value);
  }
  return argv;
}

function noPublicationGhRunner() {
  return (args) => {
    if (args[0] === 'api') {
      const error = new Error('gh: Not Found (HTTP 404)');
      error.status = 1;
      error.stderr = 'gh: Not Found (HTTP 404)';
      throw error;
    }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([]);
    throw new Error('unexpected gh invocation in test');
  };
}

function successDependencies(overrides = {}) {
  return {
    uid: 1000,
    ghRunner: noPublicationGhRunner(),
    restrictedHandleReader: handleReader(),
    worktreeVerifier: currentWorktreeVerifier(),
    ...overrides,
  };
}

test('runRecoveryModelReconcileCommand: refuses root before any config read, SQLite open or GitHub contact', () => {
  let ghCalls = 0;
  let openCalls = 0;
  const result = runRecoveryModelReconcileCommand({
    argv: baseArgv(),
    uid: 0,
    ghRunner: () => { ghCalls += 1; return '[]'; },
    openStore: () => { openCalls += 1; return { close() {} }; },
  });
  assert.equal(result.exitCode, EXIT_ROOT_FORBIDDEN);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.code, 'root-execution-forbidden');
  assert.equal(ghCalls, 0);
  assert.equal(openCalls, 0);
});

test('runRecoveryModelReconcileCommand: exact historical null-model reconciliation succeeds end to end (#136 fixture)', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const result = runRecoveryModelReconcileCommand({
      argv: baseArgv({}, { stateDb: path }),
      ...successDependencies({ openStore: () => openRunnerStateStore(path) }),
    });
    assert.equal(result.exitCode, EXIT_OK, JSON.stringify(result.output));
    assert.equal(result.output.ok, true);
    assert.equal(result.output.code, 'reconciliation-complete');
    assert.equal(result.output.model, MODEL);
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, MODEL);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: fails closed with attempt-shape-unsupported when the persisted row is not the exact #136 shape', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null, overrides: { phase: 'running' } });
    const result = runRecoveryModelReconcileCommand({
      argv: baseArgv({}, { stateDb: path }),
      ...successDependencies({ openStore: () => openRunnerStateStore(path) }),
    });
    assert.equal(result.exitCode, EXIT_RECONCILIATION_FAILED, JSON.stringify(result.output));
    assert.equal(result.output.code, 'attempt-shape-unsupported');
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: deterministic replay returns reconciliation-replay with exit 0 and no further mutation', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const first = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path) }) });
    assert.equal(first.output.code, 'reconciliation-complete', JSON.stringify(first.output));
    const second = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path) }) });
    assert.equal(second.exitCode, EXIT_OK);
    assert.equal(second.output.code, 'reconciliation-replay');
    assert.equal(second.output.model, MODEL);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const missing of ['--attempt-id', '--repo', '--agent', '--harness', '--model', '--branch', '--worktree', '--manager-revision', '--manager-fingerprint', '--manager-body-digest', '--repo-root', '--output-dir', '--state-db']) {
  test(`runRecoveryModelReconcileCommand: usage error when ${missing} is missing`, () => {
    const argv = baseArgv({ [missing]: undefined });
    const result = runRecoveryModelReconcileCommand({ argv, ...successDependencies({ openStore: () => { throw new Error('must not open store on a usage error'); } }) });
    assert.equal(result.exitCode, EXIT_USAGE_ERROR);
    assert.equal(result.output.ok, false);
    assert.equal(result.output.code, 'usage-error');
  });
}

test('runRecoveryModelReconcileCommand: usage error on an invalid attempt id, repo, agent, harness, branch, worktree, manager revision or manager digest pattern', () => {
  const cases = [
    { '--attempt-id': '' },
    { '--attempt-id': 'has a space' },
    { '--repo': 'not-a-repo' },
    { '--repo': '../../etc/passwd' },
    { '--agent': 'Not-Lowercase' },
    { '--harness': 'UPPER' },
    { '--branch': 'has..dotdot' },
    { '--branch': '' },
    { '--worktree': 'Not-Lowercase' },
    { '--manager-revision': '' },
    { '--manager-fingerprint': 'not-a-digest' },
    { '--manager-body-digest': 'sha256:tooshort' },
  ];
  for (const overrides of cases) {
    const result = runRecoveryModelReconcileCommand({
      argv: baseArgv(overrides),
      ...successDependencies({ openStore: () => { throw new Error('must not open store on a usage error'); } }),
    });
    assert.equal(result.exitCode, EXIT_USAGE_ERROR, JSON.stringify(overrides));
    assert.equal(result.output.code, 'usage-error', JSON.stringify(overrides));
  }
});

test('runRecoveryModelReconcileCommand: requires exact canonical model vocabulary -- no trimming or lowercasing aliases into validity', () => {
  for (const badModel of ['Sonnet', ' sonnet', 'sonnet ', 'SONNET', 'claude-super-max-9000', '']) {
    const result = runRecoveryModelReconcileCommand({
      argv: baseArgv({ '--model': badModel }),
      ...successDependencies({ openStore: () => { throw new Error('must not open store on a usage error'); } }),
    });
    assert.equal(result.exitCode, EXIT_USAGE_ERROR, badModel);
    assert.equal(result.output.code, 'usage-error', badModel);
  }
  assert.deepEqual(
    parseRecoveryModelReconcileArgs(baseArgv()).model,
    MODEL,
  );
});

test('runRecoveryModelReconcileCommand: usage error on an unknown option, a duplicate option, or an option immediately followed by another option (ambiguous/missing value)', () => {
  const unknownOption = runRecoveryModelReconcileCommand({
    argv: [...baseArgv(), '--not-a-real-option', 'value'],
    ...successDependencies({ openStore: () => { throw new Error('must not open store on a usage error'); } }),
  });
  assert.equal(unknownOption.exitCode, EXIT_USAGE_ERROR);
  assert.equal(unknownOption.output.code, 'usage-error');

  const duplicateOption = runRecoveryModelReconcileCommand({
    argv: [...baseArgv(), '--model', 'opus'],
    ...successDependencies({ openStore: () => { throw new Error('must not open store on a usage error'); } }),
  });
  assert.equal(duplicateOption.exitCode, EXIT_USAGE_ERROR);
  assert.equal(duplicateOption.output.code, 'usage-error');

  const ambiguousValue = runRecoveryModelReconcileCommand({
    argv: ['--attempt-id', '--repo', REPO],
    ...successDependencies({ openStore: () => { throw new Error('must not open store on a usage error'); } }),
  });
  assert.equal(ambiguousValue.exitCode, EXIT_USAGE_ERROR);
  assert.equal(ambiguousValue.output.code, 'usage-error');

  const trailingFlagWithNoValue = runRecoveryModelReconcileCommand({
    argv: [...baseArgv(), '--attempt-id'],
    ...successDependencies({ openStore: () => { throw new Error('must not open store on a usage error'); } }),
  });
  assert.equal(trailingFlagWithNoValue.exitCode, EXIT_USAGE_ERROR);
});

test('runRecoveryModelReconcileCommand: never silently defaults --output-dir/--state-db from process.env -- both are required explicit operator input', () => {
  const argv = baseArgv({ '--output-dir': undefined, '--state-db': undefined });
  const result = runRecoveryModelReconcileCommand({
    argv,
    ...successDependencies({ openStore: () => { throw new Error('must not open store on a usage error'); } }),
  });
  assert.equal(result.exitCode, EXIT_USAGE_ERROR);
  assert.equal(result.output.code, 'usage-error');
});

test('runRecoveryModelReconcileCommand: fails closed with remote-publication-conflict when the branch API confirms the branch already exists', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const ghRunner = (args) => {
      if (args[0] === 'api') return BRANCH;
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      throw new Error('unexpected gh invocation');
    };
    const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), ghRunner }) });
    assert.equal(result.exitCode, EXIT_RECONCILIATION_FAILED);
    assert.equal(result.output.code, 'remote-publication-conflict');
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: fails closed (never silently "ruled out") when the branch API returns empty, mismatched or otherwise ambiguous output instead of a real 404', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    for (const ambiguousOutput of ['', '   ', 'some-other-branch', '{}', 'null']) {
      const ghRunner = (args) => {
        if (args[0] === 'api') return ambiguousOutput;
        if (args[0] === 'pr' && args[1] === 'list') return '[]';
        throw new Error('unexpected gh invocation');
      };
      const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), ghRunner }) });
      assert.equal(result.exitCode, EXIT_RECONCILIATION_FAILED, ambiguousOutput);
      // The thrown ambiguous-evidence error is caught by
      // `evidenceRulesOutPublication()`'s own fail-closed provider wrapper
      // (never propagated as an internal-error) and reads as "cannot rule
      // out publication", never a silent success.
      assert.equal(result.output.code, 'remote-publication-conflict', ambiguousOutput);
    }
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: fails closed with remote-publication-conflict when any-state PR discovery finds a PR targeting this branch', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const ghRunner = (args) => {
      if (args[0] === 'api') {
        const error = new Error('gh: Not Found (HTTP 404)');
        error.status = 1;
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([{ number: 1, title: 'x', body: '', url: 'https://x', headRefName: BRANCH, state: 'MERGED' }]);
      }
      throw new Error('unexpected gh invocation');
    };
    const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), ghRunner }) });
    assert.equal(result.exitCode, EXIT_RECONCILIATION_FAILED);
    assert.equal(result.output.code, 'remote-publication-conflict');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: PR discovery paginates beyond 200 results rather than silently truncating', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const pages = [];
    const ghRunner = (args) => {
      if (args[0] === 'api') {
        const error = new Error('gh: Not Found (HTTP 404)');
        error.status = 1;
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        const limit = Number(args[args.indexOf('--limit') + 1]);
        pages.push(limit);
        if (limit === 200) {
          // Exactly a full first page -- ambiguous, must trigger a re-fetch
          // at double the limit rather than being accepted as the total.
          const full = Array.from({ length: 200 }, (_, index) => ({
            number: index + 1, title: 'x', body: '', url: 'https://x', headRefName: `other-branch-${index}`, state: 'MERGED',
          }));
          return JSON.stringify(full);
        }
        // The doubled re-fetch returns the true, smaller total including the
        // matching branch beyond position 200 -- proof the bound was never a
        // hard cap on what `gh` could actually return.
        const beyond = Array.from({ length: 205 }, (_, index) => ({
          number: index + 1, title: 'x', body: '', url: 'https://x',
          headRefName: index === 204 ? BRANCH : `other-branch-${index}`, state: 'MERGED',
        }));
        return JSON.stringify(beyond);
      }
      throw new Error('unexpected gh invocation');
    };
    const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), ghRunner }) });
    assert.deepEqual(pages, [200, 400]);
    assert.equal(result.output.code, 'remote-publication-conflict');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: a malformed or failed GitHub read is a failure, never evidence publication is absent', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const rateLimitedGhRunner = (args) => {
      if (args[0] === 'api') {
        throw new Error('gh: API rate limit exceeded');
      }
      throw new Error('unexpected gh invocation');
    };
    const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), ghRunner: rateLimitedGhRunner }) });
    assert.equal(result.exitCode, EXIT_RECONCILIATION_FAILED);
    assert.equal(result.output.code, 'remote-publication-conflict');
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: a malformed (non-array) PR list read is a failure, never evidence publication is absent', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const ghRunner = (args) => {
      if (args[0] === 'api') {
        const error = new Error('gh: Not Found (HTTP 404)');
        error.status = 1;
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      }
      if (args[0] === 'pr' && args[1] === 'list') return '{"not":"an-array"}';
      throw new Error('unexpected gh invocation');
    };
    const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), ghRunner }) });
    assert.equal(result.exitCode, EXIT_RECONCILIATION_FAILED);
    assert.equal(result.output.code, 'remote-publication-conflict');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: a malformed PR entry (missing headRefName/state/number) is a failure, never evidence publication is absent', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const ghRunner = (args) => {
      if (args[0] === 'api') {
        const error = new Error('gh: Not Found (HTTP 404)');
        error.status = 1;
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      }
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 1, title: 'x' }]);
      throw new Error('unexpected gh invocation');
    };
    const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), ghRunner }) });
    assert.equal(result.exitCode, EXIT_RECONCILIATION_FAILED);
    assert.equal(result.output.code, 'remote-publication-conflict');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: a branch/PR that appears only between the two publication checks (second-check race) still fails closed', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    let apiCalls = 0;
    const ghRunner = (args) => {
      if (args[0] === 'api') {
        apiCalls += 1;
        if (apiCalls > 1) return BRANCH;
        const error = new Error('gh: Not Found (HTTP 404)');
        error.status = 1;
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      }
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      throw new Error('unexpected gh invocation');
    };
    const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), ghRunner }) });
    assert.equal(result.output.code, 'remote-publication-conflict');
    assert.equal(apiCalls, 2);
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: tampered handle, wrong permissions, stored-binding mismatch, agent/harness mismatch and non-null model conflict all fail closed with their exact codes', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const permissionsUnsafe = runRecoveryModelReconcileCommand({
      argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), restrictedHandleReader: handleReader(baseHandle(), { permissionSafe: false }) }),
    });
    assert.equal(permissionsUnsafe.output.code, 'restricted-handle-permissions-unsafe');

    const tampered = runRecoveryModelReconcileCommand({
      argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), restrictedHandleReader: handleReader(baseHandle({ checkpointHead: 'f'.repeat(40) })) }),
    });
    assert.equal(tampered.output.code, 'stored-binding-invalid');

    const agentMismatch = runRecoveryModelReconcileCommand({
      argv: baseArgv({ '--agent': 'codex-cli' }, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path) }),
    });
    assert.equal(agentMismatch.output.code, 'persisted-agent-mismatch');

    const harnessMismatch = runRecoveryModelReconcileCommand({
      argv: baseArgv({ '--harness': 'codex' }, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path) }),
    });
    assert.equal(harnessMismatch.output.code, 'persisted-harness-mismatch');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: refuses to replace a non-null persisted model that differs from the captured value', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: 'opus' });
    const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path) }) });
    assert.equal(result.output.code, 'persisted-model-conflict');
    assert.equal(store.recoveryAttempt(ATTEMPT_ID).model, 'opus');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: changed manager identity, moved branch/worktree, and a stale checkpoint each fail closed', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const managerChanged = runRecoveryModelReconcileCommand({
      argv: baseArgv({ '--manager-fingerprint': `sha256:${'0'.repeat(64)}` }, { stateDb: path }),
      ...successDependencies({ openStore: () => openRunnerStateStore(path) }),
    });
    assert.equal(managerChanged.output.code, 'manager-identity-mismatch');

    const branchMoved = runRecoveryModelReconcileCommand({
      argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), restrictedHandleReader: handleReader(baseHandle({ expectedBranch: 'codex/some-other-branch' })) }),
    });
    assert.equal(branchMoved.output.code, 'worktree-identity-mismatch');

    const staleCheckpoint = runRecoveryModelReconcileCommand({
      argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => openRunnerStateStore(path), worktreeVerifier: currentWorktreeVerifier({ checkpointCurrent: false }) }),
    });
    assert.equal(staleCheckpoint.output.code, 'checkpoint-not-current');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: an unexpected internal failure maps to the fixed internal-error code and exit 4, never leaking error.message', () => {
  const secretDetail = 'super-secret-internal-path-detail-should-never-leak';
  const result = runRecoveryModelReconcileCommand({
    argv: baseArgv(),
    ...successDependencies({ openStore: () => { throw new Error(secretDetail); } }),
  });
  assert.equal(result.exitCode, EXIT_INTERNAL_ERROR);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.code, 'internal-error');
  assert.ok(!JSON.stringify(result.output).includes(secretDetail));
});

test('runRecoveryModelReconcileCommand: closes the store resource on both success and failure paths', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    let closed = false;
    const wrapped = closeTrackingStore(store, () => { closed = true; });
    const result = runRecoveryModelReconcileCommand({ argv: baseArgv({}, { stateDb: path }), ...successDependencies({ openStore: () => wrapped }) });
    assert.equal(result.output.code, 'reconciliation-complete', JSON.stringify(result.output));
    assert.equal(closed, true);
  } finally {
    // The command's own `finally` already closed `store` via the tracking
    // proxy above -- closing it again here would throw.
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runRecoveryModelReconcileCommand: closes the store resource even when reconciliation throws internally', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    let closed = false;
    const wrapped = closeTrackingStore(store, () => { closed = true; });
    const result = runRecoveryModelReconcileCommand({
      argv: baseArgv({}, { stateDb: path }),
      ...successDependencies({
        openStore: () => wrapped,
        restrictedHandleReader: () => { throw new Error('simulated restricted-handle read failure'); },
      }),
    });
    assert.equal(result.exitCode, EXIT_INTERNAL_ERROR);
    assert.equal(closed, true);
  } finally {
    // The command's own `finally` already closed `store` via the tracking
    // proxy above -- closing it again here would throw.
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#136 fixture: reconciliation against an exact copied live-shaped SQLite fixture and restricted handle changes only the model, restores binding verification, leaves unrelated data byte-identical, and replay performs no second write', () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'recovery-136-source-'));
  const copyDir = mkdtempSync(join(tmpdir(), 'recovery-136-copy-'));
  try {
    const fixtureAttemptId = 'TheTekTeam/agent-runner#136:2026-08-03T17:27:49.192Z';
    const fixtureBranch = 'codex/pr-contract-136-r2';
    const fixtureWorktree = 'agent-runner-136-github-comment-database-5169337958';
    const fixtureAgent = 'claude-code-cli';
    const fixtureHarness = 'claude';
    const fixtureModel = 'sonnet';
    const fixtureManagerRevision = 'AR136-PR-CONTRACT-IMPLEMENTATION-2026-08-03.12';
    const fixtureManagerFingerprint = 'sha256:34f501b0588760165dbe22716b055c152c9d0cca737cfc3da5d63a4e984682e6';
    const fixtureManagerBodyDigest = 'sha256:1ee66684b548c31d31ee899af4309f5435168d5f486ee270d66c80a88af92ebf';
    const fixtureCheckpointHead = 'ec81d1adc41f31a51281fc4d4ad34f56c53535ed';
    const fixtureStatusFingerprint = fingerprintGitStatus('').statusFingerprint;

    // A live-shaped SQLite fixture: created through the real
    // `openRunnerStateStore()`/`recordRecoveryAttempt()` production code
    // path (the actual migrations and schema), never a hand-rolled synthetic
    // schema.
    const sourceDbPath = join(sourceDir, 'state.sqlite');
    const sourceStore = openRunnerStateStore(sourceDbPath);
    sourceStore.recordRecoveryAttempt({
      attemptId: 'unrelated-attempt-should-stay-byte-identical', repo: 'TheTekTeam/agent-runner', issueNumber: 1,
      startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:05:00Z', resolutionState: 'resolved',
      agent: 'claude-code-cli', model: 'opus', harness: 'claude', outcome: 'completed', exitCode: 0,
    });
    const fixtureHandle = {
      attemptId: fixtureAttemptId, agent: fixtureAgent, model: fixtureModel, harness: fixtureHarness,
      worktreeName: fixtureWorktree, expectedBranch: fixtureBranch,
      checkpointHead: fixtureCheckpointHead, checkpointStatusFingerprint: fixtureStatusFingerprint,
    };
    const expectedBindingDigest = restrictedHandleBindingDigest({
      attemptId: fixtureAttemptId, agent: fixtureAgent, model: fixtureModel, harness: fixtureHarness,
      checkpointHead: fixtureCheckpointHead, checkpointStatusFingerprint: fixtureStatusFingerprint,
    });
    // Exact preserved #136 checkpoint shape: phase starting; outcome
    // unknown_failure; exit_code 1; recovery_eligible 0; recovery_action
    // attention_required; recovery_attempt_count 0; checkpoint/session/
    // worktree available; branch/pr not available; attention_status
    // attention_required; resolution_state unresolved; persisted model NULL.
    sourceStore.recordRecoveryAttempt({
      attemptId: fixtureAttemptId, repo: 'TheTekTeam/agent-runner', issueNumber: 136,
      startedAt: '2026-08-03T17:27:49.192Z', resolutionState: 'unresolved',
      phase: 'starting', agent: fixtureAgent, harness: fixtureHarness, model: null,
      outcome: 'unknown_failure', exitCode: 1, recoveryEligible: false, recoveryAction: 'attention_required',
      recoveryAttemptCount: 0, checkpointAvailable: true, sessionAvailable: true, worktreeAvailable: true,
      branchAvailable: false, prAvailable: false, attentionStatus: 'attention_required',
      managerPreflightRevision: fixtureManagerRevision, managerPreflightFingerprint: fixtureManagerFingerprint,
      managerPreflightBodyDigest: fixtureManagerBodyDigest, restrictedHandleDigest: expectedBindingDigest,
    });
    sourceStore.close();

    // A real restricted-handle directory/file (mode-0700/0600, real
    // owner/type checks) written through the real
    // `writeRestrictedRecoveryHandle()` production code path, not a
    // synthetic in-memory stub.
    writeRestrictedRecoveryHandle(sourceDir, fixtureAttemptId, fixtureHandle);

    // Copy the whole fixture (db file + restricted directory) into a fresh
    // temporary directory. The command below operates only on the copy.
    //
    // `fs.cpSync()` copies file *contents*, not POSIX permission bits -- the
    // copy lands with whatever mode the process umask produces, not the
    // source's mode-0700/0600. A real backup/restore of a restricted
    // directory would need to explicitly restore those bits too, so the
    // fixture does that explicitly here rather than relying on (or
    // weakening) the adapter's real owner/mode/type/symlink checks, which
    // must keep failing closed on a genuinely wrong-permission directory.
    cpSync(sourceDir, copyDir, { recursive: true });
    chmodSync(join(copyDir, '.restricted-recovery'), 0o700);
    chmodSync(join(copyDir, '.restricted-recovery', `${fixtureAttemptId.replace(/[^A-Za-z0-9._:#-]/g, '_')}.json`), 0o600);
    const copyDbPath = join(copyDir, 'state.sqlite');

    const unrelatedRowBefore = openRunnerStateStore(copyDbPath).recoveryAttempt('unrelated-attempt-should-stay-byte-identical');
    const fixtureHandleFileBefore = readFileSync(join(copyDir, '.restricted-recovery', `${fixtureAttemptId.replace(/[^A-Za-z0-9._:#-]/g, '_')}.json`), 'utf8');

    const argv = [
      '--attempt-id', fixtureAttemptId, '--repo', 'TheTekTeam/agent-runner',
      '--agent', fixtureAgent, '--harness', fixtureHarness, '--model', fixtureModel,
      '--branch', fixtureBranch, '--worktree', fixtureWorktree,
      '--manager-revision', fixtureManagerRevision, '--manager-fingerprint', fixtureManagerFingerprint,
      '--manager-body-digest', fixtureManagerBodyDigest,
      '--repo-root', '/tmp/does-not-matter', '--output-dir', copyDir, '--state-db', copyDbPath,
    ];
    const dependencies = {
      uid: 1000,
      ghRunner: noPublicationGhRunner(),
      // The real restricted-handle reader (`readRestrictedRecoveryHandle`),
      // exercised against the real copied handle file -- not a stub.
      restrictedHandleReader: readRestrictedRecoveryHandle,
      worktreeVerifier: currentWorktreeVerifier(),
      openStore: () => openRunnerStateStore(copyDbPath),
    };

    const first = runRecoveryModelReconcileCommand({ argv, ...dependencies });
    assert.equal(first.exitCode, EXIT_OK, JSON.stringify(first.output));
    assert.equal(first.output.code, 'reconciliation-complete');
    assert.equal(first.output.model, fixtureModel);
    assert.equal(first.output.bindingDigest, expectedBindingDigest);

    const storeAfter = openRunnerStateStore(copyDbPath);
    const repairedRow = storeAfter.recoveryAttempt(fixtureAttemptId);
    assert.equal(repairedRow.model, fixtureModel);
    assert.equal(repairedRow.restricted_handle_digest, expectedBindingDigest);
    // Every other persisted field on the repaired row is untouched.
    assert.equal(repairedRow.agent, fixtureAgent);
    assert.equal(repairedRow.harness, fixtureHarness);
    assert.equal(repairedRow.manager_preflight_revision, fixtureManagerRevision);
    assert.equal(repairedRow.outcome, 'unknown_failure');
    assert.equal(repairedRow.exit_code, 1);
    // The unrelated row remains byte-identical.
    const unrelatedRowAfter = storeAfter.recoveryAttempt('unrelated-attempt-should-stay-byte-identical');
    assert.deepEqual(unrelatedRowAfter, unrelatedRowBefore);
    storeAfter.close();

    // Binding verification is restored: recomputing the digest from the
    // now-repaired persisted row's own agent/model/harness exactly matches
    // the stored digest (this is exactly the check that failed before
    // reconciliation, per the issue's `persisted-model-missing-handle-
    // binding-valid` classification).
    const recomputed = restrictedHandleBindingDigest({
      attemptId: fixtureAttemptId, agent: repairedRow.agent, model: repairedRow.model, harness: repairedRow.harness,
      checkpointHead: fixtureCheckpointHead, checkpointStatusFingerprint: fixtureStatusFingerprint,
    });
    assert.equal(recomputed, repairedRow.restricted_handle_digest);

    // Replay performs no second write: the same command, run again, returns
    // reconciliation-replay and the row is unchanged.
    const second = runRecoveryModelReconcileCommand({ argv, ...dependencies });
    assert.equal(second.exitCode, EXIT_OK, JSON.stringify(second.output));
    assert.equal(second.output.code, 'reconciliation-replay');
    const storeAfterReplay = openRunnerStateStore(copyDbPath);
    const rowAfterReplay = storeAfterReplay.recoveryAttempt(fixtureAttemptId);
    assert.deepEqual(rowAfterReplay, repairedRow);
    storeAfterReplay.close();
    // The restricted handle file itself is untouched by the repair -- only
    // the SQLite row's `model` column changed.
    const fixtureHandleFileAfter = readFileSync(join(copyDir, '.restricted-recovery', `${fixtureAttemptId.replace(/[^A-Za-z0-9._:#-]/g, '_')}.json`), 'utf8');
    assert.equal(fixtureHandleFileAfter, fixtureHandleFileBefore);
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(copyDir, { recursive: true, force: true });
  }
});

test('package.json exposes a recovery:model:reconcile script pointing at this command entrypoint', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts['recovery:model:reconcile'],
    'node scripts/ops/agent-runner-recovery-model-reconcile-command.mjs',
  );
});

test('the recovery-model-reconcile operator document exists', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const docPath = join(repoRoot, 'docs', 'ops', 'AGENT-RUNNER-RECOVERY-MODEL-RECONCILE.md');
  assert.equal(existsSync(docPath), true);
  const contents = readFileSync(docPath, 'utf8');
  assert.match(contents, /non-root/i);
  assert.match(contents, /--attempt-id/);
  assert.match(contents, /reconciliation-replay/);
});

test('runRecoveryModelReconcileCommand: bounded output never contains a session reference, restricted path, prompt, provider output or credential', () => {
  const { dir, path, store } = tempStore();
  try {
    seedAttempt(store, { model: null });
    const result = runRecoveryModelReconcileCommand({
      argv: baseArgv({ '--repo-root': '/tmp/should-never-appear-in-output', '--output-dir': '.var/should-never-appear-either' }, { stateDb: path }),
      ...successDependencies({ openStore: () => openRunnerStateStore(path) }),
    });
    const serialized = JSON.stringify(result.output);
    assert.equal(result.output.code, 'reconciliation-complete', serialized);
    assert.ok(!serialized.includes('/tmp/should-never-appear-in-output'));
    assert.ok(!serialized.includes('.var/should-never-appear-either'));
    assert.ok(!serialized.toLowerCase().includes('session'));
    assert.ok(!serialized.toLowerCase().includes('token'));
    assert.ok(!serialized.toLowerCase().includes('secret'));
    const allowedKeys = new Set(['ok', 'code', 'attemptId', 'model', 'bindingDigest']);
    for (const key of Object.keys(result.output)) assert.ok(allowedKeys.has(key), key);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
