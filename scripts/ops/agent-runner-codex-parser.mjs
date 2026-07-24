import { FAILURE_SCOPES, normalizedAdapterResult } from './agent-runner-adapter-contract.mjs';

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
 */

const AUTH_FAILURE_PATTERN = /not logged in|log in|authentication|unauthoriz|401/i;
const QUOTA_FAILURE_PATTERN = /quota|rate.?limit|429|insufficient credit/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Zero-inference paid-usage envelope: token counts pass through verbatim; cost pricing lookup is explicitly out of scope for this foundation. */
export function codexUsageEnvelope({ inputTokens = null, outputTokens = null } = {}) {
  return Object.freeze({
    provider: 'codex-cli',
    paid: true,
    costUsd: null,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
  });
}

/**
 * Parse raw `--json` stdout into an ordered array of event objects. Fails
 * closed (`ok: false`) on empty input, any line that is not valid JSON, or
 * any line missing a string `type` field — there is no partial/best-effort
 * parse.
 */
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

function extractMutatedRepository(events) {
  return events.some((event) => event.type === 'item.completed' && isPlainObject(event.item) && event.item.type === 'file_change');
}

function extractUsage(event) {
  const usage = isPlainObject(event?.usage) ? event.usage : null;
  return codexUsageEnvelope({
    inputTokens: usage ? Number(usage.input_tokens) : null,
    outputTokens: usage ? Number(usage.output_tokens) : null,
  });
}

/**
 * Parse a full `codex exec --json` stdout capture into the shared
 * `normalizedAdapterResult` contract. Classifies, in order: malformed
 * output (unparseable/no terminal event), authentication failure, quota
 * failure, generic task failure, structured no-op (turn completed without a
 * `file_change` item), and success-with-mutation.
 */
export function parseCodexResultEnvelope(stdout = '', { agentId = 'codex-cli' } = {}) {
  const parsed = parseCodexEventLines(stdout);
  if (!parsed.ok) {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'codex-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: String(stdout || '').trim(),
    });
  }

  const terminal = parsed.events.at(-1);
  if (!terminal || !['turn.completed', 'turn.failed', 'error'].includes(terminal.type)) {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'codex-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: extractAgentMessageText(parsed.events),
    });
  }

  if (terminal.type === 'turn.completed') {
    const mutated = extractMutatedRepository(parsed.events);
    return normalizedAdapterResult({
      ok: true,
      agentId,
      resultText: extractAgentMessageText(parsed.events),
      reason: mutated ? null : 'no-op',
      mutatedRepository: mutated,
      usage: extractUsage(terminal),
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
    resultText: extractAgentMessageText(parsed.events),
    structuredFailure: errorMessage || null,
    usage: codexUsageEnvelope({}),
  });
}

/**
 * Classify a process-level execution outcome (timeout/cancellation) that
 * never produced a parseable terminal event. No child-process spawning
 * lives in this foundation-only module — callers normalize their own
 * process wrapper's outcome into this shape.
 */
export function classifyCodexExecutionError({ timedOut = false, cancelled = false, signal = null, code = null, message = '' } = {}) {
  if (cancelled) {
    return normalizedAdapterResult({ ok: false, reason: 'codex-cancelled', failureScope: FAILURE_SCOPES.TASK_ATTEMPT, resultText: message, structuredFailure: signal || code || null, usage: codexUsageEnvelope({}) });
  }
  if (timedOut) {
    return normalizedAdapterResult({ ok: false, reason: 'codex-timeout', failureScope: FAILURE_SCOPES.TASK_ATTEMPT, resultText: message, structuredFailure: signal || code || null, usage: codexUsageEnvelope({}) });
  }
  return normalizedAdapterResult({ ok: false, reason: 'codex-execution-error', failureScope: FAILURE_SCOPES.TASK_ATTEMPT, resultText: message, structuredFailure: code || signal || null, usage: codexUsageEnvelope({}) });
}
