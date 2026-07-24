import { constants as fsConstants, accessSync } from 'node:fs';

import { getAgentSettings } from './agent-runner-agent-settings.mjs';
import { FAILURE_SCOPES, foldProbeOutcomes, probeOutcome } from './agent-runner-adapter-contract.mjs';
import { GROK_MAX_TOOL_ROUNDS_CEILING } from './agent-runner-grok-command.mjs';

/**
 * Foundation-only Grok CLI adapter (issue #49).
 *
 * This module is a library, not an entrypoint: it has no CLI/`main()`, is
 * never imported by the live scheduler (`claude-runner-cron.mjs`), and the
 * `AGENT_ADAPTERS['grok-cli']` registry entry in `agent-runner-agents.mjs`
 * keeps `command: null` and `implemented: false`, so nothing here is
 * routable through real issue dispatch. Only `agent:grok-cli` identifies
 * this adapter.
 *
 * Like the #48 Codex CLI foundation, Grok CLI is not a free local runtime —
 * a real invocation is an authenticated, metered call against xAI. So this
 * adapter adds a third gate beyond the shared enabled/paused/draining/
 * disabled lifecycle: `admitGrokPaidUse()` requires ALL of (1) explicit
 * machine-local paid-use approval, (2) a positive per-run cost or token
 * ceiling, and (3) the dispatching issue/run being explicitly labelled
 * `agent:grok-cli`. Missing any one of the three fails closed.
 *
 * Unlike the Codex foundation, this adapter also runs a deterministic
 * `help-surface` probe (`probeHelpSurface()`) in addition to `executable`
 * and `version`, per the governing issue's explicit requirement for
 * "deterministic executable/version/help-drift admission checks": if a
 * future Grok CLI upgrade removes or renames one of the flags
 * `buildGrokCommandArgs()` depends on (`-d`, `-m`, `--format`, `--sandbox`,
 * `--max-tool-rounds`, `-p`), admission fails closed instead of silently
 * constructing an argv the installed binary no longer understands.
 * `probeVersion()` similarly fails closed against a fixed allowlist of the
 * one version this foundation's contract was actually captured against
 * (`1.1.7`) rather than accepting any non-empty banner.
 *
 * Before any of those process-touching probes, `admitGrokExecutionOptions()`
 * runs first — immediately after the settings lifecycle gate and strictly
 * before `executable`/`version`/`help-surface` — and validates the
 * machine-local execution options a future dispatch would use: a bounded
 * `timeout` (`1_000`..`3_600_000` ms, the same integer-millisecond contract
 * `agent-runner-control-instances.mjs`'s `validateTimeoutValue()` already
 * uses for every other adapter), a bounded `maxToolRounds`
 * (`1`..`GROK_MAX_TOOL_ROUNDS_CEILING`), and a `model` that is either
 * absent/null or a bounded, option-injection-safe identifier. The installed
 * Grok CLI has no `--timeout` flag of its own (see `grok --help` above), so
 * `timeout` here is a caller-enforced process deadline this foundation
 * establishes and validates for a future live executor to honour — not a
 * CLI argument `buildGrokCommandArgs()` emits. An invalid option fails
 * closed with a fixed reason and calls neither `accessFn` nor `execFileFn`;
 * the executable/version/help-surface probes never run.
 *
 * Every probe is deterministic and non-generative: `executable` is a pure
 * local filesystem check, `version`/`help-surface` run the configured
 * binary's `--version`/`--help` banners, and `admitGrokExecutionOptions()`
 * only reads the machine-local settings entry already in memory. None of
 * them ever asks Grok to run a model, log in, or make a network/provider
 * request. All I/O (`accessFn`, `execFileFn`) is injectable so tests can
 * prove zero real process access while disabled or while options are
 * invalid.
 *
 * Sink-safety contract (mirrors the Codex foundation's manager-reviewed
 * contract from PR #62): `probeExecutable()` never returns the configured
 * executable path — not on success (no `detail` at all) and not on failure
 * (a fixed reason, never the raw `accessFn` error message, which for a real
 * filesystem error routinely embeds the path itself). `probeVersion()`'s and
 * `probeHelpSurface()`'s failure paths are the same: a fixed reason, never
 * the raw `execFileFn` error message or raw help/version banner text.
 * `admitGrokPaidUse()`/`admitGrokExecutionOptions()`/`admitGrokDispatch()`
 * return only booleans, machine-readable reasons, and probe names — never
 * the raw settings `entry` a caller passed in, so a configured
 * `sessionSecretRef`, `executablePath`, or `model` can never ride along in a
 * serialized admission decision.
 */
export const GROK_AGENT_ID = 'grok-cli';

/**
 * Bounded, caller-enforced process-deadline range for a future live
 * executor. Matches the repository's existing generic timeout contract
 * (`agent-runner-control-instances.mjs`'s `validateTimeoutValue()`) exactly,
 * so a `timeout` configured for `grok-cli` through the control API's shared
 * `ALLOWED_UPDATE_FIELDS.timeout` and the value this admission probe
 * enforces can never disagree.
 */
export const GROK_TIMEOUT_MIN_MS = 1_000;
export const GROK_TIMEOUT_MAX_MS = 3_600_000;

/**
 * A positive allowlist, not a denylist: a valid model identifier must start
 * with an alphanumeric character and otherwise contain only
 * alphanumerics/`_`/`.`/`/`/`:`/`-`, up to `GROK_MODEL_MAX_LENGTH`
 * characters total. This is the exact same shape (and the same `128`-
 * character bound) as `agent-runner-control-instances.mjs`'s own
 * `MODEL_PATTERN`, reused deliberately rather than reinvented: a positive
 * allowlist can't be bypassed by a character class its author forgot to
 * deny, which a denylist can. It structurally satisfies every one of the
 * governing packet's three requirements — a match can never start with `-`
 * (option injection), never contain whitespace or a control character, and
 * never exceed the length bound — without listing any of them individually.
 */
export const GROK_MODEL_MAX_LENGTH = 128;
const GROK_MODEL_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_./:-]{0,${GROK_MODEL_MAX_LENGTH - 1}}$`);

/**
 * The one version this foundation's flag surface was actually captured
 * against locally (`grok --version`). A future installed version is treated
 * as unsupported/drifted until this foundation is re-verified against it —
 * see the parent issue's "Confirmed Dell interface... must re-read local
 * help/version and fail closed on drift."
 */
export const GROK_SUPPORTED_VERSIONS = Object.freeze(['1.1.7']);

/**
 * The flags `buildGrokCommandArgs()` depends on, as they appear verbatim in
 * `grok --help` captured against `1.1.7`. If any of these substrings is
 * absent from a future `--help` banner, this foundation's command
 * construction can no longer be trusted to match the installed CLI's
 * contract.
 */
const REQUIRED_HELP_TOKENS = Object.freeze([
  '-d, --directory',
  '-m, --model',
  '--format',
  '--sandbox',
  '--max-tool-rounds',
  '-p, --prompt',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Explicit executable resolution: only a machine-local configured path, never a PATH search. */
export function resolveGrokExecutablePath(entry = {}) {
  const path = String(entry?.executablePath || '').trim();
  if (!path) return { ok: false, reason: 'grok-executable-not-configured', path: null };
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
  if (!executablePath) return probeOutcome({ probe: 'executable', ok: false, reason: 'grok-executable-not-configured' });
  try {
    accessFn(executablePath, fsConstants.X_OK);
    return probeOutcome({ probe: 'executable', ok: true });
  } catch {
    return probeOutcome({ probe: 'executable', ok: false, reason: 'grok-executable-unavailable' });
  }
}

/**
 * Deterministic `--version` banner read, checked against the fixed
 * `GROK_SUPPORTED_VERSIONS` allowlist. Never issues an authenticated or
 * model-backed request. On success, `detail` is the version banner itself
 * (e.g. `1.1.7`) — not path-bearing. On failure, the reason is fixed and
 * `detail` is omitted entirely: `execFileFn`'s raised error can be a real
 * child-process spawn error, which routinely embeds the executable path
 * (`spawn <path> ENOENT`) or other diagnostic text, so its raw `.message` is
 * never forwarded into a probe outcome a caller might log, dashboard, or
 * persist.
 */
export function probeVersion({ executablePath, execFileFn } = {}) {
  if (typeof execFileFn !== 'function') {
    return probeOutcome({ probe: 'version', ok: false, reason: 'grok-version-probe-unavailable' });
  }
  try {
    const stdout = String(execFileFn(executablePath, ['--version']) || '').trim();
    if (!stdout) return probeOutcome({ probe: 'version', ok: false, reason: 'grok-version-unreadable' });
    if (!GROK_SUPPORTED_VERSIONS.includes(stdout)) {
      return probeOutcome({ probe: 'version', ok: false, reason: 'grok-unsupported-version' });
    }
    return probeOutcome({ probe: 'version', ok: true, detail: stdout });
  } catch {
    return probeOutcome({ probe: 'version', ok: false, reason: 'grok-version-probe-failed' });
  }
}

/**
 * Deterministic `--help` banner read, checked for every flag
 * `buildGrokCommandArgs()` depends on. Never issues an authenticated or
 * model-backed request. Reports only a boolean-shaped outcome — never the
 * raw help text (large, and not a fact worth persisting) and never the raw
 * `execFileFn` error message on failure (a real child-process spawn error
 * routinely embeds the executable path).
 */
export function probeHelpSurface({ executablePath, execFileFn } = {}) {
  if (typeof execFileFn !== 'function') {
    return probeOutcome({ probe: 'help-surface', ok: false, reason: 'grok-help-probe-unavailable' });
  }
  try {
    const stdout = String(execFileFn(executablePath, ['--help']) || '');
    if (!stdout.trim()) return probeOutcome({ probe: 'help-surface', ok: false, reason: 'grok-help-unreadable' });
    const missing = REQUIRED_HELP_TOKENS.some((token) => !stdout.includes(token));
    if (missing) return probeOutcome({ probe: 'help-surface', ok: false, reason: 'grok-help-drift' });
    return probeOutcome({ probe: 'help-surface', ok: true });
  } catch {
    return probeOutcome({ probe: 'help-surface', ok: false, reason: 'grok-help-probe-failed' });
  }
}

/**
 * Pure, synchronous bounds check — no I/O, no defaulting: a missing/`null`
 * `timeout` is invalid, exactly like an out-of-range one, since a future
 * live executor needs an explicit deadline, not an implicit "no timeout."
 */
export function probeTimeout({ timeout } = {}) {
  const number = Number(timeout);
  if (!Number.isInteger(number) || number < GROK_TIMEOUT_MIN_MS || number > GROK_TIMEOUT_MAX_MS) {
    return probeOutcome({ probe: 'timeout', ok: false, reason: 'grok-timeout-out-of-range' });
  }
  return probeOutcome({ probe: 'timeout', ok: true });
}

/** Pure, synchronous bounds check — no I/O. Mirrors `buildGrokCommandArgs()`'s own bound so admission and construction can never disagree. */
export function probeMaxToolRounds({ maxToolRounds } = {}) {
  const number = Number(maxToolRounds);
  if (!Number.isInteger(number) || number < 1 || number > GROK_MAX_TOOL_ROUNDS_CEILING) {
    return probeOutcome({ probe: 'max-tool-rounds', ok: false, reason: 'grok-max-tool-rounds-invalid' });
  }
  return probeOutcome({ probe: 'max-tool-rounds', ok: true });
}

/**
 * Pure, synchronous shape check — no I/O. Absent/`null`/whitespace-only is
 * valid (mirrors `buildGrokCommandArgs()`'s own "omit unless configured"
 * handling); a configured value must match `GROK_MODEL_PATTERN`.
 */
export function probeModel({ model } = {}) {
  if (model === undefined || model === null) return probeOutcome({ probe: 'model', ok: true });
  const raw = String(model);
  if (!raw.trim()) return probeOutcome({ probe: 'model', ok: true });
  if (!GROK_MODEL_PATTERN.test(raw)) {
    return probeOutcome({ probe: 'model', ok: false, reason: 'grok-model-invalid' });
  }
  return probeOutcome({ probe: 'model', ok: true });
}

/**
 * The pre-I/O execution-options admission gate. Runs entirely against the
 * settings `entry` already in memory — no `accessFn`, no `execFileFn`, no
 * network, no command construction. Each sub-probe is independently
 * mandatory; `foldProbeOutcomes` reports the first that fails.
 */
export function admitGrokExecutionOptions({ entry = {} } = {}) {
  const resolvedEntry = isPlainObject(entry) ? entry : {};
  const outcomes = [
    probeTimeout({ timeout: resolvedEntry.timeout }),
    probeMaxToolRounds({ maxToolRounds: resolvedEntry.maxToolRounds }),
    probeModel({ model: resolvedEntry.model }),
  ];
  return { ...foldProbeOutcomes(outcomes, {
    safeNextAction: `Set a timeout between ${GROK_TIMEOUT_MIN_MS} and ${GROK_TIMEOUT_MAX_MS} ms, a maxToolRounds between 1 and ${GROK_MAX_TOOL_ROUNDS_CEILING}, and either omit model or set a bounded, option-safe identifier before any future invocation.`,
  }), probes: outcomes };
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
export function admitGrokPaidUse({ entry = {}, labels = [] } = {}) {
  const resolvedEntry = isPlainObject(entry) ? entry : {};
  const normalizedLabels = normalizeLabels(labels);

  const approvalOutcome = resolvedEntry.paidUseApproved === true
    ? probeOutcome({ probe: 'paid-use-approval', ok: true })
    : probeOutcome({ probe: 'paid-use-approval', ok: false, reason: 'grok-paid-use-not-approved' });

  const costCeiling = Number(resolvedEntry.maxCostUsdPerRun);
  const tokenCeiling = Number(resolvedEntry.maxTokensPerRun);
  const hasPositiveCeiling = (Number.isFinite(costCeiling) && costCeiling > 0) || (Number.isFinite(tokenCeiling) && tokenCeiling > 0);
  const ceilingOutcome = hasPositiveCeiling
    ? probeOutcome({ probe: 'per-run-ceiling', ok: true })
    : probeOutcome({ probe: 'per-run-ceiling', ok: false, reason: 'grok-run-ceiling-not-set' });

  const hasCliLabel = normalizedLabels.includes('agent:grok-cli');
  const labelOutcome = hasCliLabel
    ? probeOutcome({ probe: 'cli-label', ok: true })
    : probeOutcome({ probe: 'cli-label', ok: false, reason: 'grok-issue-not-cli-labelled' });

  return { ...foldProbeOutcomes([approvalOutcome, ceilingOutcome, labelOutcome], {
    safeNextAction: 'Set paidUseApproved:true, a positive maxCostUsdPerRun or maxTokensPerRun, and label the issue/run agent:grok-cli before any future invocation.',
  }), probes: [approvalOutcome, ceilingOutcome, labelOutcome] };
}

/**
 * Settings gate, then the pre-I/O execution-options gate, then
 * executable/version/help-surface probes, then the paid-use gate — in
 * strict sequence, never `Promise.all`, stopping at the first failure.
 * Returns `probes: []` and calls no injected I/O function at all when the
 * agent is not routable or when an execution option is invalid, which is
 * itself the zero-process/zero-model-call proof for both the
 * disabled-by-default path and the invalid-configuration path.
 */
export function admitGrokDispatch({
  env = process.env,
  labels = [],
  settings,
  accessFn,
  execFileFn,
} = {}) {
  const resolvedSettings = settings || getAgentSettings({ env, agentId: GROK_AGENT_ID });
  if (!resolvedSettings.routable) {
    return {
      allowed: false,
      scope: FAILURE_SCOPES.MACHINE_PROFILE,
      reason: resolvedSettings.reason,
      failedProbe: null,
      detail: null,
      safeNextAction: 'Enable grok-cli explicitly (enabled:true, disabled:false, not paused/draining) in machine-local agent settings before dispatch.',
      probes: [],
    };
  }

  const entry = isPlainObject(resolvedSettings.entry) ? resolvedSettings.entry : {};

  const optionsDecision = admitGrokExecutionOptions({ entry });
  if (!optionsDecision.allowed) {
    return { ...optionsDecision, probes: optionsDecision.probes };
  }

  const executable = resolveGrokExecutablePath(entry);
  const outcomes = [];

  outcomes.push(executable.ok
    ? probeExecutable({ executablePath: executable.path, accessFn })
    : probeOutcome({ probe: 'executable', ok: false, reason: executable.reason }));

  if (outcomes.at(-1).ok) {
    outcomes.push(probeVersion({ executablePath: executable.path, execFileFn }));
  }

  if (outcomes.every((outcome) => outcome.ok)) {
    outcomes.push(probeHelpSurface({ executablePath: executable.path, execFileFn }));
  }

  const readinessDecision = foldProbeOutcomes(outcomes);
  if (!readinessDecision.allowed) {
    return { ...readinessDecision, probes: [...optionsDecision.probes, ...outcomes] };
  }

  const paidUseDecision = admitGrokPaidUse({ entry, labels });
  return { ...paidUseDecision, probes: [...optionsDecision.probes, ...outcomes, ...paidUseDecision.probes] };
}

export { classifyGrokExecutionError, grokUsageEnvelope, parseGrokResultEnvelope } from './agent-runner-grok-parser.mjs';
export { buildGrokCommandArgs, GROK_MAX_TOOL_ROUNDS_CEILING } from './agent-runner-grok-command.mjs';
