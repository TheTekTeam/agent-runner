import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_PROMPT_CACHE_DISABLE_VARIABLES,
  assertClaudePromptCacheEnabled,
  claudeModelFamily,
  inspectClaudePromptCachePolicy,
} from './claude-runner-cache-policy.mjs';

test('model family detection covers aliases and exact model identities', () => {
  assert.equal(claudeModelFamily('sonnet'), 'sonnet');
  assert.equal(claudeModelFamily('claude-sonnet-4-6'), 'sonnet');
  assert.equal(claudeModelFamily('claude-opus-5'), 'opus');
  assert.equal(claudeModelFamily('HAIKU'), 'haiku');
  assert.equal(claudeModelFamily('future-model'), null);
});

test('normal Claude execution reports prompt caching enabled without exposing environment data', () => {
  assert.deepEqual(inspectClaudePromptCachePolicy({ model: 'sonnet', env: { UNRELATED_SECRET: 'do-not-return' } }), {
    enabled: true,
    state: 'enabled',
    reason: null,
    modelFamily: 'sonnet',
    disableVariable: null,
  });
});

test('global cache disable wins for every model and uses bounded diagnostics', () => {
  for (const model of ['haiku', 'sonnet', 'opus', 'future-model']) {
    const result = inspectClaudePromptCachePolicy({ model, env: { DISABLE_PROMPT_CACHING: 'yes' } });
    assert.equal(result.enabled, false);
    assert.equal(result.reason, 'global-disable');
    assert.equal(result.disableVariable, 'DISABLE_PROMPT_CACHING');
    assert.equal(Object.hasOwn(result, 'environment'), false);
  }
});

test('model-specific cache disable applies only to the selected family', () => {
  const env = { DISABLE_PROMPT_CACHING_SONNET: '1' };
  assert.equal(inspectClaudePromptCachePolicy({ model: 'sonnet', env }).enabled, false);
  assert.equal(inspectClaudePromptCachePolicy({ model: 'claude-sonnet-4-6', env }).enabled, false);
  assert.equal(inspectClaudePromptCachePolicy({ model: 'haiku', env }).enabled, true);
  assert.equal(inspectClaudePromptCachePolicy({ model: 'opus', env }).enabled, true);
});

test('false-like cache controls do not disable caching', () => {
  for (const value of ['', '0', 'false', 'off', 'no']) {
    assert.equal(inspectClaudePromptCachePolicy({
      model: 'sonnet',
      env: { DISABLE_PROMPT_CACHING: value, DISABLE_PROMPT_CACHING_SONNET: value },
    }).enabled, true);
  }
});

test('unknown model families only honor the global disable switch', () => {
  const result = inspectClaudePromptCachePolicy({
    model: 'future-model',
    env: {
      DISABLE_PROMPT_CACHING_HAIKU: '1',
      DISABLE_PROMPT_CACHING_SONNET: '1',
      DISABLE_PROMPT_CACHING_OPUS: '1',
    },
  });
  assert.equal(result.enabled, true);
  assert.equal(result.modelFamily, null);
});

test('cache-disabled execution fails closed unless an explicit non-default diagnostic override is supplied', () => {
  assert.throws(
    () => assertClaudePromptCacheEnabled({ model: 'opus', env: { DISABLE_PROMPT_CACHING_OPUS: 'true' } }),
    (error) => error?.code === 'claude-prompt-cache-disabled'
      && error?.cachePolicy?.disableVariable === 'DISABLE_PROMPT_CACHING_OPUS',
  );
  assert.equal(assertClaudePromptCacheEnabled({
    model: 'opus',
    env: { DISABLE_PROMPT_CACHING_OPUS: 'true' },
    allowDisabled: true,
  }).enabled, false);
});

test('the policy inspects exactly the documented cache-disable variables', () => {
  assert.deepEqual(CLAUDE_PROMPT_CACHE_DISABLE_VARIABLES, [
    'DISABLE_PROMPT_CACHING',
    'DISABLE_PROMPT_CACHING_HAIKU',
    'DISABLE_PROMPT_CACHING_SONNET',
    'DISABLE_PROMPT_CACHING_OPUS',
  ]);
});
