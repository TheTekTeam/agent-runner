import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeImplementationApprovers } from './agent-runner-admission.mjs';
import {
  managerAuthorityKey,
  parseManagerPreflightPacket,
} from './agent-runner-manager-authority.mjs';
import {
  SOURCE_ACTIVATION_AUTHORITY_MARKER,
  SOURCE_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
  SOURCE_ACTIVATION_STATE_SCHEMA_VERSION,
  evaluateSourceActivationAuthority,
  normalizeSourceActivationState,
  parseSourceActivationAuthority,
  sourceActivationAuthorityKey,
  sourceActivationFingerprint,
  writeSourceActivationState,
} from './agent-runner-source-activation-authority.mjs';

const TARGET = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const ISSUE = 41;
const ENV = Object.freeze({
  AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED: 'true',
  AGENT_RUNNER_SOURCE_ACTIVATION_CONTROL_ISSUE: String(ISSUE),
  CLAUDE_RUNNER_IMPLEMENTATION_APPROVERS: 'gpcola chatgpt-manager',
});

function authorityMaterial(overrides = {}) {
  return {
    schema_version: SOURCE_ACTIVATION_AUTHORITY_SCHEMA_VERSION,
    revision: 'AR-SOURCE-ACTIVATE-2026-08-17.1',
    target_repository: 'TheTekTeam/agent-runner',
    target_branch: 'main',
    target_commit: TARGET,
    producer_type: 'normal_chatgpt_manager_session',
    reason: 'accepted-main-after-reviewed-merge',
    ...overrides,
  };
}

function authorityComment({ id = 100, login = 'gpcola', overrides = {}, fingerprint = null } = {}) {
  const material = authorityMaterial(overrides);
  const fp = fingerprint || sourceActivationFingerprint(material);
  return {
    id,
    user: { login },
    body: `${SOURCE_ACTIVATION_AUTHORITY_MARKER}\n\n\`\`\`yaml\n${Object.entries(material).map(([key, value]) => `${key}: ${value}`).join('\n')}\nfingerprint: ${fp}\n\`\`\``,
  };
}

function stateFor(comment, { status = 'applied', finalHead = TARGET, refusalReason = null } = {}) {
  const parsed = parseSourceActivationAuthority(comment);
  assert.equal(parsed.valid, true);
  return {
    schemaVersion: SOURCE_ACTIVATION_STATE_SCHEMA_VERSION,
    sourceIssueNumber: ISSUE,
    sourceCommentId: parsed.commentId,
    authorityKey: parsed.authorityKey,
    revision: parsed.revision,
    fingerprint: parsed.fingerprint,
    bodyDigest: parsed.bodyDigest,
    targetCommit: parsed.targetCommit,
    status,
    refusalReason,
    appliedAt: status === 'applied' ? '2026-08-17T21:00:00.000Z' : null,
    finalHead: status === 'applied' ? finalHead : null,
  };
}

function harness({ comments = [], state = null, head = TARGET, activation = null } = {}) {
  const writes = [];
  const calls = { fetch: 0, activate: 0, readHead: 0 };
  return {
    writes,
    calls,
    options: {
      env: { ...ENV },
      fetchComments: () => { calls.fetch += 1; return comments; },
      readState: () => state,
      writeState: (value) => { const normalized = normalizeSourceActivationState(value); writes.push(normalized); state = normalized; return normalized; },
      readHead: () => { calls.readHead += 1; return head; },
      activateSource: async ({ target }) => {
        calls.activate += 1;
        if (activation instanceof Error) throw activation;
        if (typeof activation === 'function') return activation(target);
        return activation || { ok: true, result: 'activated', finalHead: target };
      },
      now: () => '2026-08-17T21:30:00.000Z',
    },
  };
}

test('source authority is strict, fingerprint-bound and a separate authority domain', () => {
  const comment = authorityComment();
  const parsed = parseSourceActivationAuthority(comment);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.targetCommit, TARGET);
  assert.equal(parsed.authorityKey.startsWith('source-activation:'), true);
  assert.equal(parseManagerPreflightPacket(comment).valid, false, 'source authority must never be manager-preflight authority');

  const managerPacket = `${'<!-- agent-runner:manager-preflight -->'}\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: SAME-REVISION\nfingerprint: ${parsed.fingerprint}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nscope:\n  - bounded\nrequired_validation:\n  - test\nstop_conditions:\n  - stop\n\`\`\``;
  assert.equal(parseSourceActivationAuthority(managerPacket).valid, false, 'manager preflight must never be source authority');
  assert.notEqual(
    sourceActivationAuthorityKey('SAME-REVISION', parsed.fingerprint),
    managerAuthorityKey('SAME-REVISION', parsed.fingerprint),
    'dedupe keys must not collide across authority domains',
  );
});

test('malformed, wrong-repo, wrong-branch, abbreviated-SHA and bad-fingerprint packets fail closed', () => {
  for (const comment of [
    authorityComment({ overrides: { target_repository: 'TheTekTeam/modelspend' } }),
    authorityComment({ overrides: { target_branch: 'feature' } }),
    authorityComment({ overrides: { target_commit: 'abc123' } }),
    authorityComment({ fingerprint: `sha256:${'f'.repeat(64)}` }),
  ]) {
    const parsed = parseSourceActivationAuthority(comment);
    assert.equal(parsed.valid, false);
    assert.equal(parsed.canonical, true);
  }
  const duplicate = authorityComment();
  duplicate.body = `${duplicate.body}\n${SOURCE_ACTIVATION_AUTHORITY_MARKER}`;
  assert.equal(parseSourceActivationAuthority(duplicate).reason, 'source-activation-authority-marker-ambiguous');
});

test('valid approved authority becomes pending, activates exact target, then becomes applied and requests one re-exec', async () => {
  const comment = authorityComment();
  const h = harness({ comments: [comment], head: '0'.repeat(40) });
  const result = await evaluateSourceActivationAuthority(h.options);
  assert.equal(result.action, 'reexec');
  assert.equal(result.targetCommit, TARGET);
  assert.equal(h.calls.activate, 1);
  assert.deepEqual(h.writes.map((entry) => entry.status), ['pending', 'applied']);
  assert.equal(h.writes.at(-1).finalHead, TARGET);
  assert.equal(h.writes.at(-1).sourceCommentId, 100);
});

test('same applied authority is deduped and does not activate or re-exec again', async () => {
  const comment = authorityComment();
  const h = harness({ comments: [comment], state: stateFor(comment), head: TARGET });
  const result = await evaluateSourceActivationAuthority(h.options);
  assert.deepEqual(result, { action: 'continue', reason: 'source-activation-authority-already-applied' });
  assert.equal(h.calls.activate, 0);
  assert.equal(h.writes.length, 0);
});

test('applied state with unexpected canonical HEAD fails closed before GitHub lookup or activation', async () => {
  const comment = authorityComment();
  const h = harness({ comments: [comment], state: stateFor(comment), head: NEXT });
  const result = await evaluateSourceActivationAuthority(h.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'source-activation-applied-head-mismatch');
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.calls.activate, 0);
});

test('edited consumed authority fails closed and cannot revoke or mutate unrelated implementation authority', async () => {
  const original = authorityComment();
  const edited = { ...original, body: `${original.body}\nedited` };
  const h = harness({ comments: [edited], state: stateFor(original), head: TARGET });
  const result = await evaluateSourceActivationAuthority(h.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'source-activation-authority-edited-after-consumption');
  assert.equal(h.calls.activate, 0);
  assert.equal(h.writes.length, 0);
});

test('unapproved author and ambiguous simultaneous new authorities refuse before activation', async () => {
  const unapproved = harness({ comments: [authorityComment({ login: 'worker-bot' })], head: '0'.repeat(40) });
  const denied = await evaluateSourceActivationAuthority(unapproved.options);
  assert.equal(denied.action, 'halt');
  assert.equal(denied.reason, 'source-activation-author-unapproved');
  assert.equal(unapproved.calls.activate, 0);
  assert.equal(unapproved.writes.at(-1).status, 'refused');

  const ambiguous = harness({ comments: [authorityComment({ id: 100 }), authorityComment({ id: 101, overrides: { revision: 'AR-SOURCE-ACTIVATE-2026-08-17.2', target_commit: NEXT } })] });
  const result = await evaluateSourceActivationAuthority(ambiguous.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'source-activation-authority-ambiguous');
  assert.equal(ambiguous.calls.activate, 0);
});

test('live implementation lock is a handled pending deferral, not a consumed refusal', async () => {
  const comment = authorityComment();
  const lock = new Error('held');
  lock.code = 'AGENT_RUNNER_LOCKED';
  const h = harness({ comments: [comment], head: '0'.repeat(40), activation: lock });
  const result = await evaluateSourceActivationAuthority(h.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'implementation-lock-unavailable');
  assert.equal(h.writes.at(-1).status, 'pending');
  assert.equal(h.writes.at(-1).refusalReason, 'implementation-lock-unavailable');
});

test('pending authority retries only the same immutable comment and newer simultaneous authority makes it ambiguous', async () => {
  const comment = authorityComment();
  const pending = stateFor(comment, { status: 'pending', finalHead: null });
  const retry = harness({ comments: [comment], state: pending, head: '0'.repeat(40) });
  assert.equal((await evaluateSourceActivationAuthority(retry.options)).action, 'reexec');
  assert.equal(retry.calls.activate, 1);

  const newer = authorityComment({ id: 101, overrides: { revision: 'AR-SOURCE-ACTIVATE-2026-08-17.2', target_commit: NEXT } });
  const blocked = harness({ comments: [comment, newer], state: pending, head: '0'.repeat(40) });
  const result = await evaluateSourceActivationAuthority(blocked.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'source-activation-authority-ambiguous');
  assert.equal(blocked.calls.activate, 0);
});

test('refused authority is durably deduped and blocks worker progression until a newer authority exists', async () => {
  const comment = authorityComment({ login: 'worker-bot' });
  const first = harness({ comments: [comment], head: '0'.repeat(40) });
  await evaluateSourceActivationAuthority(first.options);
  const refused = first.writes.at(-1);
  const second = harness({ comments: [comment], state: refused, head: '0'.repeat(40) });
  const result = await evaluateSourceActivationAuthority(second.options);
  assert.equal(result.action, 'halt');
  assert.equal(result.reason, 'source-activation-author-unapproved');
  assert.equal(second.calls.activate, 0);
  assert.equal(second.writes.length, 0);
});

test('disabled policy performs no GitHub/state/head/activation work', async () => {
  const h = harness({ comments: [authorityComment()] });
  h.options.env.AGENT_RUNNER_SOURCE_ACTIVATION_ENABLED = 'false';
  h.options.readState = () => { throw new Error('must not read state'); };
  const result = await evaluateSourceActivationAuthority(h.options);
  assert.deepEqual(result, { action: 'continue', reason: 'source-activation-disabled' });
  assert.equal(h.calls.fetch, 0);
  assert.equal(h.calls.activate, 0);
});

test('durable source state is positive-allowlisted, separate and mode 0600', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ar234-state-'));
  try {
    const comment = authorityComment();
    const state = stateFor(comment);
    const env = { HOME: temp, AGENT_RUNNER_SOURCE_ACTIVATION_STATE: join(temp, 'state', 'activation.json') };
    writeSourceActivationState(state, { env });
    assert.equal(statSync(env.AGENT_RUNNER_SOURCE_ACTIVATION_STATE).mode & 0o777, 0o600);
    const raw = readFileSync(env.AGENT_RUNNER_SOURCE_ACTIVATION_STATE, 'utf8');
    assert.doesNotMatch(raw, /comment body|github\.com|token|prompt|\/home\//i);
    assert.throws(() => normalizeSourceActivationState({ ...state, secret: 'nope' }), /unsupported fields or shape/);
    assert.deepEqual(normalizeImplementationApprovers('GPCola gpcola').approvers, ['gpcola']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
