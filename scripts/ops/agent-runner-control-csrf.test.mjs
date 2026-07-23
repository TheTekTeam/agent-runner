import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCsrfToken, validateOrigin } from './agent-runner-control-csrf.mjs';

test('validateCsrfToken rejects a missing header token', () => {
  assert.equal(validateCsrfToken({ sessionCsrfToken: 'abc' }).ok, false);
});

test('validateCsrfToken rejects a missing session token', () => {
  assert.equal(validateCsrfToken({ headerToken: 'abc' }).ok, false);
});

test('validateCsrfToken rejects a mismatched token', () => {
  const result = validateCsrfToken({ headerToken: 'abc', sessionCsrfToken: 'def' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'csrf-token-mismatch');
});

test('validateCsrfToken accepts a matching token', () => {
  assert.equal(validateCsrfToken({ headerToken: 'same-token', sessionCsrfToken: 'same-token' }).ok, true);
});

test('validateOrigin fails closed when Origin and Referer are both absent', () => {
  const result = validateOrigin({ allowedOrigins: ['http://127.0.0.1:4321'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin-missing');
});

test('validateOrigin rejects an Origin not in the allowlist — no LAN/public origin ever passes', () => {
  const result = validateOrigin({ originHeader: 'http://192.168.1.50:4321', allowedOrigins: ['http://127.0.0.1:4321'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin-not-allowed');
});

test('validateOrigin accepts an exact loopback origin match', () => {
  assert.equal(validateOrigin({ originHeader: 'http://127.0.0.1:4321', allowedOrigins: ['http://127.0.0.1:4321'] }).ok, true);
});

test('validateOrigin falls back to the Referer origin only when Origin is absent', () => {
  const result = validateOrigin({ refererHeader: 'http://127.0.0.1:4321/some/page', allowedOrigins: ['http://127.0.0.1:4321'] });
  assert.equal(result.ok, true);
});

test('validateOrigin ignores a malformed Referer rather than throwing', () => {
  const result = validateOrigin({ refererHeader: 'not a url', allowedOrigins: ['http://127.0.0.1:4321'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin-missing');
});
