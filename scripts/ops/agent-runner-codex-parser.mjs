import { FAILURE_SCOPES, normalizedAdapterResult } from './agent-runner-adapter-contract.mjs';
import { normalizeCodexUsageEfficiency } from './agent-runner-usage-telemetry.mjs';

/**
 * Bounded structured-output parsing for `codex exec --json` (issue #48).
 *
 * `--json` prints one JSON object per stdout line ("JSONL"). This module
 * assumes Codex's public thread/turn event protocol (`thread.started`,
 * `turn.started`, `item.started`, `item.completed`, `turn.completed`,
 * `turn.failed`, `error`) — the same kind of documented-but-not-yet-live-
 * verified contract the #40 Ollama/OpenCode foundation used for its assumed
 * `{status, output, error, mutated}` JSON shape. It has not been checked
 * against a live captured Codex payload (that requires an authenticated
 * run, out of scope here — see docs/ops's "Known limitations"). Every
 * function here is a pure parser: none of them spawn a process or make a
 * network/model call.
 *
 * Sink-safety contract: raw stdout, provider error text, prompt content,
 * session/credential material, restricted handles, and arbitrary process-
 * wrapper messages are classification inputs only. They never enter the
 * returned normalized result. #194 additionally permits cache/reasoning
 * fields only when they are positively present in the structured terminal
 * usage object; it does not assume API-only fields exist in Codex CLI.
 */

const AUTH_FAILURE_PATTERN = /not logged in|log in|authentication|unauthoriz|401/i;
const QUOTA_FAILURE_PATTERN = /quota|rate.?limit|429|insufficient credit/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compatibility usage envelope for normal ChatGPT-auth Codex execution.
 * #184 defines this route as included-subscription (`paid:false`): token
 * counts are resource evidence, never proof of separately metered spend.
 */
export function codexUsageEnvelope({ inputTokens = null, outputTokens = null } = {}) {
  return Object.freeze({
    provider: 'codex-cli',
    paid: false,
    costUsd: null,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
  });
}

export function parseCodexEventLines(stdout = '') {
  const text = String(stdout || '');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, events: [], reason: 'codex-invalid-output' };

  const events = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, events: [], reason: 'codex-invalid-output' };
    }
    if (!isPlainObject(parsed) || typeof parsed.type !== 'string' || !parsed.type) {
      return { ok: false, events: [], reason: 'codex-invalid-output' };
    }
    events.push(parsed);
  }
  return { ok: true, events, reason: null };
}

function classifyFailureMessage(message) {
  const text = String(message || '');
  if (AUTH_FAILURE_PATTERN.test(text)) return 'codex-auth-failed';
  if (QUOTA_FAILURE_PATTERN.test(text)) return 'codex-quota-exceeded';
  return 'codex-run-failed';
}

function extractAgentMessageText(events) {
  const messageItems = events
    .filter((event) => event.type === 'item.completed' && isPlainObject(event.item) && event.item.type === 'agent_message')
    .map((event) => String(event.item.text || ''));
  return messageItems.join('\n').trim();
}

function extractFileChangeState(events) {
  const items = events
    .filter((event) => event.type === 'item.completed' && isPlainObject(event.item) && event.item.type === 'file_change')
    .map((event) => event.item);

  if (!items.length) {
    return Object.freeze({
      present: false,
      mutated: false,
      failed: false,
      ambiguous: false,
    });
  }

  let mutated = false;
  let failed = false;
  let ambiguous = false;

  for (const item of items) {
    const status = String(item.status || '').trim().toLowerCase();
    const changes = Array.isArray(item.changes) ? item.changes : null;

    if (status === 'failed') {
      failed = true;
      continue;
    }

    if (status !== 'completed' || !changes || changes.length === 0) {
      ambiguous = true;
      continue;
    }

    mutated = true;
  }

  return Object.freeze({
    present: true,
    mutated,
    failed,
    ambiguous,
  });
}

function finiteStructuredNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractStructuredUsage(event) {
  const usage = isPlainObject(event?.usage) ? event.usage : null;
  if (!usage) return null;
  const inputDetails = isPlainObject(usage.input_tokens_details) ? usage.input_tokens_details : null;
  const outputDetails = isPlainObject(usage.output_tokens_details) ? usage.output_tokens_details : null;
  return {
    input_tokens: finiteStructuredNumber(usage.input_tokens),
    output_tokens: finiteStructuredNumber(usage.output_tokens),
    cached_tokens: finiteStructuredNumber(usage.cached_tokens ?? inputDetails?.cached_tokens),
    cache_write_tokens: finiteStructuredNumber(usage.cache_write_tokens),
    reasoning_tokens: finiteStructuredNumber(usage.reasoning_tokens ?? outputDetails?.reasoning_tokens),
  };
}

function legacyUsage(structuredUsage) {
  return codexUsageEnvelope({
    inputTokens: structuredUsage?.input_tokens ?? null,
    outputTokens: structuredUsage?.output_tokens ?? null,
  });
}

function efficiencyUsage(structuredUsage) {
  return normalizeCodexUsageEfficiency({ usage: structuredUsage });
}

export function parseCodexResultEnvelope(stdout = '', { agentId = 'codex-cli' } = {}) {
  const parsed = parseCodexEventLines(stdout);
  if (!parsed.ok) {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'codex-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: '',
      usage: codexUsageEnvelope({}),
      usageEfficiency: normalizeCodexUsageEfficiency({ usage: null }),
    });
  }

  const terminal = parsed.events.at(-1);
  if (!terminal || !['turn.completed', 'turn.failed', 'error'].includes(terminal.type)) {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'codex-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: '',
      usage: codexUsageEnvelope({}),
      usageEfficiency: normalizeCodexUsageEfficiency({ usage: null }),
    });
  }

  if (terminal.type === 'turn.completed') {
    const fileChanges = extractFileChangeState(parsed.events);
    const structuredUsage = extractStructuredUsage(terminal);

    if (fileChanges.failed) {
      return normalizedAdapterResult({
        ok: false,
        agentId,
        reason: 'codex-file-change-failed',
        failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
        structuredFailure: 'file_change',
        resultText: '',
        mutatedRepository: false,
        usage: legacyUsage(structuredUsage),
        usageEfficiency: efficiencyUsage(structuredUsage),
      });
    }

    if (fileChanges.ambiguous) {
      return normalizedAdapterResult({
        ok: false,
        agentId,
        reason: 'codex-file-change-evidence-ambiguous',
        failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
        structuredFailure: 'file_change',
        resultText: '',
        mutatedRepository: false,
        usage: legacyUsage(structuredUsage),
        usageEfficiency: efficiencyUsage(structuredUsage),
      });
    }

    return normalizedAdapterResult({
      ok: true,
      agentId,
      resultText: extractAgentMessageText(parsed.events),
      reason: fileChanges.mutated ? null : 'no-op',
      mutatedRepository: fileChanges.mutated,
      usage: legacyUsage(structuredUsage),
      usageEfficiency: efficiencyUsage(structuredUsage),
    });
  }

  const errorMessage = terminal.type === 'turn.failed'
    ? String(terminal?.error?.message || '')
    : String(terminal?.message || '');
  return normalizedAdapterResult({
    ok: false,
    agentId,
    reason: classifyFailureMessage(errorMessage),
    failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
    resultText: '',
    structuredFailure: terminal.type,
    usage: codexUsageEnvelope({}),
    usageEfficiency: normalizeCodexUsageEfficiency({ usage: null }),
  });
}

export function classifyCodexExecutionError({ timedOut = false, cancelled = false, signal = null, code = null, message = '' } = {}) {
  void message;
  const common = {
    ok: false,
    failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
    resultText: '',
    usage: codexUsageEnvelope({}),
    usageEfficiency: normalizeCodexUsageEfficiency({ usage: null }),
  };
  if (cancelled) {
    return normalizedAdapterResult({ ...common, reason: 'codex-cancelled', structuredFailure: signal || code || null });
  }
  if (timedOut) {
    return normalizedAdapterResult({ ...common, reason: 'codex-timeout', structuredFailure: signal || code || null });
  }
  return normalizedAdapterResult({ ...common, reason: 'codex-execution-error', structuredFailure: code || signal || null });
}
