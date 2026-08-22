import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGrokResultEnvelope } from './agent-runner-grok-parser.mjs';

test('#194: Grok assumed usage fields do not become canonical efficiency evidence before verification', () => {
  const result = parseGrokResultEnvelope(JSON.stringify({
    status: 'success',
    message: 'fixture only',
    mutated: false,
    usage: { inputTokens: 123, outputTokens: 45 },
  }));

  // Historical foundation shape remains readable for compatibility.
  assert.equal(result.usage.inputTokens, 123);
  assert.equal(result.usage.outputTokens, 45);

  // Canonical efficiency evidence fails closed until the real structured
  // contract has been positively verified.
  assert.equal(result.usageEfficiency.telemetryAvailability, 'unavailable');
  assert.equal(result.usageEfficiency.availabilityReason, 'structured-usage-unverified');
  assert.equal(result.usageEfficiency.inputTokens, null);
  assert.equal(result.usageEfficiency.outputTokens, null);
  assert.equal(result.usageEfficiency.cacheReadTokens, null);
  assert.equal(result.usageEfficiency.reasoningTokens, null);
});
