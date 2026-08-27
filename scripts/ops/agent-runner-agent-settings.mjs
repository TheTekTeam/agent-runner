import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const DEFAULT_SETTINGS_RELATIVE = '.config/agent-runner/agent-settings.json';

// claude-code-cli's agent id. Note that once a machine-local settings
// document is present (the multi-agent selector is "engaged" -- see
// claude-runner-cron.mjs's engageMultiAgentSelector()), claude-code-cli is
// held to the exact same fail-closed lifecycle/qualification defaults as
// every other agent id below: an absent or malformed entry is unqualified
// and non-routable, with no implicit wildcard/enabled fallback. When no
// settings document exists at all, the selector is never engaged and the
// pre-issue-#50 legacy Claude execution path (which never reads this file)
// is untouched.
const CLAUDE_AGENT_ID = 'claude-code-cli';

const WILDCARD = '*';
const SAFE_DEFAULT_QUALIFICATION = Object.freeze({
  taskClasses: Object.freeze([]),
  riskClasses: Object.freeze([]),
  models: Object.freeze([]),
  harness: null,
});

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
      openCodeExecutablePath: null,
      model: null,
      endpoint: 'http://127.0.0.1:11434',
      endpointAllowlistHosts: Object.freeze([]),
      installedModelAllowlist: Object.freeze([]),
      minFreeMemoryBytes: 2147483648,
      // Issue #50: explicit, conservative qualification only -- Ollama is
      // never eligible outside these named low-risk classes regardless of
      // routing logic (the selector additionally hard-clamps ollama-agent to
      // riskClasses containing only "low"; this field cannot widen that).
      qualification: Object.freeze({
        taskClasses: Object.freeze([]),
        riskClasses: Object.freeze(['low']),
        models: Object.freeze([]),
        harness: null,
      }),
    }),
    'codex-cli': Object.freeze({
      enabled: false,
      paused: false,
      draining: false,
      disabled: true,
      executablePath: null,
      sandboxMode: 'workspace-write',
      approvalMode: 'on-request',
      model: null,
      reasoningEffort: null,
      paidUseApproved: false,
      // Issue #50: a future implemented paid adapter is still never an
      // automatic fallback unless this is explicitly flipped true alongside
      // paidUseApproved and a positive cost/token cap. Committed examples
      // must keep this false.
      automaticRoutingApproved: false,
      maxCostUsdPerRun: 0,
      maxTokensPerRun: 0,
      sessionSecretRef: null,
      qualification: Object.freeze({
        taskClasses: Object.freeze([]),
        riskClasses: Object.freeze([]),
        models: Object.freeze([]),
        harness: null,
      }),
    }),
    'grok-cli': Object.freeze({
      enabled: false,
      paused: false,
      draining: false,
      disabled: true,
      executablePath: null,
      model: null,
      // Bounded, caller-enforced process deadline for a future live
      // executor (the installed Grok CLI has no --timeout flag of its own).
      // Integer milliseconds, 1_000..3_600_000 -- the same range
      // agent-runner-control-instances.mjs's validateTimeoutValue() already
      // enforces for every other adapter. 300_000 (5 minutes) is a
      // conservative example given maxToolRounds:50 below, well under the
      // installed CLI's own --max-tool-rounds default of 400.
      timeout: 300000,
      maxToolRounds: 50,
      paidUseApproved: false,
      automaticRoutingApproved: false,
      maxCostUsdPerRun: 0,
      maxTokensPerRun: 0,
      sessionSecretRef: null,
      qualification: Object.freeze({
        taskClasses: Object.freeze([]),
        riskClasses: Object.freeze([]),
        models: Object.freeze([]),
        harness: null,
      }),
    }),
  }),
});

// Sink hardening (issue #50 review): every qualification/classification
// identifier -- whether read from a machine-local settings file or from an
// issue's own label/field text -- is bounded to this one closed, safe token
// grammar before it can ever reach a decision, log, SQLite row, or GitHub
// comment. A value that fails this grammar is dropped, never coerced or
// truncated into something that still looks plausible. This is the single
// shared normalizer `agent-runner-qualification.mjs#classifyIssueTaskRisk()`
// also uses for issue task/risk/model/harness classification, so settings
// qualification and issue classification can never drift onto two different
// bounds.
const QUALIFICATION_TOKEN_MAX_LENGTH = 64;
const QUALIFICATION_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isSafeQualificationToken(value) {
  return value === WILDCARD || (
    typeof value === 'string'
    && value.length > 0
    && value.length <= QUALIFICATION_TOKEN_MAX_LENGTH
    && QUALIFICATION_TOKEN_PATTERN.test(value)
  );
}

/**
 * Normalize one caller-supplied value against the shared safe-token
 * grammar: trims a string and returns it unchanged when it passes, or
 * `null` when it is missing, not a string, or fails the grammar (too long,
 * empty, control characters, unsafe punctuation) -- never a truncated or
 * coerced approximation of the original value.
 */
export function normalizeSafeToken(value, { allowWildcard = false } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!allowWildcard && trimmed === WILDCARD) return null;
  return isSafeQualificationToken(trimmed) ? trimmed : null;
}

function normalizeBoundedTokenList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value
    .map((item) => normalizeSafeToken(typeof item === 'string' ? item : String(item ?? ''), { allowWildcard: true }))
    .filter(Boolean);
  return Object.freeze(cleaned.length ? cleaned : []);
}

function normalizeBoundedHarnessValue(value, fallback) {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  return normalizeSafeToken(value, { allowWildcard: true }) || fallback;
}

/**
 * Sanitized, bounded qualification view for one agent entry. Only the four
 * closed-shape fields below are ever read from `entry.qualification` --
 * nothing else on the raw entry (executablePath, endpoint, sessionSecretRef,
 * etc.) is ever copied into this or any downstream decision/log/snapshot.
 */
export function normalizeAgentQualification(agentId, entry) {
  const fallback = SAFE_DEFAULT_QUALIFICATION;
  const raw = isPlainObject(entry) && isPlainObject(entry.qualification) ? entry.qualification : null;
  if (!raw) return { ...fallback };
  return {
    taskClasses: normalizeBoundedTokenList(raw.taskClasses, fallback.taskClasses),
    riskClasses: normalizeBoundedTokenList(raw.riskClasses, fallback.riskClasses),
    models: normalizeBoundedTokenList(raw.models, fallback.models),
    harness: normalizeBoundedHarnessValue(raw.harness, fallback.harness),
  };
}

/**
 * Sanitized, bounded paid-use policy view. Only booleans/numbers are read;
 * `sessionSecretRef` and any other credential-shaped field never crosses
 * into this view.
 */
export function normalizeAgentPaidUsePolicy(entry) {
  const paidUseApproved = isPlainObject(entry) && entry.paidUseApproved === true;
  const automaticRoutingApproved = isPlainObject(entry) && entry.automaticRoutingApproved === true;
  const maxCostUsdPerRun = isPlainObject(entry) && Number.isFinite(Number(entry.maxCostUsdPerRun)) ? Number(entry.maxCostUsdPerRun) : 0;
  const maxTokensPerRun = isPlainObject(entry) && Number.isFinite(Number(entry.maxTokensPerRun)) ? Number(entry.maxTokensPerRun) : 0;
  return {
    paidUseApproved,
    automaticRoutingApproved,
    hasPositiveCap: maxCostUsdPerRun > 0 || maxTokensPerRun > 0,
  };
}

function normalizeLifecycleForAgent(_agentId, entry) {
  if (!isPlainObject(entry)) return { ...SAFE_DEFAULT_AGENT_LIFECYCLE };
  return {
    enabled: entry.enabled === true,
    paused: entry.paused === true,
    draining: entry.draining === true,
    disabled: entry.disabled === false ? false : true,
  };
}

const RUNTIME_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export function normalizeAgentRuntimeModel(agentId, entry) {
  if (agentId !== 'ollama-agent' || !isPlainObject(entry)) return null;
  const model = String(entry.model || '').trim();
  return RUNTIME_MODEL_PATTERN.test(model) ? model : null;
}

function sanitizedSnapshotEntry(agentId, entry) {
  const lifecycle = normalizeLifecycleForAgent(agentId, entry);
  return Object.freeze({
    agentId,
    lifecycle: Object.freeze(lifecycle),
    routable: isAgentRoutable(lifecycle),
    qualification: Object.freeze(normalizeAgentQualification(agentId, entry)),
    runtimeModel: normalizeAgentRuntimeModel(agentId, entry),
    paidUse: Object.freeze(normalizeAgentPaidUsePolicy(entry)),
  });
}

export function computeSettingsRevision(exactBytes) {
  return `sha256:${createHash('sha256').update(String(exactBytes)).digest('hex')}`;
}

/**
 * Whole-file, single-read, atomic machine-local settings snapshot (issue
 * #50, "atomic machine-local settings snapshot"). The file is read exactly
 * once; the immutable SHA-256 revision is computed over those exact bytes
 * and the JSON is parsed from that same string, so the revision can never
 * drift from what was actually normalized. Only the bounded, sanitized
 * per-agent view built by `sanitizedSnapshotEntry()` is returned -- the raw
 * document, executable paths, endpoints, secret references, credentials and
 * session material never appear in the returned value, so callers cannot
 * accidentally leak them into a decision, log, SQLite row, GitHub comment,
 * or test snapshot.
 *
 * `agentIds` defaults to every id known to the caller-supplied catalogue
 * (pass `Object.keys(AGENT_ADAPTERS)` from `agent-runner-agents.mjs`, kept
 * as a parameter rather than a static import to avoid this settings module
 * ever needing to know the adapter catalogue's shape).
 */
export function snapshotAgentSettings({
  env = process.env,
  settingsPath = resolveAgentSettingsPath(env),
  fileExists = existsSync,
  readFile = readFileSync,
  agentIds = [],
} = {}) {
  const knownAgentIds = Array.from(new Set([...agentIds, CLAUDE_AGENT_ID]));
  const emptyAgents = () => Object.freeze(Object.fromEntries(knownAgentIds.map((id) => [id, sanitizedSnapshotEntry(id, null)])));

  if (!fileExists(settingsPath)) {
    return Object.freeze({
      revision: computeSettingsRevision(''),
      fileFound: false,
      parseError: null,
      agents: emptyAgents(),
    });
  }

  let exactBytes;
  try {
    exactBytes = readFile(settingsPath, 'utf8');
  } catch (error) {
    return Object.freeze({ revision: null, fileFound: true, parseError: `settings-read-error:${error?.code || 'unknown'}`, agents: emptyAgents() });
  }

  const revision = computeSettingsRevision(exactBytes);
  let parsed;
  try {
    parsed = JSON.parse(exactBytes);
  } catch {
    return Object.freeze({ revision, fileFound: true, parseError: 'agent-settings-malformed-json', agents: emptyAgents() });
  }
  if (!isPlainObject(parsed)) {
    return Object.freeze({ revision, fileFound: true, parseError: 'agent-settings-not-an-object', agents: emptyAgents() });
  }

  const agentsDoc = isPlainObject(parsed.agents) ? parsed.agents : {};
  const agents = Object.fromEntries(knownAgentIds.map((id) => [id, sanitizedSnapshotEntry(id, agentsDoc[id])]));
  return Object.freeze({ revision, fileFound: true, parseError: null, agents: Object.freeze(agents) });
}

/**
 * True only when both snapshots are valid, present, whole-file snapshots
 * (fileFound === true, no parseError, a revision present) and their
 * revisions match exactly. Two "file not found" snapshots never count as
 * unchanged -- fileFound must be true on both sides, not merely equal.
 * Any mismatch, missing/false fileFound, missing revision, or parse error
 * on either side fails closed.
 */
export function settingsRevisionUnchanged(snapshotAtSelection, freshSnapshot) {
  if (snapshotAtSelection?.fileFound !== true || freshSnapshot?.fileFound !== true) return false;
  if (!snapshotAtSelection?.revision || !freshSnapshot?.revision) return false;
  if (snapshotAtSelection.parseError || freshSnapshot.parseError) return false;
  return snapshotAtSelection.revision === freshSnapshot.revision;
}

export { CLAUDE_AGENT_ID, WILDCARD as QUALIFICATION_WILDCARD };
