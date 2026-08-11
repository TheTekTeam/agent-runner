/**
 * Pure, framework-free view/derivation helpers for the authenticated Agents
 * dashboard (issue #47). Nothing in this file touches the DOM, `fetch`,
 * `window`, `document`, or any Node built-in — every export is a plain
 * function of its arguments, importable both from the browser bootstrap
 * (`agents-dashboard.js`) and directly from a `node:test` file, so the
 * derivations that decide what appears on screen are unit-testable without
 * a browser or a DOM shim.
 *
 * None of these functions accept, return, or format a secret value,
 * provider credential, prompt, raw model output, session handle, or
 * filesystem path — the control API never sends any of those to this
 * client (see `docs/ops/AGENT-RUNNER-AGENTS-DASHBOARD.md`), and this module
 * does not invent a way to surface one. `readiness.probes[].detail` (which
 * can hold a resolved executable path) is deliberately never read here —
 * the server-side snapshot already omits it (see
 * `buildInstanceSnapshot()`).
 */

const EXECUTION_SURFACE_BY_TYPE = Object.freeze({
  claude: 'Local CLI',
  codex: 'Local CLI',
  ollama: 'Local model (via OpenCode harness)',
  gpt: 'External / manual',
  gemini: 'External / manual',
});

const STATE_EXPLANATIONS = Object.freeze({
  enabled: 'Enabled — eligible to receive new claims.',
  paused: 'Paused by the operator — no new claims until resumed.',
  draining: 'Draining — finishing any active work, but ineligible for new claims.',
  disabled: 'Disabled by the operator — no new claims and no background probes.',
  unavailable: 'Enabled, but a readiness probe is currently failing, so it is treated as ineligible for new claims.',
  unsupported: 'Foundation-only catalogue entry — not yet implemented by this runner, so it can never be enabled.',
});

const LIFECYCLE_TARGETS = Object.freeze(['enabled', 'paused', 'draining', 'disabled']);

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Issue #47 required view: "execution surface: local CLI, local model or external/manual". */
export function classifyExecutionSurface(adapterType) {
  return EXECUTION_SURFACE_BY_TYPE[adapterType] || 'External / manual';
}

/** Issue #47 required view: "cost class ... state" — paired with the server-computed `quota.costClass`. */
export function describeCostClass(costClass) {
  switch (costClass) {
    case 'paid-metered': return 'Paid (metered)';
    case 'free-local-zero-spend': return 'Free (local, zero-spend)';
    case 'not-yet-qualified': return 'Not yet qualified';
    default: return 'Unknown';
  }
}

/**
 * Issue #47 required view: "adapter, command/runtime and safe version".
 * There is no live version probe anywhere in this runner (control-service
 * readiness is a deterministic, zero-process-spawn PATH check by design —
 * see `agent-runner-control-readiness.mjs`) and this dashboard adds none;
 * this is an honest policy label, never a fabricated version number.
 */
export function describeVersionPolicy({ agentId, implemented } = {}) {
  if (!implemented) return 'Not yet qualified — foundation-only adapter; this runner does not install or version-check it.';
  if (agentId === 'claude-code-cli') return 'Unpinned — any PATH-resolved `claude` binary is treated as the qualified runtime.';
  return 'Not yet qualified.';
}

/** Issue #47 required view: "derived health, implementation and qualification state". */
export function describeState(state) {
  return STATE_EXPLANATIONS[state] || 'Unknown state.';
}

/** Deliberately ignores `readiness.probes` — never surface a probe's resolved filesystem path. */
export function describeReadiness(readiness) {
  if (!readiness) return 'Not probed (foundation-only adapter).';
  if (readiness.ok) return 'Ready.';
  return `Not ready (${readiness.reason || 'unknown-reason'}).`;
}

export function formatPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

export function formatTimestamp(iso) {
  if (!iso) return '—';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

/** Issue #47 required view: "context/output limits and capability classes" — from the real, static `capabilities` map. */
export function listSupportedCapabilities(capabilities) {
  if (!isPlainObject(capabilities)) return [];
  return Object.entries(capabilities)
    .filter(([, capability]) => isPlainObject(capability) && capability.supported === true)
    .map(([name]) => name)
    .sort();
}

/**
 * This runner does not model a context-window/output-token-limit field for
 * any adapter (`timeout` bounds wall-clock execution time, not tokens).
 * Honest "not modeled" label rather than a fabricated number.
 */
export function describeContextOutputLimits(instance) {
  const timeoutMs = instance?.timeout;
  const timeoutNote = typeof timeoutMs === 'number' ? ` (execution wall-clock timeout: ${Math.round(timeoutMs / 1000)}s)` : '';
  return `Not modeled by this adapter's control surface${timeoutNote}.`;
}

/**
 * Issue #47 required view: "current task/slot, reserved work and assigned
 * queue" — derived from the read-only `load` block. This runner has one
 * global serial execution slot; "reserved work"/"assigned queue" beyond the
 * current active/idle slot state is out of scope (no multi-worker
 * concurrency or queue-assignment model exists to report — see AGENTS.md).
 */
export function describeCurrentSlot(load) {
  if (!load) return 'Not tracked.';
  if (typeof load.active !== 'number') return load.note || 'Not tracked.';
  return load.active > 0 ? 'Slot occupied — an execution is currently active or unresolved.' : 'Slot idle — no active execution.';
}

/**
 * Issue #47 required view: "last readiness check ... and last state change".
 * `auditEntries` must already be sorted most-recent-first (the shape
 * `GET /api/audit` returns) — this never re-sorts by a client-trusted
 * value, only filters and takes the head.
 */
export function findLastStateChange(auditEntries, agentId) {
  if (!Array.isArray(auditEntries)) return null;
  const prefix = `agents.${agentId}.`;
  const exact = `agents.${agentId}`;
  const match = auditEntries.find((entry) => Array.isArray(entry?.changedFields)
    && entry.changedFields.some((field) => field === exact || String(field).startsWith(prefix)));
  return match ? match.at : null;
}

/** Issue #47 required view #17: paid-agent enablement needs explicit confirmation. Only claude-code-cli is both paid and implemented today. */
export function requiresPaidEnableConfirmation(instance) {
  return Boolean(instance?.implemented) && instance?.quota?.paid === true;
}

export function buildPaidEnableConfirmationCopy(instance) {
  return `Enabling "${instance?.agentId}" allows it to accept live paid-provider work and be billed. Confirm you intend to enable this paid agent now.`;
}

/**
 * Issue #47 required view #12: "clear explanations when actions are
 * unavailable". Mirrors the real server contract: `POST /api/instances`
 * accepts any id in the approved catalogue whether or not it is
 * implemented yet (only an id outside the catalogue is rejected) — so
 * "create" is available for foundation-only adapters too. Lifecycle
 * transitions are structurally a no-op for a foundation-only adapter
 * (`deriveInstanceState()` forces `unsupported` regardless of stored
 * lifecycle flags), so this UI disables them there with an explanation
 * rather than exposing a control with no visible effect.
 */
export function describeActionAvailability(action, instance) {
  if (!instance) return { available: false, reason: 'unknown-instance' };
  if (action === 'create') {
    if (instance.created) return { available: false, reason: 'Already registered.' };
    if (!instance.implemented) return { available: true, reason: 'Foundation-only adapter — registrable now; remains "unsupported" until implemented.' };
    return { available: true, reason: null };
  }
  if (LIFECYCLE_TARGETS.includes(action)) {
    if (!instance.created) return { available: false, reason: 'Add the instance before changing its lifecycle state.' };
    if (!instance.implemented) return { available: false, reason: 'Foundation-only adapter — derived state stays "unsupported" regardless of lifecycle, so this control has no visible effect.' };
    if (instance.state === action) return { available: false, reason: `Already ${action}.` };
    return { available: true, reason: null };
  }
  if (action === 'secret-rotate' || action === 'secret-remove') {
    if (!instance.created) return { available: false, reason: 'Add the instance before configuring credentials.' };
    return { available: true, reason: null };
  }
  if (action === 'secret-create') {
    if (!instance.created) return { available: false, reason: 'Add the instance before configuring credentials.' };
    return { available: true, reason: null };
  }
  return { available: true, reason: null };
}

/** Never returns anything containing the secret value itself — only the JSON-serializable request body shape. */
export function buildSecretRequestBody(value) {
  return { value };
}

export function isSecretValueValid(value) {
  return typeof value === 'string' && value.length > 0;
}

export function buildMutationHeaders(csrfToken) {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
}

/** Positive allowlist mirrored from `agent-runner-control-instances.mjs`'s `ALLOWED_UPDATE_FIELDS` — display/order only, never enforced client-side in place of the server. */
export const EDITABLE_SETTINGS_FIELDS = Object.freeze(['model', 'profile', 'endpoint', 'timeout', 'maxConcurrency', 'policy']);

export const LIFECYCLE_STATES = LIFECYCLE_TARGETS;

/**
 * Maps an agent's lifecycle state onto the one shared status vocabulary
 * (issue #175), so a fleet row and the Overview's operational status badges
 * speak the same language. `enabled` is deliberately NOT reported as
 * `healthy` on its own — an enabled adapter whose readiness probe is
 * failing is `unavailable`, never a green tick.
 */
export function mapAgentStateToStatusCode(instance) {
  const state = instance?.state;
  if (state === 'unsupported') return 'unsupported';
  if (state === 'disabled') return 'disabled';
  if (state === 'paused') return 'paused';
  if (state === 'draining') return 'draining';
  if (state === 'unavailable') return 'unavailable';
  if (state === 'enabled') return instance?.readiness?.ok === true ? 'healthy' : 'unavailable';
  return 'unknown';
}

/**
 * The compact fleet-row summary for the Agents view: every field #175
 * requires "where available", each already present in the authenticated
 * instance snapshot. Returns honest placeholders rather than blanks, and
 * never touches a credential value — only the separately fetched
 * write-only credential *status*.
 */
export function summariseAgentRow(instance, { auditEntries = [], currentRevision = null } = {}) {
  return {
    agentId: instance?.agentId || '—',
    displayName: instance?.displayName || instance?.agentId || '—',
    statusCode: mapAgentStateToStatusCode(instance),
    state: instance?.state || 'unknown',
    stateExplanation: describeState(instance?.state),
    created: Boolean(instance?.created),
    implemented: Boolean(instance?.implemented),
    qualification: instance?.implemented ? 'Implemented & qualified' : 'Foundation-only — not yet qualified',
    readiness: describeReadiness(instance?.readiness),
    readinessOk: instance?.readiness?.ok === true,
    modelProfile: `${instance?.model || '—'} / ${instance?.profile || '—'}`,
    executionSurface: classifyExecutionSurface(instance?.adapterType),
    costClass: describeCostClass(instance?.quota?.costClass),
    paid: instance?.quota?.paid === true,
    quotaText: instance?.quota?.quota
      ? `Session ${formatPercent(instance.quota.quota.latestSessionUsagePercent)} · weekly ${formatPercent(instance.quota.quota.latestWeeklyUsagePercent)}`
      : 'Not tracked for this adapter.',
    loadText: describeCurrentSlot(instance?.load),
    slotBusy: Number(instance?.load?.active) > 0,
    lastStateChangeAt: findLastStateChange(auditEntries, instance?.agentId),
    revision: currentRevision,
  };
}

export function secretStatusLabel(status) {
  switch (status) {
    case 'configured': return 'Configured';
    case 'missing': return 'Missing';
    case 'invalid': return 'Invalid';
    case 'rotation-required': return 'Rotation required';
    default: return 'Unknown';
  }
}
