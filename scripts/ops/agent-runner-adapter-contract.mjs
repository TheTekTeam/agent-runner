import { FAILURE_SCOPES } from './agent-runner-admission.mjs';

export { FAILURE_SCOPES };

/**
 * Zero-cost usage/spend envelope for a locally-hosted, non-metered model
 * runtime. `paid` is always `false` and `costUsd` is always the literal `0`
 * (never `null`/omitted) so downstream cost accounting can rely on a
 * concrete zero rather than treating a missing field as unknown spend.
 */
export function zeroSpendEnvelope({ provider = 'ollama-local' } = {}) {
  return Object.freeze({
    provider,
    paid: false,
    costUsd: 0,
    inputTokens: null,
    outputTokens: null,
  });
}

/**
 * Normalized, adapter-agnostic run-result contract. Every generic adapter
 * (implemented or foundation-only) reports its outcome in this shape so
 * scheduler/dashboard code does not need per-agent branching to read
 * success, failure classification, or spend.
 *
 * `failureScope` is one of `FAILURE_SCOPES` (or `null` on success) and must
 * never be invented ad hoc by an adapter; resource/capacity/admission
 * failures use `FAILURE_SCOPES.MACHINE_PROFILE`, distinct from a paid
 * provider's token-quota exhaustion (which is `task_attempt` /
 * `quota_paused`-style outcomes elsewhere in this runner and never applies
 * to a free local adapter).
 */
export function normalizedAdapterResult({
  ok,
  agentId,
  exitCode = null,
  resultText = '',
  structuredFailure = null,
  failureScope = null,
  reason = null,
  usage = null,
  mutatedRepository = false,
  mutatedGitHub = false,
} = {}) {
  return {
    ok: Boolean(ok),
    agentId: agentId || null,
    exitCode,
    resultText: String(resultText || ''),
    structuredFailure,
    failureScope: ok ? null : (failureScope || FAILURE_SCOPES.MACHINE_PROFILE),
    reason,
    usage: usage || zeroSpendEnvelope(),
    mutatedRepository: Boolean(mutatedRepository),
    mutatedGitHub: Boolean(mutatedGitHub),
  };
}

/**
 * One deterministic, non-model admission/readiness probe outcome. `probe`
 * names the check (`executable`, `version`, `endpoint`, `installed-model`,
 * `host-headroom`); `ok: false` always carries a `failureScope` and a
 * machine-readable `reason` so a caller never has to string-match `detail`.
 */
export function probeOutcome({ probe, ok, reason = null, detail = null, failureScope = null } = {}) {
  if (!probe) throw new Error('probeOutcome requires a probe name');
  return {
    probe,
    ok: Boolean(ok),
    reason: ok ? null : (reason || `${probe}-unavailable`),
    detail: detail || null,
    failureScope: ok ? null : (failureScope || FAILURE_SCOPES.MACHINE_PROFILE),
  };
}

/**
 * Fold an ordered list of probe outcomes into one admission decision,
 * stopping at (and reporting) the first failure. Mirrors the
 * `{ allowed, scope, reason, safeNextAction }` shape already used by
 * `agent-runner-admission.mjs` so downstream reporting code has one
 * consistent admission contract across paid and local adapters.
 */
export function foldProbeOutcomes(outcomes = [], { safeNextAction } = {}) {
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      return {
        allowed: false,
        scope: outcome.failureScope || FAILURE_SCOPES.MACHINE_PROFILE,
        reason: outcome.reason,
        failedProbe: outcome.probe,
        detail: outcome.detail,
        safeNextAction: safeNextAction || `Resolve ${outcome.probe} before retrying admission.`,
      };
    }
  }
  return {
    allowed: true,
    scope: null,
    reason: 'adapter-admitted',
    failedProbe: null,
    detail: null,
    safeNextAction: 'Continue to adapter-specific command construction.',
  };
}
