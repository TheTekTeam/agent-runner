import { constants as fsConstants, accessSync } from 'node:fs';
import { freemem } from 'node:os';

import { getAgentSettings } from './agent-runner-agent-settings.mjs';
import {
  FAILURE_SCOPES,
  foldProbeOutcomes,
  normalizedAdapterResult,
  probeOutcome,
  zeroSpendEnvelope,
} from './agent-runner-adapter-contract.mjs';
import { normalizeOllamaUsageEfficiency } from './agent-runner-usage-telemetry.mjs';

/**
 * Foundation-only OpenCode/Ollama adapter.
 *
 * This module is a library, not an entrypoint: it has no CLI/`main()`, is
 * never imported by the live scheduler (`claude-runner-cron.mjs`), and the
 * `AGENT_ADAPTERS['ollama-agent']` registry entry in
 * `agent-runner-agents.mjs` keeps `implemented: false`, so nothing here is
 * routable through real issue dispatch. It exists so the adapter/settings
 * contract, admission probes, and OpenCode command/result handling can be
 * built and tested now, ahead of live enablement in a later issue.
 *
 * Every probe is deterministic and non-generative: it never asks an Ollama
 * model to produce a completion. `executable`/`host-headroom` are pure
 * local filesystem/OS checks; `version` runs the configured binary's
 * `--version` banner; `endpoint`/`installed-model` call Ollama's metadata
 * listing endpoint (`/api/tags`), never a generation endpoint. All I/O
 * (`accessFn`, `execFileFn`, `fetchFn`, `freeMemoryFn`) is injectable so
 * tests can prove zero real process/network access.
 */
export const OLLAMA_AGENT_ID = 'ollama-agent';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Localhost is always permitted; anything else must appear, byte-for-byte,
 * in the machine-local `endpointAllowlistHosts` array. There is no wildcard
 * and no automatic LAN discovery.
 */
export function isAllowlistedOllamaHost(hostname, endpointAllowlistHosts = []) {
  const host = String(hostname || '').toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return (Array.isArray(endpointAllowlistHosts) ? endpointAllowlistHosts : [])
    .map((entry) => String(entry).toLowerCase())
    .includes(host);
}

/** Explicit executable resolution: only a machine-local configured path, never a PATH search. */
export function resolveOllamaExecutablePath(entry = {}) {
  const path = String(entry?.executablePath || '').trim();
  if (!path) return { ok: false, reason: 'ollama-executable-not-configured', path: null };
  return { ok: true, reason: null, path };
}

/** Localhost or explicitly allowlisted LAN endpoint only; malformed/non-HTTP(S) URLs fail closed. */
export function resolveOllamaEndpoint(entry = {}) {
  const raw = String(entry?.endpoint || '').trim();
  if (!raw) return { ok: false, reason: 'ollama-endpoint-not-configured', url: null };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'ollama-endpoint-malformed', url: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'ollama-endpoint-malformed', url: null };
  }
  if (!isAllowlistedOllamaHost(parsed.hostname, entry?.endpointAllowlistHosts)) {
    return { ok: false, reason: 'ollama-endpoint-not-allowlisted', url: parsed.toString() };
  }
  return { ok: true, reason: null, url: parsed.toString(), hostname: parsed.hostname };
}

export function probeExecutable({ executablePath, accessFn = accessSync } = {}) {
  if (!executablePath) return probeOutcome({ probe: 'executable', ok: false, reason: 'ollama-executable-not-configured' });
  try {
    accessFn(executablePath, fsConstants.X_OK);
    return probeOutcome({ probe: 'executable', ok: true, detail: executablePath });
  } catch (error) {
    return probeOutcome({ probe: 'executable', ok: false, reason: 'ollama-executable-unavailable', detail: error.message });
  }
}

/** Deterministic `--version` banner read. Never issues a generation request. */
export function probeVersion({ executablePath, execFileFn } = {}) {
  if (typeof execFileFn !== 'function') {
    return probeOutcome({ probe: 'version', ok: false, reason: 'ollama-version-probe-unavailable' });
  }
  try {
    const stdout = String(execFileFn(executablePath, ['--version']) || '').trim();
    if (!stdout) return probeOutcome({ probe: 'version', ok: false, reason: 'ollama-version-unreadable' });
    return probeOutcome({ probe: 'version', ok: true, detail: stdout });
  } catch (error) {
    return probeOutcome({ probe: 'version', ok: false, reason: 'ollama-version-probe-failed', detail: error.message });
  }
}

/** Metadata-only reachability check against `/api/tags`. Never calls a generation endpoint. */
export async function probeEndpoint({ endpointUrl, fetchFn } = {}) {
  if (!endpointUrl) return probeOutcome({ probe: 'endpoint', ok: false, reason: 'ollama-endpoint-not-configured' });
  if (typeof fetchFn !== 'function') return probeOutcome({ probe: 'endpoint', ok: false, reason: 'ollama-endpoint-probe-unavailable' });
  try {
    const response = await fetchFn(new URL('/api/tags', endpointUrl).toString(), { method: 'GET' });
    if (!response || response.ok !== true) {
      return probeOutcome({ probe: 'endpoint', ok: false, reason: 'ollama-endpoint-unavailable', detail: `status ${response?.status ?? 'unknown'}` });
    }
    return probeOutcome({ probe: 'endpoint', ok: true });
  } catch (error) {
    return probeOutcome({ probe: 'endpoint', ok: false, reason: 'ollama-endpoint-unreachable', detail: error.message });
  }
}

/**
 * A model is usable only when it is BOTH in the explicit machine-local
 * allowlist AND reported as actually installed by the endpoint's own
 * metadata listing. Neither condition alone is sufficient, and nothing here
 * ever triggers a pull/download of a missing model.
 */
export async function probeInstalledModel({ model, installedModelAllowlist = [], endpointUrl, fetchFn } = {}) {
  if (!model) return probeOutcome({ probe: 'installed-model', ok: false, reason: 'ollama-model-not-requested' });
  if (!(Array.isArray(installedModelAllowlist) ? installedModelAllowlist : []).includes(model)) {
    return probeOutcome({ probe: 'installed-model', ok: false, reason: 'ollama-model-not-allowlisted', detail: model });
  }
  if (typeof fetchFn !== 'function') return probeOutcome({ probe: 'installed-model', ok: false, reason: 'ollama-model-probe-unavailable' });
  try {
    const response = await fetchFn(new URL('/api/tags', endpointUrl).toString(), { method: 'GET' });
    if (!response || response.ok !== true) {
      return probeOutcome({ probe: 'installed-model', ok: false, reason: 'ollama-model-unavailable', detail: `status ${response?.status ?? 'unknown'}` });
    }
    const payload = await response.json();
    const installedNames = Array.isArray(payload?.models)
      ? payload.models.map((entry) => entry?.name || entry?.model).filter(Boolean)
      : [];
    if (!installedNames.includes(model)) {
      return probeOutcome({ probe: 'installed-model', ok: false, reason: 'ollama-model-not-installed', detail: model });
    }
    return probeOutcome({ probe: 'installed-model', ok: true, detail: model });
  } catch (error) {
    return probeOutcome({ probe: 'installed-model', ok: false, reason: 'ollama-model-probe-failed', detail: error.message });
  }
}

/** Pure local OS check; distinct from paid-provider token/budget quota. */
export function probeHostHeadroom({ minFreeMemoryBytes = 0, freeMemoryFn = freemem } = {}) {
  let free;
  try {
    free = freeMemoryFn();
  } catch (error) {
    return probeOutcome({ probe: 'host-headroom', ok: false, reason: 'ollama-headroom-unreadable', detail: error.message });
  }
  if (!Number.isFinite(free)) return probeOutcome({ probe: 'host-headroom', ok: false, reason: 'ollama-headroom-unreadable' });
  if (Number(minFreeMemoryBytes) > 0 && free < Number(minFreeMemoryBytes)) {
    return probeOutcome({
      probe: 'host-headroom',
      ok: false,
      reason: 'ollama-insufficient-host-headroom',
      detail: `free=${free} min=${minFreeMemoryBytes}`,
    });
  }
  return probeOutcome({ probe: 'host-headroom', ok: true, detail: `free=${free}` });
}

/**
 * Settings gate, then every probe in strict sequence (never `Promise.all`) —
 * one adapter dispatch decision at a time, matching the runner's serial
 * global execution model. Stops at the first failing probe, so an absent
 * executable never spends a network round trip on endpoint/model checks.
 * Returns `probes: []` and calls none of the injected I/O functions when the
 * agent is not routable, which is itself the zero-mutation/zero-model-call
 * proof for the disabled-by-default path.
 */
export async function admitOllamaDispatch({
  env = process.env,
  model = null,
  settings,
  accessFn,
  execFileFn,
  fetchFn,
  freeMemoryFn,
} = {}) {
  const resolvedSettings = settings || getAgentSettings({ env, agentId: OLLAMA_AGENT_ID });
  if (!resolvedSettings.routable) {
    return {
      allowed: false,
      scope: FAILURE_SCOPES.MACHINE_PROFILE,
      reason: resolvedSettings.reason,
      failedProbe: null,
      detail: null,
      safeNextAction: 'Enable ollama-agent explicitly (enabled:true, disabled:false, not paused/draining) in machine-local agent settings before dispatch.',
      probes: [],
    };
  }

  const entry = isPlainObject(resolvedSettings.entry) ? resolvedSettings.entry : {};
  const executable = resolveOllamaExecutablePath(entry);
  const endpoint = resolveOllamaEndpoint(entry);
  const outcomes = [];

  outcomes.push(executable.ok
    ? probeExecutable({ executablePath: executable.path, accessFn })
    : probeOutcome({ probe: 'executable', ok: false, reason: executable.reason }));

  if (outcomes.at(-1).ok) {
    outcomes.push(probeVersion({ executablePath: executable.path, execFileFn }));
  }

  if (outcomes.every((outcome) => outcome.ok)) {
    outcomes.push(endpoint.ok
      ? await probeEndpoint({ endpointUrl: endpoint.url, fetchFn })
      : probeOutcome({ probe: 'endpoint', ok: false, reason: endpoint.reason }));
  }

  if (outcomes.every((outcome) => outcome.ok)) {
    outcomes.push(await probeInstalledModel({
      model,
      installedModelAllowlist: entry.installedModelAllowlist,
      endpointUrl: endpoint.url,
      fetchFn,
    }));
  }

  if (outcomes.every((outcome) => outcome.ok)) {
    outcomes.push(probeHostHeadroom({ minFreeMemoryBytes: entry.minFreeMemoryBytes, freeMemoryFn }));
  }

  return { ...foldProbeOutcomes(outcomes), probes: outcomes };
}

export const OPENCODE_RUN_SUBCOMMAND = 'run';

/**
 * Build the runtime-only OpenCode provider configuration for a local Ollama
 * dispatch. OpenCode 1.18.4 exposes provider base URLs through configuration,
 * not a run-subcommand flag. The enabled-provider allowlist is deliberately
 * closed to `ollama` so an existing global/project cloud provider cannot
 * become an implicit fallback for this local zero-provider-cost route.
 *
 * The returned value is JSON text suitable for OPENCODE_CONFIG_CONTENT. It
 * contains no credential, auth, session, cloud-provider, download, refresh,
 * or fallback field.
 */
export function buildOpenCodeLocalOllamaConfig({
  model,
  endpointUrl,
  endpointAllowlistHosts = [],
} = {}) {
  if (!model) throw new Error('buildOpenCodeLocalOllamaConfig requires a model');
  const endpoint = resolveOllamaEndpoint({
    endpoint: endpointUrl,
    endpointAllowlistHosts,
  });
  if (!endpoint.ok) {
    throw new Error(`buildOpenCodeLocalOllamaConfig rejected endpoint: ${endpoint.reason}`);
  }

  const baseURL = new URL('/v1', endpoint.url).toString().replace(/\/$/, '');
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    enabled_providers: ['ollama'],
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: { baseURL },
        models: {
          [model]: { name: model },
        },
      },
    },
  });
}

/**
 * Bounded OpenCode 1.18.4 run-command construction.
 *
 * The live Dell help surface proves `run` supports `--model`,
 * `--format json`, and `--dir`; interactive mode defaults false. Provider
 * endpoint selection belongs in buildOpenCodeLocalOllamaConfig(), not argv.
 * There is no concurrency, pull/download, refresh, share, attach, session,
 * fallback-provider, or interactive flag here.
 */
export function buildOpenCodeCommandArgs({
  executablePath,
  model,
  workingDirectory,
  prompt,
} = {}) {
  if (!executablePath) throw new Error('buildOpenCodeCommandArgs requires an executable path');
  if (!model) throw new Error('buildOpenCodeCommandArgs requires a model');
  if (!workingDirectory) throw new Error('buildOpenCodeCommandArgs requires a working directory');
  if (!prompt) throw new Error('buildOpenCodeCommandArgs requires a prompt');
  return [
    executablePath,
    OPENCODE_RUN_SUBCOMMAND,
    '--model', `ollama/${model}`,
    '--format', 'json',
    '--dir', workingDirectory,
    prompt,
  ];
}

/**
 * Parse OpenCode's structured JSON result into the shared normalized
 * adapter-result contract. Assumed foundation-level contract shape
 * (`{ status: 'ok'|'no-op'|'error', output, error, mutated }`) — see the
 * "Known limitations" note in docs/ops for why this has not yet been
 * verified against a live captured OpenCode payload.
 */
function extractOllamaStructuredUsage(parsed) {
  if (!isPlainObject(parsed)) return null;
  const source = isPlainObject(parsed.usage) ? parsed.usage : parsed;
  const usage = {
    prompt_eval_count: source.prompt_eval_count,
    prompt_eval_duration: source.prompt_eval_duration,
    eval_count: source.eval_count,
    load_duration: source.load_duration,
    total_duration: source.total_duration,
  };
  return Object.values(usage).some((value) => value !== undefined) ? usage : null;
}

export function parseOpenCodeResultEnvelope(stdout = '', { agentId = OLLAMA_AGENT_ID, model = null } = {}) {
  const text = String(stdout || '').trim();
  if (!text) {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'ollama-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: '',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'ollama-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: text,
    });
  }

  if (!isPlainObject(parsed) || typeof parsed.status !== 'string') {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'ollama-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: text,
    });
  }

  const structuredUsage = extractOllamaStructuredUsage(parsed);
  const usageEfficiency = structuredUsage
    ? normalizeOllamaUsageEfficiency({ usage: structuredUsage, model })
    : null;

  if (parsed.status === 'no-op') {
    return normalizedAdapterResult({
      ok: true,
      agentId,
      resultText: String(parsed.output || ''),
      reason: 'no-op',
      usageEfficiency,
      mutatedRepository: false,
    });
  }

  if (parsed.status === 'ok') {
    return normalizedAdapterResult({
      ok: true,
      agentId,
      resultText: String(parsed.output || ''),
      usageEfficiency,
      mutatedRepository: Boolean(parsed.mutated),
    });
  }

  return normalizedAdapterResult({
    ok: false,
    agentId,
    reason: String(parsed.error || 'ollama-run-failed'),
    failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
    resultText: String(parsed.output || ''),
    usageEfficiency,
  });
}

/**
 * Classify a process-level execution outcome (timeout/cancellation) that
 * never produced parseable OpenCode output. Callers normalize their own
 * process wrapper's error into this shape; no child-process spawning lives
 * in this foundation-only module.
 */
export function classifyOpenCodeExecutionError({ timedOut = false, cancelled = false, signal = null, code = null, message = '' } = {}) {
  if (cancelled) {
    return normalizedAdapterResult({ ok: false, reason: 'ollama-cancelled', failureScope: FAILURE_SCOPES.TASK_ATTEMPT, resultText: message, structuredFailure: signal || code || null });
  }
  if (timedOut) {
    return normalizedAdapterResult({ ok: false, reason: 'ollama-timeout', failureScope: FAILURE_SCOPES.TASK_ATTEMPT, resultText: message, structuredFailure: signal || code || null });
  }
  return normalizedAdapterResult({ ok: false, reason: 'ollama-execution-error', failureScope: FAILURE_SCOPES.TASK_ATTEMPT, resultText: message, structuredFailure: code || signal || null });
}

export { zeroSpendEnvelope };
