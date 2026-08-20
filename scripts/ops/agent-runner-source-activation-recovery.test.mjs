import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOURCE_ACTIVATION_AUTHORITY_MARKER,
  SOURCE_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
  SOURCE_ACTIVATION_STATE_SCHEMA_VERSION,
  normalizeSourceActivationState,
  parseSourceActivationAuthority,
  sourceActivationFingerprint,
} from './agent-runner-source-activation-authority.mjs';
import { recoverAppliedSourceActivationHeadMismatch } from './agent-runner-source-activation-recovery.mjs';
import { SourceActivationRefusal } from './agent-runner-source-activation.mjs';

const OLD = 'a'.repeat(40);
const CURRENT = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const ISSUE = 263;
const ENV = Object.freeze({
  AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED: 'true',
  AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE: String(ISSUE),
  CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola chatgpt-manager',
});

function material({ revision, target }) {
  return {
    schema_version: SOURCE_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
    revision,
    target_repository: 'TheTekTeam/agent-runner',
    target_branch: 'main',
    target_commit: target,
    producer_type: 'normal_chatgpt_manager_session',
    reason: 'accepted-main-merged-validation-green',
  };
}

function authorityComment({ id, revision, target, login = 'gpcola', fingerprint = null }) {
  const values = material({ revision, target });
  const fp = fingerprint || sourceActivationFingerprint(values);
  return {
    id,
    user: { login },
    body: `${SOURCE_ACTIVATION_AUTHORITY_MARKER}\n\n\`\`\`yaml\n${Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('\n')}\nfingerprint: ${fp}\n\`\`\``,
  };
}

function appliedState(comment, appliedAt = '2026-08-20T19:00:00.000Z') {
  const parsed = parseSourceActivationAuthority(comment);
  assert.equal(parsed.valid, true);
  return normalizeSourceActivationState({
    schemaVersion: SOURCE_ACTIVATION_STATE_SCHEMA_VERSION,
    sourceIssueNumber: ISSUE,
    sourceCommentId: parsed.commentId,
    authorityKey: parsed.authorityKey,
    revision: parsed.revision,
    fingerprint: parsed.fingerprint,
    bodyDigest: parsed.bodyDigest,
    targetCommit: parsed.targetCommit,
    status: 'applied',
    refusalReason: null,
    appliedAt,
    finalHead: parsed.targetCommit,
  });
}

function harness({ newer = [], currentHead = CURRENT, activation = null, state = null } = {}) {
  const oldComment = authorityComment({
    id: 100,
    revision: 'AR-SOURCE-ACTIVATE-2026-08-20.5',
    target: OLD,
  });
  let currentState = state || appliedState(oldComment);
  const writes = [];
  const calls = { fetch: 0, activate: 0, readHead: 0 };
  const comments = [oldComment, ...newer];
  return {
    oldComment,
    comments,
    writes,
    calls,
    get state() { return currentState; },
    options: {
      env: { ...ENV },
      fetchComments: () => { calls.fetch += 1; return comments; },
      readState: () => currentState,
      writeState: (value) => {
        currentState = normalizeSourceActivationState(value);
        writes.push(currentState);
        return currentState;
      },
      readHead: () => { calls.readHead += 1; return currentHead; },
      activateSource: async ({ target }) => {
        calls.activate += 1;
        if (activation instanceof Error) throw activation;
        if (typeof activation === 'function') return activation(target);
        return activation || { ok: true, result: 'already-active', finalHead: target };
      },
      now: () => '2026-08-20T21:30:00.000Z',
    },
  };
}

test('stale applied state reconciles through a newer approved exact-current-head authority', async () => {
  const next = authorityComment({
    id: 101,
    revision: 'AR-SOURCE-ACTIVATE-2026-08-20.6',
    target: CURRENT,
  });
  const h = harness({ newer: [next] });
  const result = await recoverAppliedSourceActivationHeadMismatch(h.options);

  assert.equal(result.action, 'reexec');
  assert.equal(result.reason, 'source-activation-applied-head-reconciled');
  assert.equal(result.previousSourceCommentId, 100);
  assert.equal(result.sourceCommentId, 101);
  assert.equal(result.targetCommit, CURRENT);
  assert.equal(h.calls.fetch, 1);
  assert.equal(h.calls.activate, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].status, 'applied');
  assert.equal(h.writes[0].sourceCommentId, 101);
  assert.equal(h.writes[0].targetCommit, CURRENT);
  assert.equal(h.writes[0].finalHead, CURRENT);
});

test('stale applied state may cross valid historical generations but only the newest may match current HEAD', async () => {
  const h = harness({
    newer: [
      authorityComment({ id: 101, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.6', target: OTHER }),
      authorityComment({ id: 102, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.7', target: CURRENT }),
    ],
  });
  const result = await recoverAppliedSourceActivationHeadMismatch(h.options);
  assert.equal(result.action, 'reexec');
  assert.equal(result.sourceCommentId, 102);
  assert.equal(result.targetCommit, CURRENT);
  assert.equal(h.calls.activate, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].sourceCommentId, 102);
});

test('unexplained applied-head drift with no newer authority remains fail closed and immutable', async () => {
  const h = harness();
  const result = await recoverAppliedSourceActivationHeadMismatch(h.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'source-activation-applied-head-mismatch');
  assert.equal(h.calls.activate, 0);
  assert.equal(h.writes.length, 0);
});

test('newest authority must target the exact current canonical HEAD', async () => {
  const h = harness({
    newer: [
      authorityComment({ id: 101, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.6', target: CURRENT }),
      authorityComment({ id: 102, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.7', target: OTHER }),
    ],
  });
  const result = await recoverAppliedSourceActivationHeadMismatch(h.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'source-activation-recovery-target-head-mismatch');
  assert.equal(h.calls.activate, 0);
  assert.equal(h.writes.length, 0);
});

test('malformed or unapproved newer authority anywhere in the chain cannot replace the stale applied record', async () => {
  const malformed = authorityComment({
    id: 101,
    revision: 'AR-SOURCE-ACTIVATE-2026-08-20.6',
    target: OTHER,
    fingerprint: `sha256:${'f'.repeat(64)}`,
  });
  const invalid = harness({
    newer: [
      malformed,
      authorityComment({ id: 102, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.7', target: CURRENT }),
    ],
  });
  const invalidResult = await recoverAppliedSourceActivationHeadMismatch(invalid.options);
  assert.equal(invalidResult.action, 'halt');
  assert.equal(invalidResult.reason, 'source-activation-recovery-authority-invalid');
  assert.equal(invalid.calls.activate, 0);
  assert.equal(invalid.writes.length, 0);

  const denied = harness({
    newer: [
      authorityComment({ id: 101, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.6', target: OTHER, login: 'worker-bot' }),
      authorityComment({ id: 102, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.7', target: CURRENT }),
    ],
  });
  const deniedResult = await recoverAppliedSourceActivationHeadMismatch(denied.options);
  assert.equal(deniedResult.action, 'halt');
  assert.equal(deniedResult.reason, 'source-activation-recovery-author-unapproved');
  assert.equal(denied.calls.activate, 0);
  assert.equal(denied.writes.length, 0);
});

test('edited previously consumed authority blocks recovery before activation', async () => {
  const next = authorityComment({ id: 101, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.6', target: CURRENT });
  const h = harness({ newer: [next] });
  h.comments[0] = { ...h.comments[0], body: `${h.comments[0].body}\nedited` };
  h.options.fetchComments = () => { h.calls.fetch += 1; return h.comments; };

  const result = await recoverAppliedSourceActivationHeadMismatch(h.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'source-activation-authority-edited-after-consumption');
  assert.equal(h.calls.activate, 0);
  assert.equal(h.writes.length, 0);
});

test('accepted source preflight refusal or implementation lock leaves stale applied state untouched', async () => {
  const next = authorityComment({ id: 101, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.6', target: CURRENT });

  const dirty = harness({
    newer: [next],
    activation: new SourceActivationRefusal('dirty-checkout'),
  });
  const dirtyResult = await recoverAppliedSourceActivationHeadMismatch(dirty.options);
  assert.equal(dirtyResult.action, 'halt');
  assert.equal(dirtyResult.reason, 'dirty-checkout');
  assert.equal(dirty.writes.length, 0);

  const lock = new Error('held');
  lock.code = 'AGENT_RUNNER_LOCKED';
  const locked = harness({ newer: [next], activation: lock });
  const lockResult = await recoverAppliedSourceActivationHeadMismatch(locked.options);
  assert.equal(lockResult.action, 'halt');
  assert.equal(lockResult.reason, 'implementation-lock-unavailable');
  assert.equal(locked.writes.length, 0);
});

test('recovery refuses an activator result that is not exact already-active proof', async () => {
  const next = authorityComment({ id: 101, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.6', target: CURRENT });
  const h = harness({
    newer: [next],
    activation: { ok: true, result: 'activated', finalHead: CURRENT },
  });
  const result = await recoverAppliedSourceActivationHeadMismatch(h.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'source-activation-recovery-result-invalid');
  assert.equal(h.writes.length, 0);
});

test('successful recovery is idempotent on replay and does not re-fetch or reactivate', async () => {
  const next = authorityComment({ id: 101, revision: 'AR-SOURCE-ACTIVATE-2026-08-20.6', target: CURRENT });
  const first = harness({ newer: [next] });
  assert.equal((await recoverAppliedSourceActivationHeadMismatch(first.options)).action, 'reexec');

  const replay = harness({ newer: [next], state: first.state, currentHead: CURRENT });
  const replayResult = await recoverAppliedSourceActivationHeadMismatch(replay.options);
  assert.deepEqual(replayResult, { action: 'continue', reason: 'source-activation-recovery-not-needed' });
  assert.equal(replay.calls.fetch, 0);
  assert.equal(replay.calls.activate, 0);
  assert.equal(replay.writes.length, 0);
});

test('disabled or non-applied state performs no recovery work', async () => {
  const h = harness();
  h.options.env.AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED = 'false';
  assert.deepEqual(
    await recoverAppliedSourceActivationHeadMismatch(h.options),
    { action: 'continue', reason: 'source-activation-recovery-disabled' },
  );
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.calls.activate, 0);

  const nonApplied = harness({ state: { ...h.state, status: 'refused', appliedAt: null, finalHead: null, refusalReason: 'test-refusal' } });
  assert.deepEqual(
    await recoverAppliedSourceActivationHeadMismatch(nonApplied.options),
    { action: 'continue', reason: 'source-activation-recovery-not-applicable' },
  );
  assert.equal(nonApplied.calls.fetch, 0);
  assert.equal(nonApplied.calls.activate, 0);
});
