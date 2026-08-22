import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCodexResultEnvelope } from './agent-runner-codex-parser.mjs';

function jsonl(events) {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

test('#194: explicit Codex null metrics remain unknown rather than becoming zero', () => {
  const result = parseCodexResultEnvelope(jsonl([{
    type: 'turn.completed',
    usage: {
      input_tokens: null,
      output_tokens: null,
      input_tokens_details: { cached_tokens: null },
      output_tokens_details: { reasoning_tokens: null },
    },
  }]));

  assert.equal(result.usage.inputTokens, null);
  assert.equal(result.usage.outputTokens, null);
  assert.equal(result.usageEfficiency.inputTokens, null);
  assert.equal(result.usageEfficiency.outputTokens, null);
  assert.equal(result.usageEfficiency.cacheReadTokens, null);
  assert.equal(result.usageEfficiency.reasoningTokens, null);
  assert.equal(result.usageEfficiency.telemetryAvailability, 'unavailable');
});
