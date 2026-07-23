import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const DEFAULT_SETTINGS_RELATIVE = '.config/agent-runner/agent-settings.json';

/**
 * Fail-closed lifecycle defaults. An agent id with no settings file, no
 * entry, a malformed entry, or a malformed settings file is fully
 * non-routable: not enabled, and explicitly disabled.
 */
export const SAFE_DEFAULT_AGENT_LIFECYCLE = Object.freeze({
  enabled: false,
  paused: false,
  draining: false,
  disabled: true,
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resolveAgentSettingsPath(env = process.env) {
  const home = String(env.HOME || homedir());
  const raw = String(env.AGENT_RUNNER_AGENT_SETTINGS_PATH || '').trim();
  if (!raw) return resolve(home, DEFAULT_SETTINGS_RELATIVE);
  return isAbsolute(raw) ? raw : resolve(home, raw);
}

function readSettingsFile(path, { fileExists, readFile }) {
  if (!fileExists(path)) return { fileFound: false, raw: null, parseError: null };
  try {
    const parsed = JSON.parse(readFile(path, 'utf8'));
    if (!isPlainObject(parsed)) return { fileFound: true, raw: null, parseError: 'agent settings file must contain a JSON object' };
    return { fileFound: true, raw: parsed, parseError: null };
  } catch (error) {
    return { fileFound: true, raw: null, parseError: error.message };
  }
}

/**
 * Normalize the lifecycle-relevant fields only. Any non-boolean value fails
 * closed to the safe default for that field rather than being coerced.
 */
export function normalizeAgentLifecycle(entry) {
  if (!isPlainObject(entry)) return { ...SAFE_DEFAULT_AGENT_LIFECYCLE };
  return {
    enabled: entry.enabled === true,
    paused: entry.paused === true,
    draining: entry.draining === true,
    disabled: entry.disabled === false ? false : true,
  };
}

export function isAgentRoutable(lifecycle) {
  return Boolean(lifecycle?.enabled) && !lifecycle?.paused && !lifecycle?.draining && !lifecycle?.disabled;
}

function routabilityReason(lifecycle) {
  if (lifecycle.disabled) return 'agent-disabled';
  if (!lifecycle.enabled) return 'agent-not-enabled';
  if (lifecycle.paused) return 'agent-paused';
  if (lifecycle.draining) return 'agent-draining';
  return 'agent-routable';
}

/**
 * Load one agent's machine-local settings entry. This never contacts the
 * network, spawns a process, or invokes a model; it only reads and parses a
 * local JSON file. Extra adapter-specific fields on the raw entry (for
 * example an executable path or endpoint allowlist) are returned verbatim
 * under `raw` for the owning adapter module to interpret.
 */
export function getAgentSettings({
  env = process.env,
  agentId,
  settingsPath = resolveAgentSettingsPath(env),
  fileExists = existsSync,
  readFile = readFileSync,
} = {}) {
  if (!agentId) throw new Error('getAgentSettings requires an agentId');
  const { fileFound, raw, parseError } = readSettingsFile(settingsPath, { fileExists, readFile });
  const entry = parseError ? null : raw?.agents?.[agentId];
  const lifecycle = normalizeAgentLifecycle(entry);
  const routable = !parseError && isAgentRoutable(lifecycle);
  return {
    agentId,
    settingsPath,
    fileFound,
    parseError,
    entry: parseError ? null : (isPlainObject(entry) ? entry : null),
    lifecycle,
    routable,
    reason: parseError ? 'agent-settings-parse-error' : routabilityReason(lifecycle),
  };
}

/**
 * Machine-local settings example payload, also used to render
 * `.agent-runner/agent-settings.example.json`. Kept here so the documented
 * shape and the loader's field names cannot drift apart.
 */
export const AGENT_SETTINGS_EXAMPLE = Object.freeze({
  agents: Object.freeze({
    'ollama-agent': Object.freeze({
      enabled: false,
      paused: false,
      draining: false,
      disabled: true,
      executablePath: null,
      endpoint: 'http://127.0.0.1:11434',
      endpointAllowlistHosts: Object.freeze([]),
      installedModelAllowlist: Object.freeze([]),
      minFreeMemoryBytes: 2147483648,
    }),
  }),
});
