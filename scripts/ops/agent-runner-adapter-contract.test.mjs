import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAILURE_SCOPES,
  foldProbeOutcomes,
  normalizedAdapterResult,
  probeOutcome,
  zeroSpendEnvelope,
} from './agent-runner-adapter-contract.mjs';

test('zeroSpendEnvelope always reports a concrete zero cost, never null/omitted', () => {
  const usage = zeroSpendEnvelope();
  assert.equal(usage.paid, false);
  assert.equal(usage.costUsd, 0);
  assert.equal(Object.hasOwn(usage, 'costUsd'), true);
});

test('zeroSpendEnvelope accepts a provider label override', () => {
  assert.equal(zeroSpendEnvelope({ provider: 'ollama-agent' }).provider, 'ollama-agent');
});

test('normalizedAdapterResult defaults a successful result to a zero-spend envelope and no failure scope', () => {
  const result = normalizedAdapterResult({ ok: true, agentId: 'ollama-agent', resultText: 'done' });
  assert.equal(result.ok, true);
  assert.equal(result.failureScope, null);
  assert.equal(result.usage.costUsd, 0);
  assert.equal(result.usageEfficiency.costPosture, 'free-local');
  assert.equal(result.usageEfficiency.telemetryAvailability, 'unavailable');
  assert.equal(result.usageEfficiency.inputTokens, null);
  assert.equal(result.mutatedRepository, false);
  assert.equal(result.mutatedGitHub, false);
});

test('#194: normalizedAdapterResult preserves legacy usage while projecting bounded efficiency evidence', () => {
  const usage = { provider: 'metered-example', paid: true, costUsd: 1.25, inputTokens: 100, outputTokens: 10, raw: 'do-not-copy' };
  const result = normalizedAdapterResult({ ok: true, agentId: 'example-cli', usage });
  assert.equal(result.usage, usage);
  assert.equal(result.usageEfficiency.provider, 'metered-example');
  assert.equal(result.usageEfficiency.adapter, 'example-cli');
  assert.equal(result.usageEfficiency.costPosture, 'separately-metered');
  assert.equal(result.usageEfficiency.costUsd, 1.25);
  assert.equal(result.usageEfficiency.inputTokens, 100);
  assert.equal(result.usageEfficiency.outputTokens, 10);
  assert.equal(JSON.stringify(result.usageEfficiency).includes('do-not-copy'), false);
});

test('#194: an explicit provider-normalized efficiency projection is retained verbatim', () => {
  const usageEfficiency = Object.freeze({ schemaVersion: 'custom-test', marker: true });
  const result = normalizedAdapterResult({ ok: true, usageEfficiency });
  assert.equal(result.usageEfficiency, usageEfficiency);
});

test('normalizedAdapterResult defaults a failure to machine_profile scope when none is supplied', () => {
  const result = normalizedAdapterResult({ ok: false, agentId: 'ollama-agent', reason: 'ollama-endpoint-unavailable' });
  assert.equal(result.ok, false);
  assert.equal(result.failureScope, FAILURE_SCOPES.MACHINE_PROFILE);
  assert.equal(result.reason, 'ollama-endpoint-unavailable');
});

test('normalizedAdapterResult preserves an explicit non-machine-profile failure scope', () => {
  const result = normalizedAdapterResult({ ok: false, failureScope: FAILURE_SCOPES.TASK_ATTEMPT, reason: 'timeout' });
  assert.equal(result.failureScope, FAILURE_SCOPES.TASK_ATTEMPT);
});

test('probeOutcome requires a probe name', () => {
  assert.throws(() => probeOutcome({ ok: true }), /probe name/);
});

test('probeOutcome success carries no failure scope or reason', () => {
  const outcome = probeOutcome({ probe: 'executable', ok: true });
  assert.deepEqual(outcome, { probe: 'executable', ok: true, reason: null, detail: null, failureScope: null });
});

test('probeOutcome failure defaults reason and failure scope', () => {
  const outcome = probeOutcome({ probe: 'endpoint', ok: false });
  assert.equal(outcome.reason, 'endpoint-unavailable');
  assert.equal(outcome.failureScope, FAILURE_SCOPES.MACHINE_PROFILE);
});

test('foldProbeOutcomes reports the first failing probe and stops there', () => {
  const decision = foldProbeOutcomes([
    probeOutcome({ probe: 'executable', ok: true }),
    probeOutcome({ probe: 'endpoint', ok: false, reason: 'ollama-endpoint-unavailable', detail: 'connect ECONNREFUSED' }),
    probeOutcome({ probe: 'installed-model', ok: false, reason: 'ollama-model-unavailable' }),
  ]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.failedProbe, 'endpoint');
  assert.equal(decision.reason, 'ollama-endpoint-unavailable');
  assert.equal(decision.detail, 'connect ECONNREFUSED');
  assert.equal(decision.scope, FAILURE_SCOPES.MACHINE_PROFILE);
});

test('foldProbeOutcomes admits when every probe passes', () => {
  const decision = foldProbeOutcomes([
    probeOutcome({ probe: 'executable', ok: true }),
    probeOutcome({ probe: 'version', ok: true }),
  ]);
  assert.equal(decision.allowed, true);
  assert.equal(decision.scope, null);
  assert.equal(decision.failedProbe, null);
});

test('foldProbeOutcomes with zero probes admits (vacuous truth) rather than failing closed silently', () => {
  const decision = foldProbeOutcomes([]);
  assert.equal(decision.allowed, true);
});

test('foldProbeOutcomes honours a custom safeNextAction message', () => {
  const decision = foldProbeOutcomes([
    probeOutcome({ probe: 'host-headroom', ok: false }),
  ], { safeNextAction: 'Free memory before retrying.' });
  assert.equal(decision.safeNextAction, 'Free memory before retrying.');
});
