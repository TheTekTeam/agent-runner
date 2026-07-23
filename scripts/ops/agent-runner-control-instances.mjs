import {
  getAgentSettings,
  normalizeAgentLifecycle,
  resolveAgentSettingsPath,
  SAFE_DEFAULT_AGENT_LIFECYCLE,
} from './agent-runner-agent-settings.mjs';
import { AGENT_ADAPTERS, resolveAgentById } from './agent-runner-agents.mjs';
import { appendControlAuditEntry, resolveControlAuditPath } from './agent-runner-control-audit.mjs';
import { loadControlSettingsDocument, replaceControlSettingsDocument } from './agent-runner-control-settings-store.mjs';

/**
 * Registered-agent instance registry (issue #46).
 *
 * An "instance" is one entry, keyed by agent id, in the control settings
 * document's `agents` map. Creation is gated to ids present in the frozen
 * `AGENT_ADAPTERS` catalogue (`agent-runner-agents.mjs`) — there is no path
 * to register an arbitrary/unknown adapter id, executable, or endpoint
 * editor through this module. Updates go through a positive field
 * allowlist (`model`, `profile`, `endpoint`, `timeout`, `maxConcurrency`,
 * `policy`); everything else, including `executablePath` and any future
 * adapter-specific field, is structurally unreachable from this API.
 *
 * `unsupported` (adapter not `implemented`) and `unavailable` (readiness
 * probes failing) are computed at read time in `deriveInstanceState()` and
 * are never accepted as a lifecycle transition target — only `enabled`,
 * `paused`, `draining`, `disabled` are settable, matching the #40 lifecycle
 * contract exactly.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const POLICY_ALLOWED_KEYS = Object.freeze(['requireHumanApproval', 'notes']);
const LIFECYCLE_STATES = Object.freeze(['enabled', 'paused', 'draining', 'disabled']);

export class InstanceAdapterNotApprovedError extends Error {
  constructor(adapterId) {
    super(`adapter id is not in the approved catalogue: ${adapterId}`);
    this.name = 'InstanceAdapterNotApprovedError';
    this.code = 'AGENT_RUNNER_CONTROL_ADAPTER_NOT_APPROVED';
  }
}

export class InstanceAlreadyExistsError extends Error {
  constructor(agentId) {
    super(`instance already exists: ${agentId}`);
    this.name = 'InstanceAlreadyExistsError';
    this.code = 'AGENT_RUNNER_CONTROL_INSTANCE_EXISTS';
  }
}

export class InstanceNotFoundError extends Error {
  constructor(agentId) {
    super(`instance not found: ${agentId}`);
    this.name = 'InstanceNotFoundError';
    this.code = 'AGENT_RUNNER_CONTROL_INSTANCE_NOT_FOUND';
  }
}

export class InstanceUpdateRejectedError extends Error {
  constructor(reason, field = null) {
    super(`instance update rejected (${reason})${field ? `: ${field}` : ''}`);
    this.name = 'InstanceUpdateRejectedError';
    this.code = 'AGENT_RUNNER_CONTROL_INSTANCE_UPDATE_REJECTED';
    this.reason = reason;
    this.field = field;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Loopback-only through this API. A non-loopback endpoint must be edited outside the control service, if at all. */
export function validateEndpointValue(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  const raw = String(value).trim();
  if (!raw) return { ok: true, value: null };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'endpoint-malformed' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'endpoint-malformed' };
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return { ok: false, reason: 'endpoint-not-loopback' };
  return { ok: true, value: parsed.toString() };
}

export function validateTimeoutValue(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1000 || number > 3_600_000) return { ok: false, reason: 'timeout-out-of-range' };
  return { ok: true, value: number };
}

/** Structurally enforces "no multi-worker concurrency": the only accepted value is 1. */
export function validateMaxConcurrencyValue(value) {
  if (value === null || value === undefined) return { ok: true, value: 1 };
  if (value !== 1) return { ok: false, reason: 'max-concurrency-must-be-serial' };
  return { ok: true, value: 1 };
}

export function validateModelValue(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  const raw = String(value);
  if (!MODEL_PATTERN.test(raw)) return { ok: false, reason: 'model-invalid' };
  return { ok: true, value: raw };
}

export function validateProfileValue(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  const raw = String(value);
  if (!PROFILE_PATTERN.test(raw)) return { ok: false, reason: 'profile-invalid' };
  return { ok: true, value: raw };
}

/**
 * A strict, closed allowlist of policy sub-fields. There is no key here
 * (and no path to add one through this API) that can enable paid fallback,
 * automatic routing, or concurrency — those capabilities simply have no
 * writable field, not a field defaulted to off.
 */
export function validatePolicyValue(value) {
  if (value === null || value === undefined) return { ok: true, value: { requireHumanApproval: true } };
  if (!isPlainObject(value)) return { ok: false, reason: 'policy-not-an-object' };
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!POLICY_ALLOWED_KEYS.includes(key)) return { ok: false, reason: 'policy-field-not-allowed', field: key };
  }
  if (value.requireHumanApproval !== undefined && typeof value.requireHumanApproval !== 'boolean') {
    return { ok: false, reason: 'policy-require-human-approval-must-be-boolean' };
  }
  if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 256)) {
    return { ok: false, reason: 'policy-notes-invalid' };
  }
  return {
    ok: true,
    value: {
      requireHumanApproval: value.requireHumanApproval !== false,
      notes: typeof value.notes === 'string' ? value.notes : '',
    },
  };
}

export const ALLOWED_UPDATE_FIELDS = Object.freeze({
  model: validateModelValue,
  profile: validateProfileValue,
  endpoint: validateEndpointValue,
  timeout: validateTimeoutValue,
  maxConcurrency: validateMaxConcurrencyValue,
  policy: validatePolicyValue,
});

/**
 * Apply a positive-allowlist update. Any key outside `ALLOWED_UPDATE_FIELDS`
 * (including `executablePath`, `enabled`/`paused`/`draining`/`disabled` —
 * those go through `applyLifecycleTransition` — or any shell/env/file-path-
 * shaped key) rejects the *entire* update; nothing is applied partially.
 */
export function applyAllowlistedUpdate(entry, updates = {}) {
  if (!isPlainObject(updates)) return { ok: false, reason: 'updates-not-an-object', field: null };
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: false, reason: 'no-fields-provided', field: null };
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_UPDATE_FIELDS, key)) {
      return { ok: false, reason: 'field-not-allowlisted', field: key };
    }
  }
  const nextEntry = { ...(isPlainObject(entry) ? entry : {}) };
  for (const key of keys) {
    const validator = ALLOWED_UPDATE_FIELDS[key];
    const result = validator(updates[key]);
    if (!result.ok) return { ok: false, reason: result.reason, field: key };
    nextEntry[key] = result.value;
  }
  return { ok: true, entry: nextEntry, changedFields: keys };
}

/**
 * Only the four #40 lifecycle states are ever settable. `unsupported` and
 * `unavailable` are not in `LIFECYCLE_STATES` at all, so there is no string
 * a caller could pass that reaches a stored field for either.
 */
export function applyLifecycleTransition(entry, targetState) {
  if (!LIFECYCLE_STATES.includes(targetState)) {
    return { ok: false, reason: 'lifecycle-state-not-allowed' };
  }
  const booleans = {
    enabled: { enabled: true, paused: false, draining: false, disabled: false },
    paused: { enabled: true, paused: true, draining: false, disabled: false },
    draining: { enabled: true, paused: false, draining: true, disabled: false },
    disabled: { enabled: false, paused: false, draining: false, disabled: true },
  }[targetState];
  const nextEntry = { ...(isPlainObject(entry) ? entry : {}), ...booleans };
  return { ok: true, entry: nextEntry, changedFields: ['enabled', 'paused', 'draining', 'disabled'] };
}

/** `unsupported`/`unavailable` are derived overlays, never stored values. */
export function deriveInstanceState({ adapter, lifecycle, readiness = null }) {
  if (!adapter?.implemented) return 'unsupported';
  if (lifecycle.disabled || !lifecycle.enabled) return 'disabled';
  if (lifecycle.draining) return 'draining';
  if (lifecycle.paused) return 'paused';
  if (readiness && readiness.ok === false) return 'unavailable';
  return 'enabled';
}

export function buildInstanceSnapshot({ agentId, adapter, entry, readiness = null }) {
  const lifecycle = normalizeAgentLifecycle(entry);
  return {
    agentId,
    adapterId: adapter?.agentId || agentId,
    adapterType: adapter?.type || null,
    implemented: Boolean(adapter?.implemented),
    created: isPlainObject(entry),
    lifecycle,
    state: deriveInstanceState({ adapter, lifecycle, readiness }),
    model: isPlainObject(entry) ? entry.model ?? null : null,
    profile: isPlainObject(entry) ? entry.profile ?? null : null,
    endpoint: isPlainObject(entry) ? entry.endpoint ?? null : null,
    timeout: isPlainObject(entry) ? entry.timeout ?? null : null,
    maxConcurrency: isPlainObject(entry) && entry.maxConcurrency !== undefined ? entry.maxConcurrency : 1,
    policy: isPlainObject(entry) && isPlainObject(entry.policy) ? entry.policy : { requireHumanApproval: true, notes: '' },
    readiness: readiness ? { ok: readiness.ok, reason: readiness.reason || null, probes: readiness.probes || [] } : null,
  };
}

/** Safe registered-agent reads: the whole approved catalogue, created or not. */
export function listInstanceSnapshots({
  path = resolveAgentSettingsPath(),
  readinessByAgent = {},
} = {}) {
  const { doc } = loadControlSettingsDocument(path);
  return Object.values(AGENT_ADAPTERS).map((adapter) => buildInstanceSnapshot({
    agentId: adapter.agentId,
    adapter,
    entry: doc.agents?.[adapter.agentId] || null,
    readiness: readinessByAgent[adapter.agentId] || null,
  }));
}

export function getInstanceSnapshot({ path = resolveAgentSettingsPath(), agentId, readiness = null } = {}) {
  const adapter = resolveAgentById(agentId);
  const { doc } = loadControlSettingsDocument(path);
  return buildInstanceSnapshot({ agentId, adapter, entry: doc.agents?.[agentId] || null, readiness });
}

function auditWrite({ actor, source, action, revision, changedFields, auditPath }) {
  return appendControlAuditEntry({ actor, source, action, revision, changedFields, path: auditPath });
}

export function createInstance({
  path = resolveAgentSettingsPath(),
  auditPath = resolveControlAuditPath(),
  agentId,
  initialFields = {},
  expectedRevision = null,
  actor,
  source,
} = {}) {
  const adapter = resolveAgentById(agentId);
  if (!adapter) throw new InstanceAdapterNotApprovedError(agentId);
  const { doc } = loadControlSettingsDocument(path);
  if (isPlainObject(doc.agents?.[agentId])) throw new InstanceAlreadyExistsError(agentId);

  const seeded = { ...SAFE_DEFAULT_AGENT_LIFECYCLE, maxConcurrency: 1, policy: { requireHumanApproval: true, notes: '' } };
  let entry = seeded;
  let changedFields = [];
  if (isPlainObject(initialFields) && Object.keys(initialFields).length > 0) {
    const applied = applyAllowlistedUpdate(seeded, initialFields);
    if (!applied.ok) throw new InstanceUpdateRejectedError(applied.reason, applied.field);
    entry = applied.entry;
    changedFields = applied.changedFields;
  }

  const result = replaceControlSettingsDocument({
    path,
    expectedRevision,
    mutate: (agents) => ({ ...agents, [agentId]: entry }),
  });
  auditWrite({ actor, source, action: 'instance.create', revision: result.revision, changedFields: [`agents.${agentId}`, ...changedFields], auditPath });
  return { ...result, snapshot: buildInstanceSnapshot({ agentId, adapter, entry }) };
}

export function updateInstanceSettings({
  path = resolveAgentSettingsPath(),
  auditPath = resolveControlAuditPath(),
  agentId,
  updates,
  expectedRevision = null,
  actor,
  source,
} = {}) {
  const adapter = resolveAgentById(agentId);
  const { doc } = loadControlSettingsDocument(path);
  const currentEntry = doc.agents?.[agentId];
  if (!isPlainObject(currentEntry)) throw new InstanceNotFoundError(agentId);

  const applied = applyAllowlistedUpdate(currentEntry, updates);
  if (!applied.ok) throw new InstanceUpdateRejectedError(applied.reason, applied.field);

  const result = replaceControlSettingsDocument({
    path,
    expectedRevision,
    mutate: (agents) => ({ ...agents, [agentId]: applied.entry }),
  });
  auditWrite({ actor, source, action: 'instance.settings.update', revision: result.revision, changedFields: applied.changedFields.map((field) => `agents.${agentId}.${field}`), auditPath });
  return { ...result, snapshot: buildInstanceSnapshot({ agentId, adapter, entry: applied.entry }) };
}

export function transitionInstanceLifecycle({
  path = resolveAgentSettingsPath(),
  auditPath = resolveControlAuditPath(),
  agentId,
  targetState,
  expectedRevision = null,
  actor,
  source,
} = {}) {
  const adapter = resolveAgentById(agentId);
  const { doc } = loadControlSettingsDocument(path);
  const currentEntry = doc.agents?.[agentId];
  if (!isPlainObject(currentEntry)) throw new InstanceNotFoundError(agentId);

  const applied = applyLifecycleTransition(currentEntry, targetState);
  if (!applied.ok) throw new InstanceUpdateRejectedError(applied.reason, 'lifecycle');

  const result = replaceControlSettingsDocument({
    path,
    expectedRevision,
    mutate: (agents) => ({ ...agents, [agentId]: applied.entry }),
  });
  auditWrite({ actor, source, action: 'instance.lifecycle.transition', revision: result.revision, changedFields: applied.changedFields.map((field) => `agents.${agentId}.${field}`), auditPath });
  return { ...result, snapshot: buildInstanceSnapshot({ agentId, adapter, entry: applied.entry }) };
}

/**
 * The pre-claim eligibility gate (required_validation: "Disabled and
 * draining agents are proven ineligible for new claims before any claim or
 * GitHub mutation"). This delegates entirely to the existing
 * `isAgentRoutable()`/`getAgentSettings().routable` contract from #40 —
 * the same gate this control service's writes are visible to without a
 * restart — rather than inventing a second notion of eligibility.
 *
 * This is a foundation-only proof, not scheduler wiring: nothing here is
 * imported by `claude-runner-cron.mjs`. Wiring it into live claim dispatch
 * is out of scope for this issue (see AGENTS.md / the governing manager
 * packet's prohibited_work: no automatic routing, no live issue execution).
 */
export function claimEligibility(settings) {
  if (!settings?.routable) {
    return { eligible: false, reason: settings?.reason || 'agent-not-routable' };
  }
  return { eligible: true, reason: 'agent-routable' };
}

/**
 * Evaluate eligibility and only ever invoke `onEligible`/`onIneligible` —
 * an ineligible outcome calls `onIneligible` (a safe, non-mutating reporter)
 * and *never* touches any claim/GitHub-mutation function a caller might
 * pass elsewhere. Tests prove this by injecting a claim spy that is
 * asserted uncalled whenever the agent is disabled/paused/draining.
 */
export function evaluateClaimEligibility({
  agentId,
  env = process.env,
  settingsPath,
  getSettings = getAgentSettings,
  onEligible,
  onIneligible,
} = {}) {
  const settings = getSettings({ env, agentId, ...(settingsPath ? { settingsPath } : {}) });
  const decision = claimEligibility(settings);
  if (!decision.eligible) {
    if (typeof onIneligible === 'function') onIneligible(decision, settings);
    return { ...decision, settings };
  }
  if (typeof onEligible === 'function') onEligible(decision, settings);
  return { ...decision, settings };
}
