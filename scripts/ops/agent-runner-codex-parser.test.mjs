import assert from 'node:assert/strict';
import test from 'node:test';

import { FAILURE_SCOPES } from './agent-runner-adapter-contract.mjs';
import {
  classifyCodexExecutionError,
  codexUsageEnvelope,
  parseCodexEventLines,
  parseCodexResultEnvelope,
} from './agent-runner-codex-parser.mjs';

function jsonl(events) {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

// --- invalid / malformed output --------------------------------------------

test('invalid output: empty stdout fails closed', () => {
  const result = parseCodexResultEnvelope('');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-invalid-output');
  assert.equal(result.failureScope, FAILURE_SCOPES.TASK_ATTEMPT);
});

test('invalid output: non-JSON stdout fails closed', () => {
  const result = parseCodexResultEnvelope('not json at all');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-invalid-output');
});

test('invalid output: a line missing a string type field fails the whole parse closed', () => {
  const result = parseCodexResultEnvelope(jsonl([{ type: 'thread.started' }, { foo: 'bar' }]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-invalid-output');
});

test('invalid output: a stream with no terminal event fails closed', () => {
  const result = parseCodexResultEnvelope(jsonl([{ type: 'thread.started' }, { type: 'turn.started' }]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-invalid-output');
});

test('parseCodexEventLines rejects one bad line among otherwise-good ones, not a partial parse', () => {
  const parsed = parseCodexEventLines(`${JSON.stringify({ type: 'thread.started' })}\nnot json\n`);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.events, []);
});

// --- no-op ------------------------------------------------------------------

test('no-op: turn.completed with no file_change item is a success with no repository mutation', () => {
  const result = parseCodexResultEnvelope(jsonl([
    { type: 'thread.started' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Nothing needed changing.' } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } },
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'no-op');
  assert.equal(result.mutatedRepository, false);
  assert.equal(result.resultText, 'Nothing needed changing.');
  assert.equal(result.usage.paid, true);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.outputTokens, 20);
});

// --- success with mutation ---------------------------------------------------

test('a turn.completed with a file_change item records mutatedRepository true', () => {
  const result = parseCodexResultEnvelope(jsonl([
    { type: 'item.completed', item: { type: 'agent_message', text: 'Fixed the failing test.' } },
    { type: 'item.completed', item: { type: 'file_change', path: 'src/foo.js' } },
    { type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 150 } },
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.mutatedRepository, true);
  assert.equal(result.resultText, 'Fixed the failing test.');
});

// --- task failure --------------------------------------------------------------

test('turn.failed with a generic message is a typed task_attempt failure', () => {
  const result = parseCodexResultEnvelope(jsonl([
    { type: 'turn.failed', error: { message: 'the model produced a malformed patch' } },
  ]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-run-failed');
  assert.equal(result.failureScope, FAILURE_SCOPES.TASK_ATTEMPT);
  assert.equal(result.structuredFailure, 'the model produced a malformed patch');
});

// --- authentication failure -----------------------------------------------------

test('an authentication failure message classifies as codex-auth-failed', () => {
  const result = parseCodexResultEnvelope(jsonl([
    { type: 'turn.failed', error: { message: 'You are not logged in. Run `codex login` to authenticate.' } },
  ]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-auth-failed');
});

test('a top-level protocol error event with an unauthorized message also classifies as codex-auth-failed', () => {
  const result = parseCodexResultEnvelope(jsonl([
    { type: 'error', message: 'request failed: 401 unauthorized' },
  ]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-auth-failed');
});

// --- quota failure -----------------------------------------------------------

test('a quota/rate-limit failure message classifies as codex-quota-exceeded', () => {
  const result = parseCodexResultEnvelope(jsonl([
    { type: 'turn.failed', error: { message: 'rate limit exceeded, please retry later' } },
  ]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-quota-exceeded');
});

test('a 429 status message also classifies as codex-quota-exceeded', () => {
  const result = parseCodexResultEnvelope(jsonl([
    { type: 'error', message: 'HTTP 429 too many requests' },
  ]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-quota-exceeded');
});

// --- timeout / cancellation (process-level, not from stdout) -----------------

test('timeout is classified distinctly from an ordinary execution error', () => {
  const result = classifyCodexExecutionError({ timedOut: true, signal: 'SIGTERM' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-timeout');
  assert.equal(result.failureScope, FAILURE_SCOPES.TASK_ATTEMPT);
});

test('cancellation is classified distinctly from timeout and ordinary error', () => {
  const result = classifyCodexExecutionError({ cancelled: true, signal: 'SIGINT' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codex-cancelled');
});

test('an execution error that is neither timed out nor cancelled is classified generically', () => {
  const result = classifyCodexExecutionError({ code: 'ENOENT', message: 'spawn codex ENOENT' });
  assert.equal(result.reason, 'codex-execution-error');
  assert.equal(result.structuredFailure, 'ENOENT');
});

// --- usage envelope ------------------------------------------------------------

test('codexUsageEnvelope never invents a cost figure and passes through only finite token counts', () => {
  assert.deepEqual(codexUsageEnvelope({}), {
    provider: 'codex-cli',
    paid: true,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
  });
  assert.deepEqual(codexUsageEnvelope({ inputTokens: 10, outputTokens: 'not-a-number' }), {
    provider: 'codex-cli',
    paid: true,
    costUsd: null,
    inputTokens: 10,
    outputTokens: null,
  });
});
