import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildSessionClearCookie,
  buildSessionCookie,
  createControlSessionStore,
  parseSessionCookie,
  resolveOperatorCredentialPath,
  setOperatorCredential,
  verifyOperatorCredential,
} from './agent-runner-control-auth.mjs';

// A low-cost scrypt override keeps these tests fast without weakening the
// production default (SCRYPT_PARAMS in the module under test is untouched).
const FAST_DEPS = { scryptFn: (password, salt) => Buffer.concat([Buffer.from(String(password)), salt]).subarray(0, 32) };

function withTempCredentialPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-control-auth-'));
  try {
    return fn(join(dir, 'nested', 'control-operator.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveOperatorCredentialPath defaults under the XDG state path', () => {
  const path = resolveOperatorCredentialPath({ HOME: '/home/example' });
  assert.equal(path, '/home/example/.local/state/agent-runner/control-operator.json');
});

test('setOperatorCredential rejects a short password', () => withTempCredentialPath((path) => {
  assert.throws(() => setOperatorCredential({ username: 'op', password: 'short', path, deps: FAST_DEPS }), /12 characters/);
}));

test('setOperatorCredential never persists the plaintext password, and the file is mode 0600', () => withTempCredentialPath((path) => {
  const secretPassword = 'unit-test-operator-password-value';
  setOperatorCredential({ username: 'operator', password: secretPassword, path, deps: FAST_DEPS });
  const stats = statSync(path);
  assert.equal(stats.mode & 0o777, 0o600);
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes(secretPassword));
  const record = JSON.parse(raw);
  assert.deepEqual(Object.keys(record).sort(), ['algorithm', 'hash', 'salt', 'schemaVersion', 'updatedAt', 'username']);
}));

test('verifyOperatorCredential reports operator-not-configured before any credential is set', () => withTempCredentialPath((path) => {
  const result = verifyOperatorCredential({ username: 'operator', password: 'unit-test-operator-password-value', path, deps: FAST_DEPS });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operator-not-configured');
}));

test('verifyOperatorCredential accepts the matching username/password and rejects a wrong one', () => withTempCredentialPath((path) => {
  setOperatorCredential({ username: 'operator', password: 'unit-test-operator-password-value', path, deps: FAST_DEPS });
  const good = verifyOperatorCredential({ username: 'operator', password: 'unit-test-operator-password-value', path, deps: FAST_DEPS });
  assert.equal(good.ok, true);
  assert.equal(good.username, 'operator');

  const badPassword = verifyOperatorCredential({ username: 'operator', password: 'wrong-password-value-here', path, deps: FAST_DEPS });
  assert.equal(badPassword.ok, false);
  assert.equal(badPassword.reason, 'operator-credentials-invalid');

  const badUsername = verifyOperatorCredential({ username: 'someone-else', password: 'unit-test-operator-password-value', path, deps: FAST_DEPS });
  assert.equal(badUsername.ok, false);
}));

test('verifyOperatorCredential fails closed on a corrupt credential file', () => withTempCredentialPath((path) => {
  const deps = { ...FAST_DEPS, existsFn: () => true, readFn: () => 'not json' };
  const result = verifyOperatorCredential({ username: 'operator', password: 'unit-test-operator-password-value', path, deps });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operator-credential-corrupt');
}));

test('createControlSessionStore issues a session with a distinct csrfToken and expires it after ttlMs', () => {
  let clockMs = 1000;
  const store = createControlSessionStore({ ttlMs: 500, now: () => clockMs });
  const session = store.create('operator');
  assert.ok(session.id);
  assert.ok(session.csrfToken);
  assert.notEqual(session.id, session.csrfToken);
  assert.equal(store.get(session.id).id, session.id);

  clockMs += 600;
  assert.equal(store.get(session.id), null);
});

test('createControlSessionStore.destroy immediately invalidates a session', () => {
  const store = createControlSessionStore({ now: () => 0 });
  const session = store.create('operator');
  store.destroy(session.id);
  assert.equal(store.get(session.id), null);
});

test('session cookie helpers round-trip and are HttpOnly/SameSite=Strict — never accessible to page JS', () => {
  const cookie = buildSessionCookie('abc123', { maxAgeSeconds: 60 });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(parseSessionCookie(cookie), 'abc123');
  assert.equal(parseSessionCookie(`other=1; ${cookie}`), 'abc123');
  assert.equal(parseSessionCookie('unrelated=value'), null);
  assert.match(buildSessionClearCookie(), /Max-Age=0/);
});
