import assert from 'node:assert/strict';
import test from 'node:test';

import {
  USAGE_EFFICIENCY_SCHEMA_VERSION,
  normalizeClaudeUsageEfficiency,
  normalizeCodexUsageEfficiency,
  normalizeOllamaUsageEfficiency,
  normalizeUsageEfficiencyEnvelope,
} from './agent-runner-usage-telemetry.mjs';

const FP = `sha256:${'a'.repeat(64)}`;

test('#194: generic telemetry preserves genuine zero and leaves unsupported evidence null', () => {
  const result = normalizeUsageEfficiencyEnvelope({
    provider: 'example',
    adapter: 'example-cli',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costPosture: 'included-subscription',
    cacheStrategy: 'unknown',
  });

  assert.equal(result.schemaVersion, USAGE_EFFICIENCY_SCHEMA_VERSION);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
  assert.equal(result.cacheReadTokens, 0);
  assert.equal(result.cacheCreationTokens, 0);
  assert.equal(result.reasoningTokens, null);
  assert.equal(result.costUsd, null);
  assert.equal(result.paid, false);
});

test('#194: malformed negative or unbounded numeric values normalize to unknown', () => {
  const result = normalizeUsageEfficiencyEnvelope({
    provider: 'example',
    inputTokens: -1,
    outputTokens: Number.POSITIVE_INFINITY,
    reasoningTokens: 10 ** 13,
    promptEvalDurationMs: -5,
  });

  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
  assert.equal(result.reasoningTokens, null);
  assert.equal(result.promptEvalDurationMs, null);
  assert.equal(result.telemetryAvailability, 'unavailable');
});

test('#194: Claude aggregate and current Anthropic TTL cache evidence normalizes without session/raw fields', () => {
  const result = normalizeClaudeUsageEfficiency({
    model: 'sonnet',
    promptCacheMetadata: { cacheStrategy: 'provider-managed', stablePrefixFingerprint: FP },
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 300,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 100,
      },
      session_id: 'restricted-session',
      prompt: 'secret prompt',
      rawProviderRecord: 'do not serialize',
    },
  });

  assert.equal(result.inputTokens, 1000);
  assert.equal(result.uncachedInputTokens, 100);
  assert.equal(result.outputTokens, 25);
  assert.equal(result.cacheReadTokens, 600);
  assert.equal(result.cacheCreationTokens, 300);
  assert.equal(result.cacheCreation5mTokens, 200);
  assert.equal(result.cacheCreation1hTokens, 100);
  assert.equal(result.stablePrefixFingerprint, FP);
  assert.equal(result.costPosture, 'included-subscription');
  assert.equal(result.paid, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('restricted-session'), false);
  assert.equal(serialized.includes('secret prompt'), false);
  assert.equal(serialized.includes('rawProviderRecord'), false);
});

test('#194: Claude absent TTL detail stays null rather than becoming zero', () => {
  const result = normalizeClaudeUsageEfficiency({
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    },
  });
  assert.equal(result.cacheCreation5mTokens, null);
  assert.equal(result.cacheCreation1hTokens, null);
});

test('#194: Codex/OpenAI cached and reasoning fields map only when structurally supplied', () => {
  const result = normalizeCodexUsageEfficiency({
    model: 'gpt-example',
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cached_tokens: 600,
      output_tokens_details: { reasoning_tokens: 40 },
    },
  });

  assert.equal(result.inputTokens, 1000);
  assert.equal(result.uncachedInputTokens, 400);
  assert.equal(result.cacheReadTokens, 600);
  assert.equal(result.reasoningTokens, 40);
  assert.equal(result.cacheCreationTokens, null);
  assert.equal(result.costPosture, 'included-subscription');
  assert.equal(result.paid, false);
});

test('#194: Ollama maps structured local prompt-eval/load nanoseconds without paid-token semantics', () => {
  const result = normalizeOllamaUsageEfficiency({
    model: 'qwen-example',
    usage: {
      prompt_eval_count: 50,
      prompt_eval_duration: 2_000_000_000,
      load_duration: 500_000_000,
      total_duration: 4_000_000_000,
      eval_count: 20,
    },
  });

  assert.equal(result.promptEvalTokens, 50);
  assert.equal(result.promptEvalDurationMs, 2000);
  assert.equal(result.modelLoadDurationMs, 500);
  assert.equal(result.totalDurationMs, 4000);
  assert.equal(result.outputTokens, 20);
  assert.equal(result.adapter, 'ollama-agent');
  assert.equal(result.promptEvalTokensPerSecond, 25);
  assert.equal(result.costPosture, 'free-local');
  assert.equal(result.paid, false);
  assert.equal(result.costUsd, 0);
});

test('#194: derived ratios require known positive denominators', () => {
  const unknown = normalizeUsageEfficiencyEnvelope({ cacheReadTokens: 5 });
  assert.equal(unknown.cacheReadShare, null);

  const known = normalizeUsageEfficiencyEnvelope({ inputTokens: 100, cacheReadTokens: 25, cacheCreationTokens: 10 });
  assert.equal(known.cacheReadShare, 0.25);
  assert.equal(known.cacheWriteShare, 0.1);
});

test('#194: invalid identifiers, fingerprints and free-form availability text are not serialized', () => {
  const result = normalizeUsageEfficiencyEnvelope({
    provider: '../../secret',
    adapter: 'valid-adapter',
    model: 'model with spaces',
    stablePrefixFingerprint: 'not-a-fingerprint',
    availabilityReason: 'raw provider error with secret text',
  });
  assert.equal(result.provider, null);
  assert.equal(result.adapter, 'valid-adapter');
  assert.equal(result.model, null);
  assert.equal(result.stablePrefixFingerprint, null);
  assert.equal(result.availabilityReason, null);
});
