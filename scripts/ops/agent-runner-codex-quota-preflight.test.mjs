import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyCodexLoginStatus,
  evaluateCodexRateLimits,
  sanitizeCodexEnvironment,
} from './agent-runner-codex-quota-preflight.mjs';

test('sanitizes API/token/base-url overrides while preserving unrelated machine-local environment', () => {
  const sanitized = sanitizeCodexEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/gp',
    OPENAI_API_KEY: 'synthetic-secret',
    CODEX_API_KEY: 'synthetic-secret',
    CODEX_ACCESS_TOKEN: 'synthetic-secret',
    OPENAI_BASE_URL: 'https://example.invalid',
  });

  assert.equal(sanitized.PATH, '/usr/bin');
  assert.equal(sanitized.HOME, '/home/gp');
  assert.equal('OPENAI_API_KEY' in sanitized, false);
  assert.equal('CODEX_API_KEY' in sanitized, false);
  assert.equal('CODEX_ACCESS_TOKEN' in sanitized, false);
  assert.equal('OPENAI_BASE_URL' in sanitized, false);
});

test('classifies ChatGPT login positively and rejects API/token login modes', () => {
  assert.deepEqual(
    classifyCodexLoginStatus('Logged in using ChatGPT', 0),
    { authenticated: true, mode: 'chatgpt', reason: null },
  );

  assert.equal(classifyCodexLoginStatus('Logged in using an API key - redacted', 0).authenticated, false);
  assert.equal(classifyCodexLoginStatus('Logged in using access token', 0).reason, 'codex-token-route-forbidden');
  assert.equal(classifyCodexLoginStatus('Not logged in', 0).reason, 'codex-not-logged-in');
});

test('current primary and secondary headroom below threshold admits without consulting credits', () => {
  const decision = evaluateCodexRateLimits({
    result: {
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 123 },
        secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 456 },
        credits: { hasCredits: true, unlimited: false, balance: '999.99' },
        rateLimitReachedType: null,
      },
      rateLimitResetCredits: { availableCount: 7 },
    },
  }, { maxUsedPercent: 90 });

  assert.equal(decision.blocked, false);
  assert.equal(decision.reason, null);
  assert.equal(decision.primary.remainingPercent, 88);
  assert.equal(decision.secondary.remainingPercent, 66);
  assert.equal(decision.planType, 'plus');
  assert.equal('credits' in decision, false);
  assert.equal('rateLimitResetCredits' in decision, false);
});

test('threshold exhaustion or explicit reached state fails closed', () => {
  assert.equal(evaluateCodexRateLimits({
    result: { rateLimits: {
      primary: { usedPercent: 91 },
      secondary: { usedPercent: 1 },
      rateLimitReachedType: null,
    } },
  }, { maxUsedPercent: 90 }).reason, 'codex-quota-threshold-exceeded');

  assert.equal(evaluateCodexRateLimits({
    result: { rateLimits: {
      primary: { usedPercent: 1 },
      secondary: { usedPercent: 1 },
      rateLimitReachedType: 'rate_limit_reached',
    } },
  }).reason, 'codex-quota-blocked');
});

test('missing or ambiguous windows fail closed rather than inferring availability', () => {
  assert.equal(evaluateCodexRateLimits({}).reason, 'codex-quota-evidence-unavailable');
  assert.equal(evaluateCodexRateLimits({
    result: { rateLimits: { primary: { usedPercent: 1 }, secondary: null } },
  }).reason, 'codex-quota-evidence-ambiguous');
});
