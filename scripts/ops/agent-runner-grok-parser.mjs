import { FAILURE_SCOPES, normalizedAdapterResult } from './agent-runner-adapter-contract.mjs';
import { normalizeUsageEfficiencyEnvelope } from './agent-runner-usage-telemetry.mjs';

/**
 * Bounded structured-output parsing for `grok -p <prompt> --format json`
 * (issue #49).
 *
 * `grok --help` documents `--format <format>` (`text` or `json`) but does
 * not document the JSON payload's field shape, and no live, authenticated
 * headless run has been performed to capture one — doing so is out of scope
 * for this foundation. This module therefore retains its historical assumed
 * result shape for compatibility tests, but #194 MUST NOT elevate those
 * assumed usage fields into canonical efficiency evidence until verified.
 * Every function here is pure: none spawn a process or make a model call.
 *
 * Sink-safety contract: raw stdout, provider error text, prompt content,
 * session/credential material, and arbitrary process-wrapper values are
 * classification inputs only and are never returned on failure paths.
 */

const AUTH_FAILURE_PATTERN = /not logged in|log in|authentication|unauthoriz|401|invalid api key/i;
const QUOTA_FAILURE_PATTERN = /quota|rate.?limit|429|insufficient (credit|balance)/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Historical assumed usage envelope. Canonical #194 efficiency remains unavailable until verified. */
export function grokUsageEnvelope({ inputTokens = null, outputTokens = null } = {}) {
  return Object.freeze({
    provider: 'grok-cli',
    paid: true,
    costUsd: null,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
  });
}

function grokUnverifiedEfficiency() {
  return normalizeUsageEfficiencyEnvelope({
    provider: 'grok-cli',
    adapter: 'grok-cli',
    costPosture: 'separately-metered',
    paid: true,
    telemetryAvailability: 'unavailable',
    availabilityReason: 'structured-usage-unverified',
    cacheStrategy: 'unknown',
  });
}

function classifyFailureMessage(message) {
  const text = String(message || '');
  if (AUTH_FAILURE_PATTERN.test(text)) return 'grok-auth-failed';
  if (QUOTA_FAILURE_PATTERN.test(text)) return 'grok-quota-exceeded';
  return 'grok-run-failed';
}

function extractUsage(payload) {
  const usage = isPlainObject(payload?.usage) ? payload.usage : null;
  return grokUsageEnvelope({
    inputTokens: usage ? Number(usage.inputTokens) : null,
    outputTokens: usage ? Number(usage.outputTokens) : null,
  });
}

export function parseGrokResultEnvelope(stdout = '', { agentId = 'grok-cli' } = {}) {
  const text = String(stdout || '').trim();
  if (!text) {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'grok-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: '',
      structuredFailure: 'grok-invalid-output',
      usage: grokUsageEnvelope({}),
      usageEfficiency: grokUnverifiedEfficiency(),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'grok-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: '',
      structuredFailure: 'grok-invalid-output',
      usage: grokUsageEnvelope({}),
      usageEfficiency: grokUnverifiedEfficiency(),
    });
  }

  if (!isPlainObject(parsed) || (parsed.status !== 'success' && parsed.status !== 'error')) {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'grok-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: '',
      structuredFailure: 'grok-invalid-output',
      usage: grokUsageEnvelope({}),
      usageEfficiency: grokUnverifiedEfficiency(),
    });
  }

  if (parsed.status === 'success') {
    const mutated = Boolean(parsed.mutated);
    return normalizedAdapterResult({
      ok: true,
      agentId,
      resultText: String(parsed.message || ''),
      reason: mutated ? null : 'no-op',
      mutatedRepository: mutated,
      usage: extractUsage(parsed),
      usageEfficiency: grokUnverifiedEfficiency(),
    });
  }

  const errorMessage = String(parsed?.error?.message || '');
  return normalizedAdapterResult({
    ok: false,
    agentId,
    reason: classifyFailureMessage(errorMessage),
    failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
    resultText: '',
    structuredFailure: 'grok-run-failed',
    usage: grokUsageEnvelope({}),
    usageEfficiency: grokUnverifiedEfficiency(),
  });
}

/**
 * Classify a process-level execution outcome that never produced parseable
 * Grok output. Branch selection is driven entirely by the bounded booleans;
 * arbitrary message/signal/code values never enter the returned result.
 */
export function classifyGrokExecutionError({ timedOut = false, cancelled = false, signal = null, code = null, message = '' } = {}) {
  void signal;
  void code;
  void message;
  const common = {
    ok: false,
    failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
    resultText: '',
    usage: grokUsageEnvelope({}),
    usageEfficiency: grokUnverifiedEfficiency(),
  };
  if (cancelled) {
    return normalizedAdapterResult({ ...common, reason: 'grok-cancelled', structuredFailure: 'grok-cancelled' });
  }
  if (timedOut) {
    return normalizedAdapterResult({ ...common, reason: 'grok-timeout', structuredFailure: 'grok-timeout' });
  }
  return normalizedAdapterResult({ ...common, reason: 'grok-execution-error', structuredFailure: 'grok-execution-error' });
}
