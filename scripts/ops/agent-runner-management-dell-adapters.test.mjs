import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDellManagementAdapters } from './agent-runner-management-dell-adapters.mjs';

/**
 * #268: the real Dell adapters, driven through their injected process runner.
 * These prove the fail-closed reads the global-slot invariant and the exact-head
 * review contract depend on.
 */

const REPOSITORY = 'TheTekTeam/agent-runner';
const HEAD_SHA = 'd'.repeat(40);
const OLD_SHA = 'e'.repeat(40);
const T0 = '2026-08-22T09:00:00.000Z';
// Above the default Linux pid_max, so it reliably resolves to "no such process".
const DEAD_PID = 2147483647;

const PROFILE = Object.freeze({
  projectId: 'agent-runner',
  repository: Object.freeze({ owner: 'TheTekTeam', name: 'agent-runner', full: REPOSITORY }),
  validation: Object.freeze({ profile: 'complex', requiredChecks: Object.freeze(['validate']) }),
  labels: Object.freeze({ ready: 'status:ready', inProgress: 'status:in-progress' }),
});

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-dell-adapters-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A bounded fake process runner routing `gh` calls by endpoint. */
function fakeSpawn(routes = {}) {
  return (command, args) => {
    if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
      return { status: 0, stdout: JSON.stringify(routes.graphql ?? { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) };
    }
    if (command === 'gh' && args[0] === 'api') {
      const endpoint = args[3];
      for (const [pattern, payload] of Object.entries(routes)) {
        if (pattern !== 'graphql' && endpoint.includes(pattern)) {
          return { status: 0, stdout: JSON.stringify(payload) };
        }
      }
      return { status: 0, stdout: 'null' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
}

// ------------------------------------------------------------ implementation slot

test('an absent lock is the only unambiguous free slot', () => {
  withTempDir((dir) => {
    const adapters = createDellManagementAdapters({ env: { AGENT_RUNNER_IMPLEMENTATION_LOCK: join(dir, 'absent.lock') } });
    const slot = adapters.readImplementationSlot({});
    assert.equal(slot.state, 'free');
    assert.equal(slot.occupied, false);
    assert.equal(slot.recoverable, false);
  });
});

test('a live lock reports the slot occupied', () => {
  withTempDir((dir) => {
    const lockPath = join(dir, 'live.lock');
    writeFileSync(lockPath, `${process.pid}\n${T0}\n`);
    const slot = createDellManagementAdapters({ env: { AGENT_RUNNER_IMPLEMENTATION_LOCK: lockPath } }).readImplementationSlot({});
    assert.equal(slot.state, 'occupied');
    assert.equal(slot.occupied, true);
  });
});

test('a well-formed lock whose holder is gone is recoverable, consistent with the accepted lock contract', () => {
  withTempDir((dir) => {
    const lockPath = join(dir, 'dead.lock');
    writeFileSync(lockPath, `${DEAD_PID}\n${T0}\n`);
    const slot = createDellManagementAdapters({ env: { AGENT_RUNNER_IMPLEMENTATION_LOCK: lockPath } }).readImplementationSlot({});
    assert.equal(slot.state, 'free');
    assert.equal(slot.recoverable, true);
  });
});

test('a malformed lock is ambiguous, never free', () => {
  withTempDir((dir) => {
    const lockPath = join(dir, 'malformed.lock');
    writeFileSync(lockPath, 'not-a-pid\nnot-a-date\n');
    const slot = createDellManagementAdapters({ env: { AGENT_RUNNER_IMPLEMENTATION_LOCK: lockPath } }).readImplementationSlot({});
    assert.equal(slot.state, 'ambiguous');
    assert.equal(slot.occupied, false);
    assert.equal(slot.reason, 'lock-malformed');
  });
});

test('an unreadable lock is ambiguous, never free', () => {
  withTempDir((dir) => {
    // A directory where a lock file is expected: readable-as-a-file fails with
    // a non-ENOENT error on every platform, unlike a permission trick.
    const lockPath = join(dir, 'unreadable.lock');
    mkdirSync(lockPath);
    const slot = createDellManagementAdapters({ env: { AGENT_RUNNER_IMPLEMENTATION_LOCK: lockPath } }).readImplementationSlot({});
    assert.equal(slot.state, 'ambiguous');
    assert.equal(slot.occupied, false);
    assert.equal(slot.reason, 'lock-unreadable');
  });
});

test('ownership reports only what GitHub proves and never invents a lease', () => {
  const adapters = createDellManagementAdapters({
    env: {},
    spawn: fakeSpawn({
      '/pulls': [{ number: 42, title: 'x', head: { sha: HEAD_SHA, ref: 'claude/shadow-equivalence-evidence-900' }, labels: [] }],
    }),
  });
  const ownership = adapters.readOwnership({ project: {}, profile: PROFILE });
  // Lease evidence comes from the durable authority ledger in the collector,
  // because an active worker exists before any pull request does.
  assert.deepEqual(ownership.activeLeases, []);
  assert.deepEqual(ownership.openPullRequests, [{ number: 42, issueNumber: 900, headSha: HEAD_SHA }]);
});

// ------------------------------------------------------------ review evidence

function attemptWith({ reviews = [], threads = [], pullOverrides = {} } = {}) {
  const adapters = createDellManagementAdapters({
    env: {},
    now: () => T0,
    spawn: fakeSpawn({
      '/pulls/42/reviews': reviews,
      '/check-runs': { check_runs: [{ name: 'validate', status: 'completed', conclusion: 'success' }] },
      '/pulls/42': {
        number: 42,
        head: { sha: HEAD_SHA, ref: 'claude/shadow-equivalence-evidence-900' },
        base: { sha: 'a'.repeat(40) },
        state: 'open',
        draft: true,
        mergeable_state: 'clean',
        changed_files: 2,
        additions: 10,
        deletions: 1,
        comments: 0,
        ...pullOverrides,
      },
      graphql: { data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } },
    }),
  });
  return adapters.readAttempt({ profile: PROFILE, pullRequestNumber: 42 });
}

test('changes requested at the exact head is bounded, actionable review evidence', () => {
  const attempt = attemptWith({
    reviews: [{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', commit_id: HEAD_SHA, submitted_at: T0, body: 'please fix the thing' }],
  });
  assert.equal(attempt.review.state, 'changes-requested');
  assert.equal(attempt.review.headSha, HEAD_SHA);
  assert.equal(attempt.review.findings.length, 1);
  assert.equal(attempt.review.findings[0].actionable, true);
  // No review prose is ever carried into management state.
  const serialized = JSON.stringify(attempt.review);
  assert.equal(serialized.includes('please fix the thing'), false);
});

test('an approval at the exact head with no unresolved thread is no-blockers', () => {
  const attempt = attemptWith({
    reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: HEAD_SHA, submitted_at: T0 }],
  });
  assert.equal(attempt.review.state, 'no-blockers');
  assert.deepEqual(attempt.review.findings, []);
});

test('an unresolved review thread blocks even when the head is approved', () => {
  const attempt = attemptWith({
    reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: HEAD_SHA, submitted_at: T0 }],
    threads: [{ isResolved: false }],
  });
  assert.equal(attempt.review.state, 'changes-requested');
  assert.ok(attempt.review.findings.some((finding) => finding.id === 'review-thread-unresolved'));
});

test('a review of an older head can never approve the current head', () => {
  const attempt = attemptWith({
    reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: OLD_SHA, submitted_at: T0 }],
  });
  // The stale approval is dropped, leaving the current head unreviewed.
  assert.equal(attempt.review.state, 'pending');
  assert.deepEqual(attempt.review.findings, []);
});

test('no review yet is pending, never green', () => {
  assert.equal(attemptWith({ reviews: [] }).review.state, 'pending');
});

test('a newer changes-requested review supersedes an earlier approval by the same reviewer', () => {
  const attempt = attemptWith({
    reviews: [
      { user: { login: 'reviewer' }, state: 'APPROVED', commit_id: HEAD_SHA, submitted_at: '2026-08-22T08:00:00Z' },
      { user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', commit_id: HEAD_SHA, submitted_at: '2026-08-22T09:00:00Z' },
    ],
  });
  assert.equal(attempt.review.state, 'changes-requested');
});

test('required checks are those the registered profile declared, read at the exact head', () => {
  const attempt = attemptWith({ reviews: [] });
  assert.equal(attempt.ci.headSha, HEAD_SHA);
  assert.deepEqual(attempt.ci.checks, [{ name: 'validate', state: 'success', required: true }]);
});

test('an unfinished check run is pending, never optimistically green', () => {
  const adapters = createDellManagementAdapters({
    env: {},
    now: () => T0,
    spawn: fakeSpawn({
      '/pulls/42/reviews': [],
      '/check-runs': { check_runs: [{ name: 'validate', status: 'in_progress', conclusion: null }] },
      '/pulls/42': {
        number: 42, head: { sha: HEAD_SHA, ref: 'claude/x-900' }, base: { sha: 'a'.repeat(40) },
        state: 'open', draft: true, mergeable_state: 'clean', changed_files: 1, additions: 1, deletions: 0, comments: 0,
      },
    }),
  });
  assert.equal(adapters.readAttempt({ profile: PROFILE, pullRequestNumber: 42 }).ci.checks[0].state, 'pending');
});

// ------------------------------------------------------------ merge and activation

test('a merged pull request stays observable after it leaves the open list', () => {
  const adapters = createDellManagementAdapters({
    env: {},
    spawn: fakeSpawn({
      '/pulls': [
        { number: 42, head: { sha: HEAD_SHA, ref: 'claude/shadow-equivalence-evidence-900' }, merged_at: '2026-08-22T08:00:00Z', merge_commit_sha: 'f'.repeat(40) },
        { number: 43, head: { sha: OLD_SHA, ref: 'claude/other-901' }, merged_at: null, merge_commit_sha: null },
      ],
    }),
  });
  const closed = adapters.listRecentlyClosedPullRequests({ profile: PROFILE });
  const merged = closed.filter((pull) => pull.merged);
  assert.equal(merged.length, 1, 'only an explicit merged_at counts as merged');
  assert.equal(merged[0].number, 42);
  assert.equal(merged[0].issueNumber, 900);
  assert.equal(merged[0].mergeCommitSha, 'f'.repeat(40));
  // A closed-but-unmerged pull request is never inferred to have merged.
  assert.equal(closed.find((pull) => pull.number === 43).merged, false);
});

test('the newest durable source-activation record is read without an operator-supplied SHA', () => {
  withTempDir((dir) => {
    const evidenceDir = join(dir, 'activation');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'activation-2026-08-22T07-00-00-1.json'), JSON.stringify({
      schemaVersion: 1, result: 'refused', requestedTarget: OLD_SHA, finalHead: null, recordedAt: '2026-08-22T07:00:00Z',
    }));
    writeFileSync(join(evidenceDir, 'activation-2026-08-22T08-00-00-2.json'), JSON.stringify({
      schemaVersion: 1, result: 'activated', requestedTarget: HEAD_SHA, finalHead: HEAD_SHA, recordedAt: '2026-08-22T08:00:00Z',
    }));
    const adapters = createDellManagementAdapters({ env: { AGENT_RUNNER_SOURCE_ACTIVATION_EVIDENCE_DIR: evidenceDir } });
    const activation = adapters.readSourceActivationEvidence({});
    assert.equal(activation.result, 'activated');
    assert.equal(activation.requestedTarget, HEAD_SHA);
    assert.equal(activation.finalHead, HEAD_SHA);
  });
});

test('a refusal is reported as a refusal, and a missing record as nothing observed', () => {
  withTempDir((dir) => {
    const evidenceDir = join(dir, 'activation');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'activation-2026-08-22T07-00-00-1.json'), JSON.stringify({
      schemaVersion: 1, result: 'refused', requestedTarget: OLD_SHA, finalHead: null, recordedAt: '2026-08-22T07:00:00Z',
    }));
    const adapters = createDellManagementAdapters({ env: { AGENT_RUNNER_SOURCE_ACTIVATION_EVIDENCE_DIR: evidenceDir } });
    assert.equal(adapters.readSourceActivationEvidence({}).result, 'refused');

    const empty = createDellManagementAdapters({ env: { AGENT_RUNNER_SOURCE_ACTIVATION_EVIDENCE_DIR: join(dir, 'none') } });
    assert.equal(empty.readSourceActivationEvidence({}), null);
  });
});

test('quota evidence that cannot be read fails closed as ambiguous', () => {
  const adapters = createDellManagementAdapters({
    env: {},
    spawn: () => { throw new Error('claude unavailable'); },
  });
  assert.equal(adapters.readQuotaAdmission({ profileName: 'complex' }).state, 'ambiguous');
});
