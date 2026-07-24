import { FAILURE_SCOPES, normalizedAdapterResult } from './agent-runner-adapter-contract.mjs';

/**
 * Bounded structured-output parsing for `grok -p <prompt> --format json`
 * (issue #49).
 *
 * `grok --help` documents `--format <format>` (`text` or `json`) but does
 * not document the JSON payload's field shape, and no live, authenticated
 * headless run has been performed to capture one — doing so is out of scope
 * for this foundation (see the hard boundary against running any Grok
 * prompt or model call). This module therefore assumes a single JSON object
 * on stdout (not a JSONL event stream, since `--help` gives no indication
 * of a streaming protocol) shaped like:
 *
 *   { "status": "success" | "error", "message": string,
 *     "mutated": boolean, "toolRounds": number,
 *     "error": { "message": string } | null,
 *     "usage": { "inputTokens": number, "outputTokens": number } | null }
 *
 * This is the same kind of documented-but-not-yet-live-verified contract
 * the #40 Ollama/OpenCode foundation and the #48 Codex foundation used for
 * their own assumed shapes — flagged explicitly in "Known limitations" in
 * `docs/ops/AGENT-RUNNER-GROK-ADAPTER-FOUNDATION.md`. Every function here is
 * a pure parser: none of them spawn a process or make a network/model call.
 *
 * Sink-safety contract (tightened per PR #63 manager review, mirroring the
 * Codex foundation's manager-reviewed contract from PR #62): raw stdout,
 * provider error text, prompt content, session/credential material, and
 * arbitrary caller-supplied process-wrapper `message`/`signal`/`code` values
 * are classification *inputs* only — they are read (or, for
 * `classifyGrokExecutionError()`'s `message`/`signal`/`code`, not read at
 * all; only the `cancelled`/`timedOut` booleans select the branch) to pick a
 * bounded, machine-readable `reason`/enum value and are never themselves
 * placed into the returned `normalizedAdapterResult` (`resultText`,
 * `structuredFailure`, or any other field). Every non-success path below
 * returns `resultText: ''` and either `structuredFailure: null` or one of a
 * small, fixed, finite set of closed-vocabulary tokens
 * (`'grok-invalid-output'`, `'grok-cancelled'`, `'grok-timeout'`,
 * `'grok-execution-error'`) — never an OS signal name, an error `code`, or
 * any other raw, unbounded string a malformed/adversarial payload or
 * process wrapper could fill with secrets. `agent-runner-grok-adapter.test.mjs` and
 * this module's own test file prove this by serializing full results seeded
 * with synthetic credentials/session handles/local paths/prompts and
 * asserting their absence.
 */

const AUTH_FAILURE_PATTERN = /not logged in|log in|authentication|unauthoriz|401|invalid api key/i;
const QUOTA_FAILURE_PATTERN = /quota|rate.?limit|429|insufficient (credit|balance)/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Zero-inference paid-usage envelope: token counts pass through verbatim; cost pricing lookup is explicitly out of scope for this foundation. */
export function grokUsageEnvelope({ inputTokens = null, outputTokens = null } = {}) {
  return Object.freeze({
    provider: 'grok-cli',
    paid: true,
    costUsd: null,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
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

/**
 * Parse a full `grok -p <prompt> --format json` stdout capture into the
 * shared `normalizedAdapterResult` contract. Classifies, in order: malformed
 * output (unparseable / not an object / missing or unrecognized `status`),
 * authentication failure, quota failure, generic task failure, structured
 * no-op (`status: 'success'` with `mutated: false`), and success-with-
 * mutation.
 *
 * Malformed/failure paths never echo raw stdout or the raw `error.message`
 * back out: `resultText` is the empty string and `structuredFailure` is
 * either `null` or the fixed `'grok-invalid-output'` token, never
 * provider-controlled free text. Only a `status: 'success'` payload's own
 * `message` field — the assumed model output field, exercised only by
 * mocked test fixtures in this issue, never a real invocation — populates
 * `resultText`.
 */
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
  });
}

/**
 * Classify a process-level execution outcome (timeout/cancellation) that
 * never produced parseable Grok output. No child-process spawning lives in
 * this foundation-only module — callers normalize their own process
 * wrapper's outcome into this shape.
 *
 * Branch selection is driven entirely by the boolean `cancelled`/`timedOut`
 * flags. `message`, `signal`, and `code` are accepted only for call-site
 * shape compatibility with a future live process wrapper and are otherwise
 * inert: none of the three is read, and none is ever placed into the
 * returned result. Earlier revisions of this function forwarded
 * `signal || code` into `structuredFailure` verbatim; a caller could place a
 * credential, session handle, path, prompt, or unrestricted diagnostic in
 * either field and have it survive into a normalized result. There is now
 * no code path through which any of `message`/`signal`/`code` can reach the
 * return value: `structuredFailure` is always one of the fixed, finite
 * tokens `'grok-cancelled'`, `'grok-timeout'`, or `'grok-execution-error'`
 * (matching `reason`), regardless of what the caller passes.
 */
export function classifyGrokExecutionError({ timedOut = false, cancelled = false, signal = null, code = null, message = '' } = {}) {
  if (cancelled) {
    return normalizedAdapterResult({ ok: false, reason: 'grok-cancelled', failureScope: FAILURE_SCOPES.TASK_ATTEMPT, resultText: '', structuredFailure: 'grok-cancelled', usage: grokUsageEnvelope({}) });
  }
  if (timedOut) {
    return normalizedAdapterResult({ ok: false, reason: 'grok-timeout', failureScope: FAILURE_SCOPES.TASK_ATTEMPT, resultText: '', structuredFailure: 'grok-timeout', usage: grokUsageEnvelope({}) });
  }
  return normalizedAdapterResult({ ok: false, reason: 'grok-execution-error', failureScope: FAILURE_SCOPES.TASK_ATTEMPT, resultText: '', structuredFailure: 'grok-execution-error', usage: grokUsageEnvelope({}) });
}
