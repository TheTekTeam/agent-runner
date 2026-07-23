import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PREFLIGHT_GENERATION_NEEDS_MANAGER,
  PREFLIGHT_GENERATION_RETIRED,
  buildGeneratedPreflightPacket,
  resolvePreflightAction,
} from './claude-runner-preflight.mjs';

test('local manager-preflight packet generation is technically retired', () => {
  assert.throws(() => buildGeneratedPreflightPacket(), new RegExp(PREFLIGHT_GENERATION_RETIRED));
});

test('a ready issue without manager authority fails closed to the manager', () => {
  assert.deepEqual(resolvePreflightAction({ issue: { number: 43, statusLabel: 'status:ready' } }), {
    action: 'blocked',
    reason: PREFLIGHT_GENERATION_NEEDS_MANAGER,
    detail: 'A current canonical manager packet must be authored by a normal ChatGPT manager session or ChatGPT scheduled task. The runner cannot generate or refresh manager authority.',
  });
});

test('non-ready compatibility calls remain no-op and cannot generate', () => {
  assert.deepEqual(resolvePreflightAction({ issue: { number: 43, statusLabel: 'status:blocked' } }), {
    action: 'noop',
    reason: PREFLIGHT_GENERATION_RETIRED,
    detail: 'automatic manager-preflight generation is retired',
  });
});
