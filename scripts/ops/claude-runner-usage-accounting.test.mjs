import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeUsageAccounting,
  sanitizeClaudeStructuredUsage,
} from './agent-runner-usage-telemetry.mjs';

const FP = `sha256:${'b'.repeat(64)}`;

test('#194: Claude usage sanitizer preserves aggregate and TTL counts but drops arbitrary provider/session fields', () => {
  const usage = sanitizeClaudeStructuredUsage({
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30,
    cache_creation: {
      ephemeral_5m_input_tokens: 11,
      ephemeral_1h_input_tokens: 19,
      raw: 'should-not-survive',
    },
    session_id: 'restricted-session-id',
    prompt: 'restricted prompt',
    provider_blob: { secret: true },
  });

  assert.deepEqual(usage, {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadInputTokens: 20,
    cacheCreationInputTokens: 30,
    cacheCreationByTtl: {
      ephemeral_5m_input_tokens: 11,
      ephemeral_1h_input_tokens: 19,
    },
  });
  const serialized = JSON.stringify(usage);
  assert.equal(serialized.includes('restricted-session-id'), false);
  assert.equal(serialized.includes('restricted prompt'), false);
  assert.equal(serialized.includes('should-not-survive'), false);
});

test('#194: Claude usage sanitizer leaves absent TTL detail absent and null metrics unknown', () => {
  const usage = sanitizeClaudeStructuredUsage({
    input_tokens: null,
    output_tokens: 0,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  });
  assert.deepEqual(usage, {
    inputTokens: null,
    outputTokens: 0,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
  });
});

test('#194: Claude usage accounting preserves legacy fields and adds bounded included-subscription efficiency', () => {
  const accounting = buildClaudeUsageAccounting({
    resultEnvelope: {
      parsed: true,
      accountingAvailable: true,
      subtype: 'success',
      isError: false,
      numTurns: 3,
      totalCostUsd: 1.25,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheCreationByTtl: {
          ephemeral_5m_input_tokens: 11,
          ephemeral_1h_input_tokens: 19,
        },
      },
      modelUsage: { sonnet: { inputTokens: 10 } },
      hasSessionId: true,
      resultText: 'must-not-be-copied',
      rawProviderRecord: 'must-not-be-copied-either',
    },
    model: 'sonnet',
    promptCacheMetadata: {
      cacheStrategy: 'provider-managed',
      stablePrefixFingerprint: FP,
    },
    startedAt: '2026-08-22T20:00:00.000Z',
    finishedAt: '2026-08-22T20:00:02.500Z',
  });

  assert.equal(accounting.source, 'claude-cli-result-envelope');
  assert.equal(accounting.numTurns, 3);
  assert.equal(accounting.totalCostUsd, 1.25);
  assert.equal(accounting.sessionIdPresentButNotStored, true);
  assert.equal(accounting.efficiency.provider, 'claude-code');
  assert.equal(accounting.efficiency.adapter, 'claude-code-cli');
  assert.equal(accounting.efficiency.model, 'sonnet');
  assert.equal(accounting.efficiency.costPosture, 'included-subscription');
  assert.equal(accounting.efficiency.paid, false);
  assert.equal(accounting.efficiency.costUsd, null);
  assert.equal(accounting.efficiency.inputTokens, 60);
  assert.equal(accounting.efficiency.uncachedInputTokens, 10);
  assert.equal(accounting.efficiency.cacheReadTokens, 20);
  assert.equal(accounting.efficiency.cacheCreationTokens, 30);
  assert.equal(accounting.efficiency.cacheCreation5mTokens, 11);
  assert.equal(accounting.efficiency.cacheCreation1hTokens, 19);
  assert.equal(accounting.efficiency.totalDurationMs, 2500);
  assert.equal(accounting.efficiency.stablePrefixFingerprint, FP);
  const serialized = JSON.stringify(accounting);
  assert.equal(serialized.includes('must-not-be-copied'), false);
});

test('#194: malformed or reversed timestamps do not fabricate duration', () => {
  const accounting = buildClaudeUsageAccounting({
    resultEnvelope: { parsed: true, accountingAvailable: false, usage: null },
    startedAt: '2026-08-22T20:00:10.000Z',
    finishedAt: '2026-08-22T20:00:00.000Z',
  });
  assert.equal(accounting.efficiency.totalDurationMs, null);
  assert.equal(accounting.efficiency.telemetryAvailability, 'unavailable');
});
