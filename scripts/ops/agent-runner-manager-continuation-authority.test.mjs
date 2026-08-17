import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGER_PREFLIGHT_ALREADY_CLAIMED,
  MANAGER_PREFLIGHT_REQUIRED,
  MANAGER_PREFLIGHT_REVOKED,
  parseManagerPreflightPacket,
  resolveCurrentManagerAuthority,
} from './agent-runner-manager-authority.mjs';
import { resolveManagerContinuationAuthority } from './agent-runner-manager-continuation-authority.mjs';

const FINGERPRINT_A = `sha256:${'a'.repeat(64)}`;
const FINGERPRINT_B = `sha256:${'b'.repeat(64)}`;

function packet({ id = 1, revision = 'AR240.1', fingerprint = FINGERPRINT_A } = {}) {
  return {
    id,
    createdAt: `2026-08-17T18:${String(id).padStart(2, '0')}:00Z`,
    user: { login: 'gpcola' },
    body: `<!-- agent-runner:manager-preflight -->\n\n\`\`\`yaml\nschema_version: agent-runner-manager-preflight/v1\nrevision: ${revision}\nfingerprint: ${fingerprint}\nproducer_type: normal_chatgpt_manager_session\napproved_agent: claude-code-cli\nexecution_phase: implementation\nscope:\n  - bounded continuation authority test\nrequired_validation:\n  - node --test focused\nstop_conditions:\n  - stop on scope expansion\n\`\`\``,
  };
}

function claim(authority, id = 10) {
  return {
    id,
    createdAt: `2026-08-17T19:${String(id).padStart(2, '0')}:00Z`,
    body: `## Claude runner started\n\n- Manager packet revision: ${authority.revision}\n- Manager packet fingerprint: ${authority.fingerprint}\n- Manager packet authority: ${authority.authorityKey}`,
  };
}

test('fresh current packet is valid continuation identity without changing fresh-claim semantics', () => {
  const comments = [packet()];
  const continuation = resolveManagerContinuationAuthority(comments);
  const fresh = resolveCurrentManagerAuthority(comments);

  assert.equal(continuation.allowed, true);
  assert.equal(continuation.alreadyClaimed, false);
  assert.equal(continuation.authority.authorityKey, fresh.authority.authorityKey);
  assert.equal(fresh.allowed, true);
});

test('matching claimed packet is allowed only as continuation identity', () => {
  const current = packet();
  const authority = parseManagerPreflightPacket(current);
  const comments = [current, claim(authority)];
  const continuation = resolveManagerContinuationAuthority(comments);
  const fresh = resolveCurrentManagerAuthority(comments);

  assert.equal(continuation.allowed, true);
  assert.equal(continuation.alreadyClaimed, true);
  assert.equal(continuation.authority.authorityKey, authority.authorityKey);
  assert.equal(fresh.allowed, false);
  assert.equal(fresh.reason, MANAGER_PREFLIGHT_ALREADY_CLAIMED);
});

test('missing authority remains refused', () => {
  const continuation = resolveManagerContinuationAuthority([]);
  assert.equal(continuation.allowed, false);
  assert.equal(continuation.reason, MANAGER_PREFLIGHT_REQUIRED);
  assert.equal(continuation.authority, null);
});

test('malformed current authority remains refused', () => {
  const malformed = packet({ fingerprint: 'sha256:short' });
  const continuation = resolveManagerContinuationAuthority([malformed]);
  assert.equal(continuation.allowed, false);
  assert.equal(continuation.authority, null);
});

test('revoked current authority remains refused', () => {
  const current = packet();
  const revoked = {
    id: 2,
    createdAt: '2026-08-17T18:02:00Z',
    body: '## Manager preflight packet — revoked\nDo not dispatch.',
  };
  const continuation = resolveManagerContinuationAuthority([current, revoked]);
  assert.equal(continuation.allowed, false);
  assert.equal(continuation.reason, MANAGER_PREFLIGHT_REVOKED);
});

test('newer packet supersedes an older claimed packet for continuation identity', () => {
  const old = packet({ revision: 'AR240.1', fingerprint: FINGERPRINT_A });
  const oldAuthority = parseManagerPreflightPacket(old);
  const current = packet({ id: 3, revision: 'AR240.2', fingerprint: FINGERPRINT_B });
  const continuation = resolveManagerContinuationAuthority([old, claim(oldAuthority), current]);

  assert.equal(continuation.allowed, true);
  assert.equal(continuation.alreadyClaimed, false);
  assert.equal(continuation.authority.revision, 'AR240.2');
});

test('runner-start for a different authority does not mark the current packet claimed', () => {
  const other = parseManagerPreflightPacket(packet({ revision: 'AR240.0', fingerprint: FINGERPRINT_B }));
  const current = packet({ id: 3, revision: 'AR240.2', fingerprint: FINGERPRINT_A });
  const continuation = resolveManagerContinuationAuthority([claim(other), current]);

  assert.equal(continuation.allowed, true);
  assert.equal(continuation.alreadyClaimed, false);
  assert.equal(continuation.authority.revision, 'AR240.2');
});
