import * as view from './agents-dashboard-view.mjs';

/**
 * Browser bootstrap for the authenticated Agents dashboard (issue #47).
 * DOM/fetch wiring only — every derivation/formatting decision lives in
 * `agents-dashboard-view.mjs` (framework-free, unit-tested).
 *
 * State kept in this module is intentionally minimal and intentionally
 * never persisted: `sessionState.csrfToken` lives only in this closure
 * variable (never `localStorage`/`sessionStorage`/a DOM attribute/a
 * cookie JS can read) and is discarded on reload — a reload always
 * requires a fresh login, matching the server's session model exactly
 * (sessions are in-memory-only server-side too). The session cookie
 * itself is HttpOnly, so this script never even has the option of touching
 * it. Credential `<input type="password">` values are cleared
 * synchronously, before the network request that reads them settles, so
 * nothing lingers in the DOM if the response is slow or the tab is closed
 * mid-request.
 */

const sessionState = { csrfToken: null };
let lastFetchedAt = null;
let currentRevision = null;

function byId(id) { return document.getElementById(id); }

function setHidden(id, hidden) { byId(id).hidden = hidden; }

async function apiFetch(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') {
    Object.assign(headers, view.buildMutationHeaders(sessionState.csrfToken || ''));
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, json: { ok: false, reason: 'network-error' } };
  }
  let json = null;
  try { json = await response.json(); } catch { /* no/invalid body */ }
  return { ok: response.ok, status: response.status, json };
}

function showLogin() {
  setHidden('login-section', false);
  setHidden('dashboard-section', true);
  setHidden('session-controls', true);
}

function showDashboard(username) {
  setHidden('login-section', true);
  setHidden('dashboard-section', false);
  setHidden('session-controls', false);
  byId('session-identity').textContent = `Signed in as ${username}`;
}

function showFatalError(message) {
  const el = byId('fatal-error');
  el.textContent = message;
  el.hidden = false;
}

// -- login / logout ------------------------------------------------------

async function handleLoginSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.username.value;
  const password = form.password.value;
  // Clear the credential field synchronously — before the request settles,
  // so nothing lingers in the DOM regardless of how long the network call
  // takes or whether the tab is closed mid-request.
  form.password.value = '';
  setHidden('login-error', true);

  const result = await apiFetch('/api/session/login', { method: 'POST', body: { username, password } });
  if (!result.ok) {
    byId('login-error').textContent = result.json?.reason || 'sign-in-failed';
    setHidden('login-error', false);
    return;
  }
  sessionState.csrfToken = result.json.csrfToken;
  showDashboard(username);
  await refreshAll();
}

async function handleLogout() {
  await apiFetch('/api/session/logout', { method: 'POST' });
  sessionState.csrfToken = null;
  byId('instances-grid').replaceChildren();
  byId('audit-rows').replaceChildren();
  byId('revision-rows').replaceChildren();
  showLogin();
}

// -- rendering -------------------------------------------------------------

function renderAddInstanceOptions(instances) {
  const select = byId('add-instance-select');
  select.replaceChildren();
  const creatable = instances.filter((instance) => !instance.created);
  if (creatable.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'All approved adapters are already registered';
    option.disabled = true;
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const instance of creatable) {
    const option = document.createElement('option');
    option.value = instance.agentId;
    option.textContent = `${instance.agentId}${instance.implemented ? '' : ' (foundation-only)'}`;
    select.appendChild(option);
  }
}

function renderAuditRows(entries) {
  const tbody = byId('audit-rows');
  tbody.replaceChildren();
  for (const entry of entries.slice(0, 25)) {
    const row = document.createElement('tr');
    const cells = [
      view.formatTimestamp(entry.at),
      entry.actor,
      entry.action,
      entry.revision != null ? String(entry.revision) : '—',
      Array.isArray(entry.changedFields) ? entry.changedFields.join(', ') : '—',
    ];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  }
}

/** `availableRevisions` from `GET /api/settings/revisions` is a plain array of retained revision numbers — no per-revision timestamp is exposed by that endpoint. */
function renderRevisionRows(currentRev, availableRevisions) {
  currentRevision = currentRev;
  byId('current-revision').textContent = currentRev != null ? String(currentRev) : '—';
  const tbody = byId('revision-rows');
  tbody.replaceChildren();
  for (const revisionNumber of availableRevisions) {
    const row = document.createElement('tr');
    const revCell = document.createElement('td');
    revCell.textContent = String(revisionNumber);
    row.appendChild(revCell);
    const actionCell = document.createElement('td');
    const rollbackButton = document.createElement('button');
    rollbackButton.type = 'button';
    rollbackButton.className = 'secondary';
    rollbackButton.textContent = 'Roll back to this revision';
    rollbackButton.addEventListener('click', () => handleRollback(revisionNumber));
    actionCell.appendChild(rollbackButton);
    row.appendChild(actionCell);
    tbody.appendChild(row);
  }
}

function setLifecycleButtonState(button, instance, auditEntries) {
  const action = button.dataset.action;
  const availability = view.describeActionAvailability(action, instance);
  button.disabled = !availability.available;
  button.title = availability.reason || '';
}

function renderInstanceCard(instance, auditEntries) {
  const template = byId('instance-card-template');
  const node = template.content.firstElementChild.cloneNode(true);

  node.querySelector('.instance-title').textContent = instance.agentId;
  const badge = node.querySelector('.state-badge');
  badge.textContent = instance.state;
  badge.classList.add(`state-${instance.state}`);
  node.querySelector('.state-explanation').textContent = view.describeState(instance.state);

  node.querySelector('.fact-adapter').textContent = `${instance.adapterType || '—'} / ${instance.command || 'no runtime command'}`;
  node.querySelector('.fact-surface').textContent = view.classifyExecutionSurface(instance.adapterType);
  node.querySelector('.fact-version').textContent = view.describeVersionPolicy(instance);
  const capabilities = view.listSupportedCapabilities(instance.capabilities);
  node.querySelector('.fact-capabilities').textContent = capabilities.length ? capabilities.join(', ') : 'None supported yet.';
  node.querySelector('.fact-model').textContent = `${instance.model || '—'} / ${instance.profile || '—'}`;
  node.querySelector('.fact-limits').textContent = view.describeContextOutputLimits(instance);
  node.querySelector('.fact-cost').textContent = view.describeCostClass(instance.quota?.costClass);
  node.querySelector('.fact-budget').textContent = instance.policy?.requireHumanApproval
    ? 'Human approval required before paid use.'
    : 'No approval requirement recorded.';
  node.querySelector('.fact-quota').textContent = instance.quota?.quota
    ? `Session usage ${view.formatPercent(instance.quota.quota.latestSessionUsagePercent)}, weekly ${view.formatPercent(instance.quota.quota.latestWeeklyUsagePercent)}, blocked polls ${instance.quota.quota.blockedCount ?? '—'}`
    : 'Not tracked for this adapter.';
  node.querySelector('.fact-slot').textContent = view.describeCurrentSlot(instance.load);
  node.querySelector('.fact-readiness').textContent = view.describeReadiness(instance.readiness);
  node.querySelector('.fact-readiness-time').textContent = lastFetchedAt ? view.formatTimestamp(lastFetchedAt) : '—';
  node.querySelector('.fact-revision').textContent = currentRevision != null ? String(currentRevision) : '—';
  node.querySelector('.fact-last-change').textContent = view.formatTimestamp(view.findLastStateChange(auditEntries, instance.agentId));
  node.querySelector('.fact-auth').textContent = instance.created ? 'Loading…' : 'No instance registered.';

  // -- lifecycle actions, with an explicit confirmation gate for paid enable --
  const confirmPanel = node.querySelector('.paid-confirm');
  for (const button of node.querySelectorAll('.lifecycle-actions button')) {
    setLifecycleButtonState(button, instance, auditEntries);
    button.addEventListener('click', () => {
      if (button.dataset.action === 'enabled' && view.requiresPaidEnableConfirmation(instance)) {
        confirmPanel.querySelector('.paid-confirm-copy').textContent = view.buildPaidEnableConfirmationCopy(instance);
        confirmPanel.hidden = false;
        confirmPanel.querySelector('.confirm-enable-button').focus();
        return;
      }
      handleLifecycleTransition(instance.agentId, button.dataset.action);
    });
  }
  confirmPanel.querySelector('.confirm-enable-button').addEventListener('click', () => {
    confirmPanel.hidden = true;
    handleLifecycleTransition(instance.agentId, 'enabled');
  });
  confirmPanel.querySelector('.cancel-enable-button').addEventListener('click', () => {
    confirmPanel.hidden = true;
  });

  // -- non-secret settings form --
  const settingsForm = node.querySelector('.settings-form');
  settingsForm.model.value = instance.model || '';
  settingsForm.profile.value = instance.profile || '';
  settingsForm.endpoint.value = instance.endpoint || '';
  settingsForm.timeout.value = instance.timeout || '';
  settingsForm.requireHumanApproval.checked = instance.policy?.requireHumanApproval !== false;
  settingsForm.notes.value = instance.policy?.notes || '';
  if (!instance.created) {
    for (const field of settingsForm.elements) field.disabled = true;
  }
  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleSettingsSubmit(instance.agentId, settingsForm);
  });

  // -- write-only credential form --
  const secretForm = node.querySelector('.secret-form');
  const secretStatusEl = node.querySelector('.secret-status');
  const secretMessageEl = node.querySelector('.secret-status-message');
  const authCell = node.querySelector('.fact-auth');
  if (!instance.created) {
    for (const field of secretForm.elements) field.disabled = true;
    secretStatusEl.textContent = 'Add the instance above before configuring its credential.';
    authCell.textContent = 'No instance registered.';
  } else {
    refreshSecretStatus(instance.agentId, authCell, secretStatusEl);
    secretForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const action = event.submitter?.dataset.secretAction || 'create';
      handleSecretSubmit(instance.agentId, secretForm, action, secretMessageEl, secretStatusEl);
    });
    secretForm.querySelector('[data-secret-action="remove"]').addEventListener('click', () => {
      handleSecretRemove(instance.agentId, secretMessageEl, secretStatusEl);
    });
  }

  return node;
}

async function refreshSecretStatus(agentId, authCellEl, secretStatusEl) {
  const result = await apiFetch(`/api/secrets/${encodeURIComponent(agentId)}`);
  const label = result.ok ? view.secretStatusLabel(result.json.status.status) : 'Unknown';
  secretStatusEl.textContent = label;
  authCellEl.textContent = label;
}

// -- mutating actions ------------------------------------------------------

async function handleAddInstanceSubmit(event) {
  event.preventDefault();
  const select = byId('add-instance-select');
  const statusEl = byId('add-instance-status');
  const agentId = select.value;
  if (!agentId) return;
  const result = await apiFetch('/api/instances', {
    method: 'POST',
    body: { agentId, expectedRevision: currentRevision },
  });
  statusEl.className = `status-text ${result.ok ? 'ok' : 'error'}`;
  statusEl.textContent = result.ok ? `Added ${agentId}.` : (result.json?.reason || 'add-instance-failed');
  if (result.ok) await refreshAll();
}

async function handleLifecycleTransition(agentId, targetState) {
  const result = await apiFetch(`/api/instances/${encodeURIComponent(agentId)}/lifecycle`, {
    method: 'POST',
    body: { targetState, expectedRevision: currentRevision },
  });
  if (!result.ok) {
    showFatalError(`Lifecycle change failed for ${agentId}: ${result.json?.reason || 'unknown-error'}`);
    setTimeout(() => setHidden('fatal-error', true), 6000);
  }
  await refreshAll();
}

async function handleSettingsSubmit(agentId, form) {
  const updates = {
    model: form.model.value || null,
    profile: form.profile.value || null,
    endpoint: form.endpoint.value || null,
    timeout: form.timeout.value ? Number(form.timeout.value) : null,
    policy: { requireHumanApproval: form.requireHumanApproval.checked, notes: form.notes.value || '' },
  };
  const statusEl = form.querySelector('.settings-status');
  const result = await apiFetch(`/api/instances/${encodeURIComponent(agentId)}/settings`, {
    method: 'PATCH',
    body: { updates, expectedRevision: currentRevision },
  });
  statusEl.className = `status-text settings-status ${result.ok ? 'ok' : 'error'}`;
  statusEl.textContent = result.ok ? 'Saved.' : (result.json?.reason || 'update-failed');
  if (result.ok) await refreshAll();
}

async function handleSecretSubmit(agentId, form, action, messageEl, statusEl) {
  const value = form.value.value;
  // Clear the credential input synchronously — before the request settles —
  // so the value never lingers in the DOM past this point, regardless of
  // how long the network round-trip takes.
  form.value.value = '';
  if (!view.isSecretValueValid(value)) {
    messageEl.className = 'status-text error-text';
    messageEl.textContent = 'A non-empty credential value is required.';
    return;
  }
  const path = action === 'rotate' ? `/api/secrets/${encodeURIComponent(agentId)}/rotate` : `/api/secrets/${encodeURIComponent(agentId)}`;
  const result = await apiFetch(path, { method: 'POST', body: view.buildSecretRequestBody(value) });
  messageEl.className = `status-text ${result.ok ? 'ok' : 'error'}`;
  messageEl.textContent = result.ok ? `Credential ${action === 'rotate' ? 'rotated' : 'created'}.` : (result.json?.reason || 'secret-operation-failed');
  if (result.ok) statusEl.textContent = view.secretStatusLabel(result.json.status);
}

async function handleSecretRemove(agentId, messageEl, statusEl) {
  const result = await apiFetch(`/api/secrets/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  messageEl.className = `status-text ${result.ok ? 'ok' : 'error'}`;
  messageEl.textContent = result.ok ? 'Credential removed.' : (result.json?.reason || 'secret-remove-failed');
  if (result.ok) statusEl.textContent = view.secretStatusLabel(result.json.status);
}

async function handleRollback(targetRevision) {
  const result = await apiFetch('/api/settings/rollback', { method: 'POST', body: { targetRevision } });
  if (!result.ok) {
    showFatalError(`Rollback failed: ${result.json?.reason || 'unknown-error'}`);
    setTimeout(() => setHidden('fatal-error', true), 6000);
    return;
  }
  await refreshAll();
}

// -- full refresh ------------------------------------------------------------

async function refreshAll() {
  const [instancesResult, auditResult, revisionsResult] = await Promise.all([
    apiFetch('/api/instances'),
    apiFetch('/api/audit?limit=50'),
    apiFetch('/api/settings/revisions'),
  ]);

  if (!instancesResult.ok) {
    if (instancesResult.status === 401) { showLogin(); return; }
    showFatalError(`Failed to load instances: ${instancesResult.json?.reason || 'unknown-error'}`);
    return;
  }
  lastFetchedAt = new Date().toISOString();
  const auditEntries = auditResult.ok ? auditResult.json.entries : [];
  if (revisionsResult.ok) renderRevisionRows(revisionsResult.json.currentRevision, revisionsResult.json.availableRevisions);

  renderAddInstanceOptions(instancesResult.json.instances);
  renderAuditRows(auditEntries);

  const grid = byId('instances-grid');
  grid.replaceChildren();
  for (const instance of instancesResult.json.instances) {
    grid.appendChild(renderInstanceCard(instance, auditEntries));
  }
}

function init() {
  byId('login-form').addEventListener('submit', handleLoginSubmit);
  byId('logout-button').addEventListener('click', handleLogout);
  byId('add-instance-form').addEventListener('submit', handleAddInstanceSubmit);
  showLogin();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
