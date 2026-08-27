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
 * or fallback field. Sharing is disabled and both default/small-model
 * selections are pinned to the same local Ollama model. When
 * `disableReasoning` is true, OpenCode 1.18.4 receives the model-level
 * `reasoningEffort: "none"` request option; its OpenAI-compatible lowerer
 * serializes that as `reasoning_effort: "none"`. The similarly named
 * `--thinking` CLI flag only controls display of reasoning blocks and is
 * deliberately not used as a generation control.
 */
export function buildOpenCodeLocalOllamaConfig({
  model,
  endpointUrl,
  endpointAllowlistHosts = [],
  disableReasoning = false,
} = {}) {
  if (!model) throw new Error('buildOpenCodeLocalOllamaConfig requires a model');
  if (typeof disableReasoning !== 'boolean') {
    throw new Error('buildOpenCodeLocalOllamaConfig requires disableReasoning to be boolean');
  }
  const endpoint = resolveOllamaEndpoint({
    endpoint: endpointUrl,
    endpointAllowlistHosts,
  });
  if (!endpoint.ok) {
    throw new Error(`buildOpenCodeLocalOllamaConfig rejected endpoint: ${endpoint.reason}`);
  }

  const baseURL = new URL('/v1', endpoint.url).toString().replace(/\/$/, '');
  const modelConfig = disableReasoning
    ? { name: model, options: { reasoningEffort: 'none' } }
    : { name: model };
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    enabled_providers: ['ollama'],
    model: `ollama/${model}`,
    small_model: `ollama/${model}`,
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: { baseURL },
        models: {
          [model]: modelConfig,
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


const OPENCODE_WORKTREE_PATH_PATTERN = /^[A-Za-z0-9._*?/-]{1,512}$/;
const OLLAMA_SHELL_METACHARACTERS = /[;&|><\`$(){}\n\r]/;
const OLLAMA_DANGEROUS_SHELL = /^(?:sudo|su|systemctl|service|docker|podman|ssh|scp|sftp|curl|wget|nc|ncat|telnet|apt|apt-get|dnf|yum|pacman|snap|flatpak|npx)\b/i;
const OLLAMA_INTERPRETER_ESCAPE = /^(?:bash|sh|zsh)\s+(?:-[^\s]*c\b|--command\b)|^(?:node|python|python3|perl|ruby)\s+(?:-e\b|-c\b|--eval\b)/i;
const OLLAMA_DESTRUCTIVE_GIT = /^git\s+(?:reset|clean|stash|rebase|push|pull|merge|cherry-pick|revert|checkout|switch|branch|tag|remote|config|gc|prune|worktree)\b/i;
export const DEFAULT_OLLAMA_CODING_SHELL_ALLOWLIST = Object.freeze([
  'pwd',
  'git status',
  'git status --short',
  'git status --porcelain',
  'git status --porcelain=v1',
  'git diff',
  'git diff --check',
  'git diff --stat',
  'git diff --name-only',
  'git diff -- *',
  'git diff HEAD -- *',
  'git log --oneline -n 20',
  'git log --oneline -n 50',
  'git show --stat HEAD',
  'git rev-parse HEAD',
  'git rev-parse --show-toplevel',
]);
const OLLAMA_FIXED_INSPECTION_SHELL = new Set(DEFAULT_OLLAMA_CODING_SHELL_ALLOWLIST);

function normalizeOpenCodeWorktreePathPattern(value) {
  const path = String(value || '').trim();
  if (!path || !OPENCODE_WORKTREE_PATH_PATTERN.test(path)) return null;
  if (path.startsWith('/') || path.startsWith('../') || path.includes('/../') || path === '..') return null;
  if (path === '.git' || path.startsWith('.git/') || path.includes('/.git/')) return null;
  return path;
}

export function isSafeOllamaShellPattern(value) {
  const pattern = String(value || '').trim();
  if (!pattern || pattern.length > 4096) return false;
  if (OLLAMA_SHELL_METACHARACTERS.test(pattern)) return false;
  if (pattern.includes('..')) return false;
  if (OLLAMA_DANGEROUS_SHELL.test(pattern)) return false;
  if (OLLAMA_INTERPRETER_ESCAPE.test(pattern)) return false;
  if (OLLAMA_DESTRUCTIVE_GIT.test(pattern)) return false;
  if (OLLAMA_FIXED_INSPECTION_SHELL.has(pattern)) return true;
  if (pattern.startsWith('git ')) return false;

  const first = pattern.split(/\s+/)[0].toLowerCase();
  if (first === 'bash') {
    return /^bash\s+[A-Za-z0-9._/-]+(?:\s+[A-Za-z0-9._:=/@%+,-]+)*$/.test(pattern)
      && !pattern.includes('*') && !pattern.includes('?');
  }
  if (first === 'node') {
    return /^node\s+(?:--test\s+)?[A-Za-z0-9._/*?/-]+(?:\s+[A-Za-z0-9._:=/@%+,*?-]+)*$/.test(pattern);
  }
  if (['npm', 'pnpm', 'yarn'].includes(first)) {
    return /^(?:npm|pnpm|yarn)\s+(?:run\s+[A-Za-z0-9:._-]+|test)(?:\s+[A-Za-z0-9._:=/@%+,*?/-]+)*$/.test(pattern);
  }
  return false;
}

/**
 * OpenCode 1.x coding profile: model edits stay inside manager-authorised
 * worktree paths while shell is default-deny with a narrow positive allowlist.
 * This is intentionally different from the text-only documentation profile:
 * the coding model may inspect Git state and run reviewed test/build commands,
 * but cannot obtain arbitrary host shell, external-directory, network-download,
 * privileged service, destructive-Git, push/merge, or interpreter-eval authority.
 */
export function buildOpenCodeCodingLocalOllamaConfig({
  allowedEditPaths = [],
  shellAllowlist = [],
  ...providerOptions
} = {}) {
  if (!Array.isArray(allowedEditPaths) || allowedEditPaths.length === 0 || allowedEditPaths.length > 64) {
    throw new Error('buildOpenCodeCodingLocalOllamaConfig requires 1..64 allowedEditPaths');
  }
  if (!Array.isArray(shellAllowlist) || shellAllowlist.length > 64) {
    throw new Error('buildOpenCodeCodingLocalOllamaConfig requires <=64 shellAllowlist entries');
  }

  const normalizedPaths = allowedEditPaths.map(normalizeOpenCodeWorktreePathPattern);
  if (normalizedPaths.some((path) => !path) || new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new Error('buildOpenCodeCodingLocalOllamaConfig rejected an unsafe or duplicate edit path');
  }
  const normalizedShell = shellAllowlist.map((entry) => String(entry || '').trim());
  if (normalizedShell.some((entry) => !isSafeOllamaShellPattern(entry)) || new Set(normalizedShell).size !== normalizedShell.length) {
    throw new Error('buildOpenCodeCodingLocalOllamaConfig rejected an unsafe or duplicate shell pattern');
  }

  const config = JSON.parse(buildOpenCodeLocalOllamaConfig(providerOptions));
  config.permission = {
    '*': 'deny',
    read: {
      '*': 'allow',
      '.env': 'deny',
      '.env.*': 'deny',
      '**/.env': 'deny',
      '**/.env.*': 'deny',
    },
    glob: 'allow',
    grep: 'allow',
    edit: Object.fromEntries([
      ['*', 'deny'],
      ...normalizedPaths.map((path) => [path, 'allow']),
    ]),
    bash: Object.fromEntries([
      ['*', 'deny'],
      ...normalizedShell.map((pattern) => [pattern, 'allow']),
    ]),
    external_directory: { '*': 'deny' },
    webfetch: 'deny',
    task: 'deny',
  };
  return JSON.stringify(config);
}

export const OPENCODE_DOCUMENT_START = '<modelspend-document>';
export const OPENCODE_DOCUMENT_END = '</modelspend-document>';
export const DEFAULT_DOCUMENT_OUTPUT_MAX_BYTES = 64 * 1024;

/**
 * Documentation profiles use OpenCode/Ollama as a text generator only.
 *
 * Dell field qualification proved the local provider/model/session path with
 * every permission denied. Keeping the model tool-free avoids coupling safe
 * documentation routing to model-specific tool-call support. The caller owns
 * the exact allowlisted file path and applies validated text deterministically.
 */
export function buildOpenCodeTextOnlyLocalOllamaConfig(options = {}) {
  const config = JSON.parse(buildOpenCodeLocalOllamaConfig(options));
  config.permission = { '*': 'deny' };
  return JSON.stringify(config);
}

/**
 * Accept one bounded full-document proposal without making presentation
 * wrappers part of the authority boundary.
 *
 * The model never receives write authority. Callers must still enforce the
 * approved path, repository/worktree ownership, before/after bytes and normal
 * validation before writing the returned content. When expectedContent is
 * supplied, only one exact occurrence is accepted and only those expected
 * bytes are returned.
 */
export function parseBoundedDocumentationContent(resultText = '', {
  maxBytes = DEFAULT_DOCUMENT_OUTPUT_MAX_BYTES,
  expectedContent = null,
} = {}) {
  const text = String(resultText || '');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('parseBoundedDocumentationContent requires a positive integer maxBytes');
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { ok: false, reason: 'ollama-document-output-too-large', content: null };
  }
  if (text.includes('\u0000')) {
    return { ok: false, reason: 'ollama-document-output-invalid', content: null };
  }

  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return { ok: false, reason: 'ollama-document-output-empty', content: null };
  }

  if (expectedContent !== null && expectedContent !== undefined) {
    const expected = String(expectedContent).replace(/\r\n?/g, '\n').trim();
    if (!expected || expected.includes('\u0000') || Buffer.byteLength(expected, 'utf8') > maxBytes) {
      throw new Error('parseBoundedDocumentationContent received an invalid expectedContent');
    }

    let matches = 0;
    let offset = 0;
    while (offset <= normalized.length) {
      const found = normalized.indexOf(expected, offset);
      if (found === -1) break;
      matches += 1;
      offset = found + Math.max(expected.length, 1);
    }

    if (matches === 1) {
      return { ok: true, reason: null, content: expected };
    }

    return {
      ok: false,
      reason: matches === 0
        ? 'ollama-document-content-mismatch'
        : 'ollama-document-content-ambiguous',
      content: null,
    };
  }

  const startCount = normalized.split(OPENCODE_DOCUMENT_START).length - 1;
  const endCount = normalized.split(OPENCODE_DOCUMENT_END).length - 1;

  if (startCount || endCount) {
    if (startCount !== 1 || endCount !== 1) {
      return { ok: false, reason: 'ollama-document-envelope-invalid', content: null };
    }

    const start = normalized.indexOf(OPENCODE_DOCUMENT_START);
    const bodyStart = start + OPENCODE_DOCUMENT_START.length;
    const end = normalized.indexOf(OPENCODE_DOCUMENT_END, bodyStart);
    if (end < bodyStart) {
      return { ok: false, reason: 'ollama-document-envelope-invalid', content: null };
    }

    const body = normalized.slice(bodyStart, end).replace(/^\n/, '').replace(/\n$/, '');
    if (!body) {
      return { ok: false, reason: 'ollama-document-output-empty', content: null };
    }
    return { ok: true, reason: null, content: body };
  }

  const fenced = normalized.match(/^\`\`\`(?:markdown|md|text)?\s*\n([\s\S]*?)\n\`\`\`$/i);
  if (fenced) {
    const body = fenced[1].trim();
    if (!body) {
      return { ok: false, reason: 'ollama-document-output-empty', content: null };
    }
    return { ok: true, reason: null, content: body };
  }

  return { ok: true, reason: null, content: normalized };
}

/**
 * Accept one bounded documentation replacement directive while keeping all
 * filesystem authority in the deterministic supervising harness.
 *
 * The expected replacement is programme/harness-owned. The model may surround
 * it with harmless prose or Markdown; qualification succeeds only when the
 * exact replacement occurs once in bounded, NUL-free model output.
 */
export function parseBoundedDocumentationReplacement(resultText = '', {
  expectedReplacement,
  maxBytes = DEFAULT_DOCUMENT_OUTPUT_MAX_BYTES,
} = {}) {
  const text = String(resultText || '');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('parseBoundedDocumentationReplacement requires a positive integer maxBytes');
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { ok: false, reason: 'ollama-document-replacement-output-too-large', replacement: null };
  }
  if (text.includes('\u0000')) {
    return { ok: false, reason: 'ollama-document-replacement-output-invalid', replacement: null };
  }

  const expected = String(expectedReplacement ?? '').replace(/\r\n?/g, '\n').trim();
  if (
    !expected
    || expected.includes('\u0000')
    || expected.includes('\n')
    || Buffer.byteLength(expected, 'utf8') > maxBytes
  ) {
    throw new Error('parseBoundedDocumentationReplacement requires one bounded non-empty replacement line');
  }

  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return { ok: false, reason: 'ollama-document-replacement-output-empty', replacement: null };
  }

  let matches = 0;
  let offset = 0;
  while (offset <= normalized.length) {
    const found = normalized.indexOf(expected, offset);
    if (found === -1) break;
    matches += 1;
    offset = found + expected.length;
  }

  if (matches === 1) {
    return { ok: true, reason: null, replacement: expected };
  }

  return {
    ok: false,
    reason: matches === 0
      ? 'ollama-document-replacement-mismatch'
      : 'ollama-document-replacement-ambiguous',
    replacement: null,
  };
}

/**
 * OpenCode 1.18.4 `run --format json` emits newline-delimited event objects,
 * not the foundation's historical single result envelope. Keep the legacy
 * envelope parser for compatibility, but prefer the verified JSONL contract.
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

function safeOpenCodeErrorName(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(text) ? text : 'unknown';
}

export function parseOpenCodeJsonEventStream(stdout = '', {
  agentId = OLLAMA_AGENT_ID,
  model = null,
} = {}) {
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

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events = [];
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return normalizedAdapterResult({
        ok: false,
        agentId,
        reason: 'ollama-invalid-output',
        failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
        resultText: '',
      });
    }
    if (!isPlainObject(event) || typeof event.type !== 'string') {
      return normalizedAdapterResult({
        ok: false,
        agentId,
        reason: 'ollama-invalid-output',
        failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
        resultText: '',
      });
    }
    events.push(event);
  }

  const errors = events.filter((event) => event.type === 'error');
  if (errors.length) {
    const name = safeOpenCodeErrorName(
      errors[0]?.error?.name
      ?? errors[0]?.error?.data?.name
      ?? errors[0]?.name,
    );
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: `ollama-opencode-error:${name}`,
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: '',
    });
  }

  const textParts = events
    .filter((event) => event.type === 'text' && typeof event?.part?.text === 'string')
    .map((event) => event.part.text);

  if (!textParts.length) {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'ollama-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: '',
    });
  }

  const stepFinish = events.findLast((event) => event.type === 'step_finish');
  const structuredUsage = extractOllamaStructuredUsage(stepFinish?.part);
  const usageEfficiency = structuredUsage
    ? normalizeOllamaUsageEfficiency({ usage: structuredUsage, model })
    : null;

  return normalizedAdapterResult({
    ok: true,
    agentId,
    resultText: textParts.join('\n'),
    usageEfficiency,
    mutatedRepository: false,
  });
}

export function parseOpenCodeResultEnvelope(stdout = '', {
  agentId = OLLAMA_AGENT_ID,
  model = null,
} = {}) {
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

  // Verified live OpenCode 1.18.4 event stream.
  if (text.includes('\n')) {
    return parseOpenCodeJsonEventStream(text, { agentId, model });
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
      resultText: '',
    });
  }

  if (isPlainObject(parsed) && typeof parsed.type === 'string') {
    return parseOpenCodeJsonEventStream(text, { agentId, model });
  }

  // Backward-compatible foundation envelope; no live routing depends on it.
  if (!isPlainObject(parsed) || typeof parsed.status !== 'string') {
    return normalizedAdapterResult({
      ok: false,
      agentId,
      reason: 'ollama-invalid-output',
      failureScope: FAILURE_SCOPES.TASK_ATTEMPT,
      resultText: '',
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
