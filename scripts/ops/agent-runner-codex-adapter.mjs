import { constants as fsConstants, accessSync } from 'node:fs';

import { getAgentSettings } from './agent-runner-agent-settings.mjs';
import { FAILURE_SCOPES, foldProbeOutcomes, probeOutcome } from './agent-runner-adapter-contract.mjs';

/**
 * Foundation-only Codex CLI adapter (issue #48).
 *
 * This module is a library, not an entrypoint: it has no CLI/`main()`, is
 * never imported by the live scheduler (`claude-runner-cron.mjs`), and the
 * `AGENT_ADAPTERS['codex-cli']` registry entry in `agent-runner-agents.mjs`
 * keeps `implemented: false`, so nothing here is routable through real
 * issue dispatch. `agent:codex` (Codex Web/manual) has no entry anywhere in
 * that registry and can never resolve to this or any local process; only
 * `agent:codex-cli` identifies this adapter.
 *
 * Unlike the #40 Ollama/OpenCode foundation, Codex CLI is not a free local
 * runtime — a real invocation is an authenticated, metered call. So this
 * adapter adds a third gate beyond the shared enabled/paused/draining/
 * disabled lifecycle: `admitCodexPaidUse()` requires ALL of (1) explicit
 * machine-local paid-use approval, (2) a positive per-run cost or token
 * ceiling, and (3) the dispatching issue/run being explicitly labelled
 * `agent:codex-cli` (and never `agent:codex`, which would mean Codex Web
 * work, not a CLI run). Missing any one of the three fails closed.
 *
 * Every probe is deterministic and non-generative: `executable` is a pure
 * local filesystem check, `version` runs the configured binary's
 * `--version` banner. Neither ever asks Codex to run a model. All I/O
 * (`accessFn`, `execFileFn`) is injectable so tests can prove zero real
 * process access while disabled.
 *
 * Sink-safety contract (manager review on PR #62): `probeExecutable()`
 * never returns the configured executable path — not on success (no
 * `detail` at all) and not on failure (a fixed reason, never the raw
 * `accessFn` error message, which for a real filesystem error routinely
 * embeds the path itself). `probeVersion()`'s failure path is the same: a
 * fixed reason, never the raw `execFileFn` error message (a real
 * child-process spawn error routinely embeds the executable path too).
 * `admitCodexPaidUse()`/`admitCodexDispatch()` return only booleans,
 * machine-readable reasons, and probe names — never the raw settings
 * `entry` a caller passed in, so a configured `sessionSecretRef` or
 * `executablePath` can never ride along in a serialized admission decision.
 */
export const CODEX_AGENT_ID = 'codex-cli';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Explicit executable resolution: only a machine-local configured path, never a PATH search. */
export function resolveCodexExecutablePath(entry = {}) {
  const path = String(entry?.executablePath || '').trim();
  if (!path) return { ok: false, reason: 'codex-executable-not-configured', path: null };
  return { ok: true, reason: null, path };
}

/**
 * Machine-local executable path is configuration, not a fact worth
 * surfacing on a readiness result a caller might log, dashboard, or
 * persist: a successful probe reports no `detail` at all, and a failed one
 * reports the same fixed, bounded reason regardless of the underlying
 * `accessFn` error — never that error's raw `.message` (which, for a real
 * filesystem error, routinely embeds the path itself).
 */
export function probeExecutable({ executablePath, accessFn = accessSync } = {}) {
  if (!executablePath) return probeOutcome({ probe: 'executable', ok: false, reason: 'codex-executable-not-configured' });
  try {
    accessFn(executablePath, fsConstants.X_OK);
    return probeOutcome({ probe: 'executable', ok: true });
  } catch {
    return probeOutcome({ probe: 'executable', ok: false, reason: 'codex-executable-unavailable' });
  }
}

/**
 * Deterministic `--version` banner read. Never issues an authenticated or
 * model-backed request. On success, `detail` is the version banner itself
 * (e.g. `codex-cli 0.144.6`) — not path-bearing. On failure, the reason is
 * fixed and `detail` is omitted entirely: `execFileFn`'s raised error can be
 * a real child-process spawn error, which routinely embeds the executable
 * path (`spawn <path> ENOENT`) or other diagnostic text, so its raw
 * `.message` is never forwarded into a probe outcome a caller might log,
 * dashboard, or persist.
 */
export function probeVersion({ executablePath, execFileFn } = {}) {
  if (typeof execFileFn !== 'function') {
    return probeOutcome({ probe: 'version', ok: false, reason: 'codex-version-probe-unavailable' });
  }
  try {
    const stdout = String(execFileFn(executablePath, ['--version']) || '').trim();
    if (!stdout) return probeOutcome({ probe: 'version', ok: false, reason: 'codex-version-unreadable' });
    return probeOutcome({ probe: 'version', ok: true, detail: stdout });
  } catch {
    return probeOutcome({ probe: 'version', ok: false, reason: 'codex-version-probe-failed' });
  }
}

function normalizeLabels(labels = []) {
  return (Array.isArray(labels) ? labels : [])
    .map((value) => String(value?.name || value || '').trim())
    .filter(Boolean);
}

/**
 * The three-part paid-use admission gate. Each part is independently
 * mandatory; `foldProbeOutcomes` reports the first that fails so a caller
 * never has to guess which of the three is missing.
 */
export function admitCodexPaidUse({ entry = {}, labels = [] } = {}) {
  const resolvedEntry = isPlainObject(entry) ? entry : {};
  const normalizedLabels = normalizeLabels(labels);

  const approvalOutcome = resolvedEntry.paidUseApproved === true
    ? probeOutcome({ probe: 'paid-use-approval', ok: true })
    : probeOutcome({ probe: 'paid-use-approval', ok: false, reason: 'codex-paid-use-not-approved' });

  const costCeiling = Number(resolvedEntry.maxCostUsdPerRun);
  const tokenCeiling = Number(resolvedEntry.maxTokensPerRun);
  const hasPositiveCeiling = (Number.isFinite(costCeiling) && costCeiling > 0) || (Number.isFinite(tokenCeiling) && tokenCeiling > 0);
  const ceilingOutcome = hasPositiveCeiling
    ? probeOutcome({ probe: 'per-run-ceiling', ok: true })
    : probeOutcome({ probe: 'per-run-ceiling', ok: false, reason: 'codex-run-ceiling-not-set' });

  const hasCliLabel = normalizedLabels.includes('agent:codex-cli');
  const labelOutcome = hasCliLabel
    ? probeOutcome({ probe: 'cli-label', ok: true })
    : probeOutcome({ probe: 'cli-label', ok: false, reason: 'codex-issue-not-cli-labelled' });

  return { ...foldProbeOutcomes([approvalOutcome, ceilingOutcome, labelOutcome], {
    safeNextAction: 'Set paidUseApproved:true, a positive maxCostUsdPerRun or maxTokensPerRun, and label the issue/run agent:codex-cli before any future invocation.',
  }), probes: [approvalOutcome, ceilingOutcome, labelOutcome] };
}

/**
 * Binding #184/#186 quota-only admission for the normal ChatGPT-authenticated
 * Codex route. A current, positively resolved resource state is mandatory.
 * Account credits, balances, paid-use approval and dollar/token caps are not
 * inputs. Ambiguous/missing quota fails closed before provider launch.
 */
export function admitCodexQuotaUse({ resourceState = null } = {}) {
  if (!isPlainObject(resourceState) || typeof resourceState.blocked !== 'boolean') {
    const outcome = probeOutcome({
      probe: 'quota-headroom',
      ok: false,
      reason: 'codex-quota-evidence-unavailable',
    });
    return {
      ...foldProbeOutcomes([outcome], {
        safeNextAction: 'Obtain current supported Codex quota/headroom evidence before provider launch.',
      }),
      probes: [outcome],
    };
  }

  const outcome = resourceState.blocked
    ? probeOutcome({
      probe: 'quota-headroom',
      ok: false,
      reason: resourceState.reason || 'codex-quota-blocked',
    })
    : probeOutcome({ probe: 'quota-headroom', ok: true });

  return {
    ...foldProbeOutcomes([outcome], {
      safeNextAction: resourceState.blocked
        ? 'Wait for current Codex quota/headroom to become available before retrying.'
        : null,
    }),
    probes: [outcome],
  };
}

/**
 * Settings gate, then executable/version probes, then the paid-use gate —
 * in strict sequence, never `Promise.all`, stopping at the first failure.
 * Returns `probes: []` and calls no injected I/O function at all when the
 * agent is not routable, which is itself the zero-process/zero-model-call
 * proof for the disabled-by-default path.
 */
export function admitCodexDispatch({
  env = process.env,
  labels = [],
  settings,
  resourceState = null,
  accessFn,
  execFileFn,
} = {}) {
  const resolvedSettings = settings || getAgentSettings({ env, agentId: CODEX_AGENT_ID });
  if (!resolvedSettings.routable) {
    return {
      allowed: false,
      scope: FAILURE_SCOPES.MACHINE_PROFILE,
      reason: resolvedSettings.reason,
      failedProbe: null,
      detail: null,
      safeNextAction: 'Enable codex-cli explicitly (enabled:true, disabled:false, not paused/draining) in machine-local agent settings before dispatch.',
      probes: [],
    };
  }

  const entry = isPlainObject(resolvedSettings.entry) ? resolvedSettings.entry : {};
  const executable = resolveCodexExecutablePath(entry);
  const outcomes = [];

  outcomes.push(executable.ok
    ? probeExecutable({ executablePath: executable.path, accessFn })
    : probeOutcome({ probe: 'executable', ok: false, reason: executable.reason }));

  if (outcomes.at(-1).ok) {
    outcomes.push(probeVersion({ executablePath: executable.path, execFileFn }));
  }

  const readinessDecision = foldProbeOutcomes(outcomes);
  if (!readinessDecision.allowed) {
    return { ...readinessDecision, probes: outcomes };
  }

  void labels;
  const quotaDecision = admitCodexQuotaUse({ resourceState });
  return { ...quotaDecision, probes: [...outcomes, ...quotaDecision.probes] };
}

export { classifyCodexExecutionError, codexUsageEnvelope, parseCodexResultEnvelope } from './agent-runner-codex-parser.mjs';
export { buildCodexCommandArgs } from './agent-runner-codex-command.mjs';
