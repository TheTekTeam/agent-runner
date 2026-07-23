import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSecretReference,
  isOpaqueSecretReference,
  parseSecretReference,
} from './agent-runner-secret-reference.mjs';

test('buildSecretReference produces an opaque secretref: token', () => {
  assert.equal(buildSecretReference('codex-token'), 'secretref:codex-token');
});

test('buildSecretReference rejects an invalid underlying id', () => {
  assert.throws(() => buildSecretReference('../etc/passwd'), (error) => error.code === 'AGENT_RUNNER_SECRET_INVALID_ID');
});

test('parseSecretReference round-trips a well-formed reference', () => {
  const parsed = parseSecretReference('secretref:codex-token');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.id, 'codex-token');
});

test('parseSecretReference fails closed on a malformed reference (no prefix)', () => {
  assert.equal(parseSecretReference('codex-token').ok, false);
});

test('parseSecretReference fails closed on path traversal disguised as an id', () => {
  assert.equal(parseSecretReference('secretref:../etc/passwd').ok, false);
});

test('parseSecretReference fails closed on an absolute path payload', () => {
  assert.equal(parseSecretReference('secretref:/etc/passwd').ok, false);
});

test('parseSecretReference fails closed on embedded whitespace/newlines', () => {
  assert.equal(parseSecretReference('secretref:codex token').ok, false);
  assert.equal(parseSecretReference('secretref:codex-token\nrm -rf /').ok, false);
});

test('parseSecretReference fails closed on extra colons or trailing garbage', () => {
  assert.equal(parseSecretReference('secretref:codex-token:extra').ok, false);
  assert.equal(parseSecretReference('secretref:codex-token ').ok, false);
});

test('parseSecretReference fails closed on non-string input', () => {
  assert.equal(parseSecretReference(null).ok, false);
  assert.equal(parseSecretReference(42).ok, false);
  assert.equal(parseSecretReference(undefined).ok, false);
});

test('isOpaqueSecretReference is a boolean convenience wrapper for settings validation', () => {
  assert.equal(isOpaqueSecretReference('secretref:codex-token'), true);
  assert.equal(isOpaqueSecretReference('plain-value-not-a-reference'), false);
  assert.equal(isOpaqueSecretReference('not-opaque-raw-looking-value'), false);
});
