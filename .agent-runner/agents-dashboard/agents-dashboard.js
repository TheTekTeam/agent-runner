import * as view from './agents-dashboard-view.mjs';
import * as ops from './agents-overview-view.mjs';

/**
 * Browser bootstrap for the authenticated Agent Runner operations console
 * (issues #47 and #175). DOM/fetch wiring only — every derivation and
 * formatting decision lives in the two framework-free, unit-tested view
 * modules imported above.
 *
 * `sessionState.csrfToken` lives only in this closure (never
 * `localStorage`/`sessionStorage`/a DOM attribute/a cookie JS can read).
 * A page reload rehydrates that ephemeral value from the authenticated
 * same-origin `/api/session` context endpoint using the existing HttpOnly
 * session cookie. Nothing is persisted by this script, while logout, TTL
 * expiry and a service restart still invalidate the server-side session.
 * Credential `<input type="password">` values are cleared synchronously,
 * before the request that reads them settles.
 *
 * Nothing on this page is persisted anywhere in the browser — not even the
 * theme choice, which is intentionally memory-only so that this file
 * contains no browser-storage write of any kind.
 *
 * Every network request is a same-origin, credentialed call to this
 * service's own `/api/*` surface. There is no other `fetch()` in this file,
 * no image/font/script loaded from anywhere else, and no telemetry.
 */

const sessionState = { csrfToken: null };

const state = {
  overview: null,
  instances: [],
  auditEntries: [],
  currentRevision: null,
  availableRevisions: [],
  lastFetchedAt: null,
  lastSignature: null,
  section: 'overview',
  theme: 'system',
  timelineFilter: { query: '', source: 'all' },
  drawerAgentId: null,
  drawerReturnFocus: null,
};

let refreshTimer = null;
let elapsedTimer = null;
let inFlight = false;

// -- tiny DOM helpers ---------------------------------------------------

function byId(id) { return document.getElementById(id); }

/** Only writes when the value actually changed — avoids pointless DOM churn on every poll. */
function setText(element, value) {
  const next = value === null || value === undefined || value === '' ? '—' : String(value);
  if (element && element.textContent !== next) element.textContent = next;
}

function setHidden(element, hidden) {
  if (element && element.hidden !== hidden) element.hidden = hidden;
}

function setBadge(element, status) {
  if (!element) return;
  const described = ops.describeStatus(status);
  if (element.dataset.tone !== described.tone) element.dataset.tone = described.tone;
  setText(element.querySelector('.badge-glyph'), described.glyph);
  setText(element.querySelector('.badge-text'), described.label);
  const title = described.nextAction ? `${described.explanation} Next: ${described.nextAction}` : described.explanation;
  if (element.title !== title) element.title = title;
  return described;
}

function setTimeCell(element, iso, { relative = false } = {}) {
  if (!element) return;
  setText(element, iso ? (relative ? ops.formatRelative(iso) : ops.formatClock(iso)) : null);
  const utc = ops.formatUtc(iso);
  if (element.title !== utc) element.title = utc;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// -- API ----------------------------------------------------------------

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

// -- view switching -----------------------------------------------------

function showLogin() {
  stopRefreshLoop();
  setHidden(byId('login-view'), false);
  setHidden(byId('shell'), true);
  byId('login-username')?.focus();
}

function showShell(username) {
  setHidden(byId('login-view'), true);
  setHidden(byId('shell'), false);
  setText(byId('session-identity'), `Signed in as ${username}`);
}

function showGlobalError(message) {
  const element = byId('global-error');
  setText(element, message);
  setHidden(element, false);
  window.setTimeout(() => setHidden(element, true), 8000);
}

function renderNav() {
  const list = byId('nav-list');
  if (!list || list.childElementCount > 0) return;
  for (const section of ops.NAV_SECTIONS) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${section.id}`;
    link.dataset.nav = section.id;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${section.icon}`);
    svg.appendChild(use);
    link.appendChild(svg);
    link.appendChild(createElement('span', null, section.label));
    item.appendChild(link);
    list.appendChild(item);
  }
}

function selectSection(sectionId) {
  const known = ops.NAV_SECTIONS.some((section) => section.id === sectionId) ? sectionId : 'overview';
  state.section = known;
  for (const section of ops.NAV_SECTIONS) {
    setHidden(byId(`panel-${section.id}`), section.id !== known);
  }
  for (const link of document.querySelectorAll('#nav-list a')) {
    if (link.dataset.nav === known) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

// -- overview rendering -------------------------------------------------

function renderOverview(overview) {
  if (!overview) return;
  setText(byId('project-name'), overview.project?.displayName || overview.project?.projectId || 'Agent Runner');
  setBadge(byId('strip-runner'), overview.runner);
  setBadge(byId('strip-scheduler'), overview.scheduler);

  const task = ops.describeCurrentTask(overview.currentTask);
  const posture = ops.classifyRunPosture(overview.currentTask, overview.attention);
  setBadge(byId('strip-task'), { code: task.active ? 'running' : 'idle', label: task.active ? posture.label : 'Idle', explanation: task.detail });

  const attentionCount = overview.attention?.unresolvedCount ?? 0;
  const healthCount = overview.health?.unresolvedCount ?? 0;
  const outstanding = attentionCount + healthCount;
  setBadge(byId('strip-attention'), {
    code: outstanding > 0 ? 'attention' : 'healthy',
    label: outstanding > 0 ? `${outstanding} open` : 'None open',
    explanation: outstanding > 0
      ? `${attentionCount} unresolved attention event(s) and ${healthCount} open health condition(s).`
      : 'No unresolved attention event or open health condition.',
  });

  setTimeCell(byId('last-updated'), state.lastFetchedAt, { relative: true });
  setText(byId('overview-generated'), overview.generatedAt
    ? `Live state generated ${ops.formatClock(overview.generatedAt)} · schema ${overview.schemaVersion}`
    : 'Live state timestamp unavailable.');

  // -- current task ------------------------------------------------
  setBadge(byId('task-posture'), {
    code: task.active ? (posture.code === 'awaiting-attention' ? 'attention' : 'running') : 'idle',
    label: posture.label,
    explanation: task.detail,
  });
  setText(byId('task-headline'), task.headline);
  setText(byId('task-detail'), task.detail);

  const current = overview.currentTask || {};
  setText(byId('task-agent'), task.active ? (current.agent || 'Not recorded for this attempt') : '—');
  setText(byId('task-assignment'), task.active ? (current.assignmentDisplayName || current.assignmentLabel || '—') : '—');
  setText(byId('task-phase'), task.active ? (current.phase || '—') : '—');
  setText(byId('task-status-label'), task.active ? (current.statusLabel || '—') : '—');
  setTimeCell(byId('task-started'), task.active ? current.startedAt : null);
  setText(byId('task-elapsed'), task.elapsedText);

  const issueLink = byId('task-issue-link');
  if (issueLink) {
    if (task.active && current.issueUrl) {
      issueLink.href = current.issueUrl;
      issueLink.rel = 'noreferrer noopener';
      issueLink.target = '_blank';
      setHidden(issueLink, false);
    } else {
      setHidden(issueLink, true);
    }
  }

  // -- tiles -------------------------------------------------------
  setBadge(byId('tile-scheduler-badge'), overview.scheduler);
  const scheduler = ops.describeStatus(overview.scheduler);
  setText(byId('tile-scheduler-note'), scheduler.nextAction ? `${scheduler.explanation} ${scheduler.nextAction}` : scheduler.explanation);

  const quota = ops.describeQuota(overview.quota);
  setText(byId('tile-quota-value'), quota.tracked ? quota.sessionText : 'Not tracked');
  setText(byId('tile-quota-note'), quota.tracked ? `Weekly ${quota.weeklyText}. ${quota.summary}` : quota.summary);
  setText(byId('tile-quota-cost'), quota.costNote);
  const meter = byId('tile-quota-meter');
  const fill = byId('tile-quota-fill');
  const usage = overview.quota?.sessionUsagePercent;
  if (meter && fill) {
    const percent = Number.isFinite(usage) ? Math.min(100, Math.max(0, usage)) : 0;
    fill.style.width = `${percent}%`;
    meter.dataset.tone = percent >= 90 ? 'critical' : (percent >= 70 ? 'warn' : 'ok');
    meter.setAttribute('aria-label', Number.isFinite(usage)
      ? `Included session quota ${usage}% used`
      : 'Included quota usage not tracked');
  }

  const queue = ops.summariseQueue(overview.queue);
  setText(byId('tile-queue-value'), `${queue.skippedIssueCount} skipped`);
  setText(byId('tile-queue-note'), `${queue.skipEventCount} skip event(s) across ${queue.distinctReasonCount} reason code(s) in the retained window. ${queue.runnableClaim}`);
  const reasonList = byId('tile-queue-reasons');
  if (reasonList) {
    reasonList.replaceChildren();
    if (queue.topReasons.length === 0) {
      reasonList.appendChild(createElement('li', 'event-empty', 'No skip reason recorded in the retained window.'));
    }
    for (const reason of queue.topReasons) {
      const item = document.createElement('li');
      item.appendChild(createElement('span', null, reason.reason || 'unknown-reason'));
      item.appendChild(createElement('span', 'reason-count', String(reason.count)));
      reasonList.appendChild(item);
    }
  }

  const fleet = ops.summariseFleet(state.instances);
  setText(byId('tile-fleet-value'), `${fleet.ready} ready / ${fleet.implemented} implemented`);
  setText(byId('tile-fleet-note'), `${fleet.planned} foundation-only planned; ${fleet.counts.enabled} enabled, ${fleet.counts.paused} paused, ${fleet.counts.draining} draining, ${fleet.counts.disabled} disabled, ${fleet.counts.unavailable} unavailable.`);

  setText(byId('tile-attention-value'), outstanding > 0 ? String(outstanding) : 'None');
  setText(byId('tile-attention-note'), outstanding > 0
    ? `${attentionCount} unresolved attention event(s), ${healthCount} open health condition(s).`
    : 'No unresolved attention event or open health condition.');

  const runs = overview.runs || {};
  setText(byId('tile-runs-value'), `${runs.succeeded ?? 0} ok / ${runs.failed ?? 0} failed`);
  setText(byId('tile-runs-note'), `${runs.issueRuns ?? 0} issue run(s) across ${runs.schedulerPolls ?? 0} poll(s); average ${Number.isFinite(runs.averageDurationSeconds) ? ops.formatElapsed(runs.averageDurationSeconds) : 'unknown'}.`);

  renderAttentionList(overview);
  renderRecentActivity(overview);
  renderCompanionLinks(overview.links);
  renderServiceStatus(overview);
}

function renderAttentionList(overview) {
  const list = byId('attention-list');
  if (!list) return;
  list.replaceChildren();
  const rows = [
    ...(overview.health?.conditions || []).map((condition) => ({
      at: condition.openedAt,
      label: `Health: ${condition.conditionType || 'condition'}`,
      detail: condition.reason,
      next: condition.safeNextAction,
      url: null,
    })),
    ...(overview.attention?.events || []).map((event) => ({
      at: event.createdAt,
      label: `Attention: issue ${event.issueNumber ?? '—'}`,
      detail: event.reason,
      next: event.nextAction,
      url: event.issueUrl,
    })),
  ];
  if (overview.circuit?.blocked) {
    rows.unshift({
      at: overview.circuit.trippedAt,
      label: 'Admission circuit tripped',
      detail: overview.circuit.reason,
      next: overview.circuit.safeNextAction,
      url: null,
    });
  }
  if (rows.length === 0) {
    list.appendChild(createElement('li', 'event-empty', 'Nothing requires operator action.'));
    return;
  }
  const visibleRows = rows.slice(0, 6);
  for (const row of visibleRows) {
    const item = document.createElement('li');
    const time = createElement('span', 'event-time', row.at ? ops.formatClock(row.at) : '—');
    time.title = ops.formatUtc(row.at);
    item.appendChild(time);
    item.appendChild(createElement('strong', null, row.label));
    if (row.detail) item.appendChild(createElement('span', null, row.detail));
    if (row.next) item.appendChild(createElement('span', 'muted small', `Next: ${row.next}`));
    if (row.url) {
      const link = createElement('a', 'link-quiet', 'Open issue');
      link.href = row.url;
      link.rel = 'noreferrer noopener';
      link.target = '_blank';
      item.appendChild(link);
    }
    list.appendChild(item);
  }
  if (rows.length > visibleRows.length) {
    list.appendChild(createElement(
      'li',
      'event-empty',
      `${rows.length - visibleRows.length} more unresolved record(s) are available in Activity.`,
    ));
  }
}

function renderRecentActivity(overview) {
  const list = byId('recent-activity');
  if (!list) return;
  const rows = ops.buildTimeline({ activity: overview.activity || [], audit: [], limit: 8 });
  list.replaceChildren();
  if (rows.length === 0) {
    list.appendChild(createElement('li', 'event-empty', 'No runner activity in the retained window.'));
    return;
  }
  for (const row of rows) {
    const item = document.createElement('li');
    const time = createElement('span', 'event-time', ops.formatRelative(row.at));
    time.title = ops.formatUtc(row.at);
    item.appendChild(time);
    item.appendChild(createElement('strong', null, row.label));
    if (Number.isFinite(row.issueNumber)) item.appendChild(createElement('span', null, `#${row.issueNumber}`));
    if (row.detail) item.appendChild(createElement('span', 'muted', row.detail));
    if (row.reason) item.appendChild(createElement('span', 'muted small', row.reason));
    list.appendChild(item);
  }
}

function renderCompanionLinks(links) {
  const list = byId('companion-links');
  if (!list) return;
  list.replaceChildren();
  const entries = [
    ops.describeLink(links?.grafanaRunnerUrl, { label: 'Open Grafana Runner', unavailableNote: 'Not configured (set AGENT_RUNNER_GRAFANA_RUNNER_URL).' }),
    ops.describeLink(links?.grafanaOperationsUrl, { label: 'Open Operations Overview', unavailableNote: 'Not configured (set AGENT_RUNNER_GRAFANA_OPERATIONS_URL).' }),
    ops.describeLink(links?.legacyDashboardUrl, { label: 'Open legacy static dashboard', unavailableNote: 'Not configured (set AGENT_RUNNER_LEGACY_DASHBOARD_URL).' }),
  ];
  for (const entry of entries) {
    const item = document.createElement('li');
    if (entry.available) {
      const link = createElement('a', 'link-out', entry.label);
      link.href = entry.url;
      link.rel = 'noreferrer noopener';
      link.target = '_blank';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'icon');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#icon-external');
      svg.appendChild(use);
      link.appendChild(svg);
      item.appendChild(link);
    } else {
      item.appendChild(createElement('span', null, entry.label));
      item.appendChild(createElement('span', 'muted small', entry.note));
    }
    list.appendChild(item);
  }
}

function renderServiceStatus(overview) {
  setText(byId('settings-project'), overview.project?.displayName || overview.project?.projectId);
  setText(byId('settings-repo'), overview.project?.githubRepo);
  setText(byId('settings-schema'), overview.schemaVersion);
  setText(byId('settings-state'), overview.stateAvailable
    ? 'Readable (read-only snapshot).'
    : `Unavailable — ${ops.describeStatus(overview.runner).explanation}`);
  setText(byId('settings-circuit'), overview.circuit?.blocked
    ? `Tripped (${overview.circuit.reason || 'unknown-reason'}).`
    : 'Not tripped.');
}

// -- agents -------------------------------------------------------------

function renderAddInstanceOptions(instances) {
  const select = byId('add-instance-select');
  const button = byId('add-instance-button');
  const status = byId('add-instance-status');
  if (!select) return;
  const creatable = instances.filter((instance) => !instance.created);
  const signature = creatable.map((instance) => instance.agentId).join(',');
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;
  select.replaceChildren();
  if (creatable.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'All approved adapters are already registered';
    option.disabled = true;
    select.appendChild(option);
    select.disabled = true;
    if (button) button.disabled = true;
    if (status) status.textContent = 'All approved adapters are already registered.';
    return;
  }
  select.disabled = false;
  if (button) button.disabled = false;
  if (status?.textContent === 'All approved adapters are already registered.') status.textContent = '';
  for (const instance of creatable) {
    const option = document.createElement('option');
    option.value = instance.agentId;
    option.textContent = `${instance.agentId}${instance.implemented ? '' : ' (foundation-only)'}`;
    select.appendChild(option);
  }
}

const FLEET_CELL_LABELS = Object.freeze({
  'cell-state': 'State',
  'cell-readiness': 'Readiness',
  'cell-model': 'Model / profile',
  'cell-surface': 'Surface',
  'cell-cost': 'Cost',
  'cell-load': 'Load',
  'cell-change': 'Last change',
  'cell-actions': 'Actions',
});

/**
 * Rows are keyed by agent id and reused across refreshes: a poll that only
 * changes a readiness string rewrites one text node, never the table.
 */
function renderFleet(instances) {
  const tbody = byId('fleet-rows');
  if (!tbody) return;
  const existing = new Map([...tbody.children].map((row) => [row.dataset.agentId, row]));
  const template = byId('fleet-row-template');

  for (const instance of instances) {
    const summary = view.summariseAgentRow(instance, {
      auditEntries: state.auditEntries,
      currentRevision: state.currentRevision,
    });
    let row = existing.get(instance.agentId);
    if (!row) {
      row = template.content.firstElementChild.cloneNode(true);
      row.dataset.agentId = instance.agentId;
      for (const [className, label] of Object.entries(FLEET_CELL_LABELS)) {
        row.querySelector(`.${className}`)?.setAttribute('data-label', label);
      }
      row.querySelector('.details-button').addEventListener('click', (event) => {
        openDrawer(instance.agentId, event.currentTarget);
      });
      tbody.appendChild(row);
    } else {
      existing.delete(instance.agentId);
    }

    setText(row.querySelector('.agent-name'), summary.agentId);
    setText(row.querySelector('.agent-qualification'), summary.qualification);
    setBadge(row.querySelector('.cell-state .badge'), {
      code: summary.statusCode,
      label: summary.state,
      explanation: summary.stateExplanation,
    });
    setText(row.querySelector('.cell-readiness'), summary.readiness);
    setText(row.querySelector('.cell-model'), summary.modelProfile);
    setText(row.querySelector('.cell-surface'), summary.executionSurface);
    setText(row.querySelector('.cell-cost'), summary.costClass);
    setText(row.querySelector('.cell-load'), summary.loadText);
    setTimeCell(row.querySelector('.cell-change'), summary.lastStateChangeAt);
    row.querySelector('.details-button').textContent = summary.created ? 'Details & controls' : 'Details';
  }

  for (const stale of existing.values()) stale.remove();
}

// -- agent detail drawer ------------------------------------------------

function focusableElements(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
}

function trapFocus(event) {
  const drawer = byId('agent-drawer');
  if (drawer.hidden || event.key !== 'Tab') return;
  const focusable = focusableElements(drawer);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function closeDrawer() {
  const drawer = byId('agent-drawer');
  if (drawer.hidden) return;
  setHidden(drawer, true);
  setHidden(byId('drawer-backdrop'), true);
  state.drawerAgentId = null;
  const returnTo = state.drawerReturnFocus;
  state.drawerReturnFocus = null;
  if (returnTo && document.contains(returnTo)) returnTo.focus();
}

function openDrawer(agentId, returnFocusTo) {
  const instance = state.instances.find((candidate) => candidate.agentId === agentId);
  if (!instance) return;
  state.drawerAgentId = agentId;
  state.drawerReturnFocus = returnFocusTo || null;
  setText(byId('drawer-title'), instance.displayName || instance.agentId);
  const body = byId('drawer-body');
  body.replaceChildren(buildAgentDetail(instance));
  setHidden(byId('drawer-backdrop'), false);
  const drawer = byId('agent-drawer');
  setHidden(drawer, false);
  drawer.focus();
}

function buildAgentDetail(instance) {
  const node = byId('agent-detail-template').content.firstElementChild.cloneNode(true);
  const summary = view.summariseAgentRow(instance, {
    auditEntries: state.auditEntries,
    currentRevision: state.currentRevision,
  });

  setBadge(node.querySelector('.detail-state'), {
    code: summary.statusCode,
    label: summary.state,
    explanation: summary.stateExplanation,
  });
  setText(node.querySelector('.detail-explanation'), summary.stateExplanation);

  setText(node.querySelector('.fact-adapter'), `${instance.agentId} (${instance.adapterType || 'unknown type'})`);
  setText(node.querySelector('.fact-surface'), summary.executionSurface);
  setText(node.querySelector('.fact-qualification'), summary.qualification);
  setText(node.querySelector('.fact-version'), view.describeVersionPolicy(instance));
  const capabilities = view.listSupportedCapabilities(instance.capabilities);
  setText(node.querySelector('.fact-capabilities'), capabilities.length ? capabilities.join(', ') : 'None supported yet.');
  setText(node.querySelector('.fact-model'), summary.modelProfile);
  setText(node.querySelector('.fact-limits'), view.describeContextOutputLimits(instance));
  setText(node.querySelector('.fact-cost'), summary.costClass);
  setText(node.querySelector('.fact-budget'), instance.policy?.requireHumanApproval
    ? 'Human approval required before paid use.'
    : 'No approval requirement recorded.');
  setText(node.querySelector('.fact-quota'), summary.quotaText);
  setText(node.querySelector('.fact-slot'), summary.loadText);
  setText(node.querySelector('.fact-readiness'), summary.readiness);
  setText(node.querySelector('.fact-revision'), summary.revision != null ? String(summary.revision) : '—');
  setTimeCell(node.querySelector('.fact-last-change'), summary.lastStateChangeAt);
  setText(node.querySelector('.fact-auth'), instance.created ? 'Loading…' : 'No instance registered.');

  // -- lifecycle, with the mandatory paid-enable confirmation gate --
  const confirmPanel = node.querySelector('.paid-confirm');
  const notes = node.querySelector('.lifecycle-notes');
  for (const button of node.querySelectorAll('.lifecycle-actions button')) {
    const action = button.dataset.action;
    const availability = view.describeActionAvailability(action, instance);
    button.disabled = !availability.available;
    if (availability.reason) {
      button.title = availability.reason;
      const note = createElement('li', null, `${button.textContent}: ${availability.reason}`);
      notes.appendChild(note);
    }
    button.addEventListener('click', () => {
      if (action === 'enabled' && view.requiresPaidEnableConfirmation(instance)) {
        setText(confirmPanel.querySelector('.paid-confirm-copy'), view.buildPaidEnableConfirmationCopy(instance));
        setHidden(confirmPanel, false);
        confirmPanel.querySelector('.confirm-enable-button').focus();
        return;
      }
      handleLifecycleTransition(instance.agentId, action);
    });
  }
  confirmPanel.querySelector('.confirm-enable-button').addEventListener('click', () => {
    setHidden(confirmPanel, true);
    handleLifecycleTransition(instance.agentId, 'enabled');
  });
  confirmPanel.querySelector('.cancel-enable-button').addEventListener('click', () => {
    setHidden(confirmPanel, true);
  });

  // -- non-secret settings --
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

  // -- write-only credential --
  const secretForm = node.querySelector('.secret-form');
  const secretMessage = node.querySelector('.secret-status-message');
  const authCell = node.querySelector('.fact-auth');
  if (!instance.created) {
    for (const field of secretForm.elements) field.disabled = true;
    setText(authCell, 'No instance registered.');
  } else {
    refreshSecretStatus(instance.agentId, authCell);
    secretForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const action = event.submitter?.dataset.secretAction || 'create';
      handleSecretSubmit(instance.agentId, secretForm, action, secretMessage, authCell);
    });
    secretForm.querySelector('[data-secret-action="remove"]').addEventListener('click', () => {
      handleSecretRemove(instance.agentId, secretMessage, authCell);
    });
  }

  return node;
}

async function refreshSecretStatus(agentId, authCell) {
  const result = await apiFetch(`/api/secrets/${encodeURIComponent(agentId)}`);
  setText(authCell, result.ok ? view.secretStatusLabel(result.json.status.status) : 'Unknown');
}

// -- activity -----------------------------------------------------------

function renderTimeline() {
  const tbody = byId('timeline-rows');
  if (!tbody) return;
  const rows = ops.filterTimeline(
    ops.buildTimeline({ activity: state.overview?.activity || [], audit: state.auditEntries, limit: 80 }),
    state.timelineFilter,
  );
  setText(byId('activity-count'), `${rows.length} event(s) shown`);
  tbody.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement('tr');
    const cell = createElement('td', 'event-empty', 'No matching events in the retained window.');
    cell.colSpan = 5;
    empty.appendChild(cell);
    tbody.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');

    const timeCell = document.createElement('th');
    timeCell.scope = 'row';
    timeCell.textContent = ops.formatClock(row.at);
    timeCell.title = ops.formatUtc(row.at);
    timeCell.setAttribute('data-label', 'Time');
    tr.appendChild(timeCell);

    const sourceCell = document.createElement('td');
    const pill = createElement('span', 'source-pill', row.source === 'runner' ? 'Runner' : 'Operator');
    pill.dataset.source = row.source;
    sourceCell.appendChild(pill);
    tr.appendChild(sourceCell);

    const labelCell = createElement('td', null, row.label);
    if (row.actor) labelCell.appendChild(createElement('div', 'muted small', `by ${row.actor}`));
    tr.appendChild(labelCell);

    const issueCell = document.createElement('td');
    if (row.issueUrl && Number.isFinite(row.issueNumber)) {
      const link = createElement('a', null, `#${row.issueNumber}`);
      link.href = row.issueUrl;
      link.rel = 'noreferrer noopener';
      link.target = '_blank';
      link.title = row.repo || '';
      issueCell.appendChild(link);
    } else {
      issueCell.textContent = Number.isFinite(row.issueNumber) ? `#${row.issueNumber}` : '—';
    }
    tr.appendChild(issueCell);

    const detailCell = createElement('td', null, row.detail || '—');
    if (row.reason) detailCell.appendChild(createElement('div', 'muted small', row.reason));
    if (Number.isFinite(row.revision)) detailCell.appendChild(createElement('div', 'muted small', `revision ${row.revision}`));
    tr.appendChild(detailCell);

    tbody.appendChild(tr);
  }
}

// -- settings & audit ---------------------------------------------------

function renderAuditRows(entries) {
  const tbody = byId('audit-rows');
  if (!tbody) return;
  tbody.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement('tr');
    const cell = createElement('td', 'event-empty', 'No control audit entry recorded yet.');
    cell.colSpan = 5;
    empty.appendChild(cell);
    tbody.appendChild(empty);
    return;
  }
  for (const entry of entries.slice(0, 40)) {
    const row = document.createElement('tr');
    const timeCell = document.createElement('th');
    timeCell.scope = 'row';
    timeCell.textContent = ops.formatClock(entry.at);
    timeCell.title = ops.formatUtc(entry.at);
    row.appendChild(timeCell);
    for (const value of [
      entry.actor,
      entry.action,
      entry.revision != null ? String(entry.revision) : '—',
      Array.isArray(entry.changedFields) ? entry.changedFields.join(', ') : '—',
    ]) {
      row.appendChild(createElement('td', null, value ?? '—'));
    }
    tbody.appendChild(row);
  }
}

function renderRevisionRows(currentRevision, availableRevisions) {
  state.currentRevision = currentRevision;
  state.availableRevisions = availableRevisions;
  setText(byId('current-revision'), currentRevision != null ? String(currentRevision) : null);
  const tbody = byId('revision-rows');
  if (!tbody) return;
  tbody.replaceChildren();
  for (const revisionNumber of availableRevisions) {
    const row = document.createElement('tr');
    const revCell = document.createElement('th');
    revCell.scope = 'row';
    revCell.textContent = String(revisionNumber);
    row.appendChild(revCell);
    row.appendChild(createElement('td', null, revisionNumber === currentRevision ? 'Current' : 'Retained'));

    const actionCell = document.createElement('td');
    if (revisionNumber !== currentRevision) {
      const rollbackButton = createElement('button', 'secondary', 'Roll back');
      rollbackButton.type = 'button';
      rollbackButton.addEventListener('click', () => confirmRollback(revisionNumber, rollbackButton, actionCell));
      actionCell.appendChild(rollbackButton);
    } else {
      actionCell.appendChild(createElement('span', 'muted small', 'Already current'));
    }
    row.appendChild(actionCell);
    tbody.appendChild(row);
  }
}

/** Rollback replaces the whole settings document — deliberate two-step confirmation, in-page, never a native dialog. */
function confirmRollback(targetRevision, triggerButton, container) {
  const panel = createElement('div', 'confirm-panel');
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-label', `Confirm rollback to revision ${targetRevision}`);
  panel.appendChild(createElement('p', null, `Roll the whole agent settings document back to revision ${targetRevision}? The current revision ${state.currentRevision} is retained and can be restored the same way.`));
  const buttons = createElement('div', 'button-row');
  const confirm = createElement('button', 'danger', 'Yes, roll back');
  confirm.type = 'button';
  confirm.addEventListener('click', () => handleRollback(targetRevision));
  const cancel = createElement('button', 'secondary', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    panel.remove();
    triggerButton.hidden = false;
    triggerButton.focus();
  });
  buttons.appendChild(confirm);
  buttons.appendChild(cancel);
  panel.appendChild(buttons);
  triggerButton.hidden = true;
  container.appendChild(panel);
  confirm.focus();
}

// -- mutations ----------------------------------------------------------

async function handleAddInstanceSubmit(event) {
  event.preventDefault();
  const select = byId('add-instance-select');
  const statusEl = byId('add-instance-status');
  const agentId = select.value;
  if (!agentId) return;
  const result = await apiFetch('/api/instances', {
    method: 'POST',
    body: { agentId, expectedRevision: state.currentRevision },
  });
  statusEl.className = `status-text ${result.ok ? 'ok' : 'error'}`;
  setText(statusEl, result.ok ? `Added ${agentId}.` : (result.json?.reason || 'add-instance-failed'));
  if (result.ok) await refreshAll();
}

async function handleLifecycleTransition(agentId, targetState) {
  const result = await apiFetch(`/api/instances/${encodeURIComponent(agentId)}/lifecycle`, {
    method: 'POST',
    body: { targetState, expectedRevision: state.currentRevision },
  });
  if (!result.ok) {
    showGlobalError(`Lifecycle change failed for ${agentId}: ${result.json?.reason || 'unknown-error'}`);
  }
  await refreshAll();
  if (state.drawerAgentId === agentId) openDrawer(agentId, state.drawerReturnFocus);
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
    body: { updates, expectedRevision: state.currentRevision },
  });
  statusEl.className = `status-text settings-status ${result.ok ? 'ok' : 'error'}`;
  // A 409 here is optimistic concurrency doing its job: another writer moved
  // the document on. Say so, and reload so the operator retries against
  // current state rather than clobbering it.
  setText(statusEl, result.ok
    ? 'Saved.'
    : (result.status === 409
      ? 'Settings changed elsewhere since this form loaded (stale revision). Reloaded — review and re-apply.'
      : (result.json?.reason || 'update-failed')));
  await refreshAll();
}

async function handleSecretSubmit(agentId, form, action, messageEl, authCell) {
  const value = form.value.value;
  // Cleared synchronously — before the request settles — so the value never
  // lingers in the DOM regardless of the network round-trip.
  form.value.value = '';
  if (!view.isSecretValueValid(value)) {
    messageEl.className = 'status-text error-text';
    setText(messageEl, 'A non-empty credential value is required.');
    return;
  }
  const path = action === 'rotate'
    ? `/api/secrets/${encodeURIComponent(agentId)}/rotate`
    : `/api/secrets/${encodeURIComponent(agentId)}`;
  const result = await apiFetch(path, { method: 'POST', body: view.buildSecretRequestBody(value) });
  messageEl.className = `status-text ${result.ok ? 'ok' : 'error'}`;
  setText(messageEl, result.ok
    ? `Credential ${action === 'rotate' ? 'rotated' : 'created'}.`
    : (result.json?.reason || 'secret-operation-failed'));
  if (result.ok) setText(authCell, view.secretStatusLabel(result.json.status));
}

async function handleSecretRemove(agentId, messageEl, authCell) {
  const result = await apiFetch(`/api/secrets/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  messageEl.className = `status-text ${result.ok ? 'ok' : 'error'}`;
  setText(messageEl, result.ok ? 'Credential removed.' : (result.json?.reason || 'secret-remove-failed'));
  if (result.ok) setText(authCell, view.secretStatusLabel(result.json.status));
}

async function handleRollback(targetRevision) {
  const result = await apiFetch('/api/settings/rollback', { method: 'POST', body: { targetRevision } });
  if (!result.ok) {
    showGlobalError(`Rollback failed: ${result.json?.reason || 'unknown-error'}`);
    return;
  }
  await refreshAll();
}

// -- login / logout -----------------------------------------------------

async function handleLoginSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.username.value;
  const password = form.password.value;
  // Cleared synchronously, before the request settles.
  form.password.value = '';
  setHidden(byId('login-error'), true);

  const result = await apiFetch('/api/session/login', { method: 'POST', body: { username, password } });
  if (!result.ok) {
    setText(byId('login-error'), result.json?.reason || 'sign-in-failed');
    setHidden(byId('login-error'), false);
    return;
  }
  sessionState.csrfToken = result.json.csrfToken;
  showShell(username);
  await refreshAll();
  startRefreshLoop();
}

async function bootstrapSession() {
  const result = await apiFetch('/api/session');
  if (!result.ok || !result.json?.csrfToken || !result.json?.username) {
    sessionState.csrfToken = null;
    showLogin();
    return;
  }
  sessionState.csrfToken = result.json.csrfToken;
  showShell(result.json.username);
  await refreshAll();
  if (sessionState.csrfToken) startRefreshLoop();
}

async function handleLogout() {
  await apiFetch('/api/session/logout', { method: 'POST' });
  sessionState.csrfToken = null;
  closeDrawer();
  state.overview = null;
  state.instances = [];
  state.auditEntries = [];
  state.lastSignature = null;
  byId('fleet-rows')?.replaceChildren();
  byId('timeline-rows')?.replaceChildren();
  byId('audit-rows')?.replaceChildren();
  byId('revision-rows')?.replaceChildren();
  showLogin();
}

// -- refresh ------------------------------------------------------------

function announce(overview) {
  const signature = ops.statusSignature(overview);
  const message = ops.buildStatusAnnouncement(state.lastSignature, signature);
  state.lastSignature = signature;
  if (message) setText(byId('live-region'), message);
}

async function refreshAll() {
  if (inFlight) return;
  inFlight = true;
  try {
    const [overviewResult, instancesResult, auditResult, revisionsResult] = await Promise.all([
      apiFetch('/api/overview'),
      apiFetch('/api/instances'),
      apiFetch('/api/audit?limit=50'),
      apiFetch('/api/settings/revisions'),
    ]);

    if (instancesResult.status === 401 || overviewResult.status === 401) {
      sessionState.csrfToken = null;
      showLogin();
      return;
    }
    if (!instancesResult.ok) {
      showGlobalError(`Failed to load instances: ${instancesResult.json?.reason || 'unknown-error'}`);
      return;
    }

    state.lastFetchedAt = new Date().toISOString();
    state.instances = instancesResult.json.instances || [];
    state.auditEntries = auditResult.ok ? (auditResult.json.entries || []) : [];
    if (revisionsResult.ok) {
      renderRevisionRows(revisionsResult.json.currentRevision, revisionsResult.json.availableRevisions || []);
    }

    if (overviewResult.ok) {
      state.overview = overviewResult.json;
    } else {
      // Never render a failed read as healthy.
      state.overview = {
        ok: false,
        schemaVersion: null,
        runner: { code: 'unavailable', label: 'Overview unavailable', explanation: `The overview read failed (${overviewResult.json?.reason || 'unknown-error'}).`, nextAction: 'Check the control service logs on this machine.' },
        scheduler: { code: 'unknown', label: 'Unknown', explanation: 'Not reported because the overview read failed.' },
        currentTask: { state: 'unknown', active: false },
        queue: {}, runs: {}, quota: {}, health: {}, attention: {}, activity: [], links: {}, project: {},
      };
    }

    renderAddInstanceOptions(state.instances);
    renderFleet(state.instances);
    renderOverview(state.overview);
    renderAuditRows(state.auditEntries);
    renderTimeline();
    announce(state.overview);
    scheduleElapsedTick();
  } finally {
    inFlight = false;
  }
}

/**
 * Keeps the elapsed value honest between polls by re-rendering exactly one
 * text node once a second while a run is active — no refetch, no reflow of
 * anything else, and no timer at all when nothing is running or the tab is
 * hidden.
 */
function scheduleElapsedTick() {
  window.clearInterval(elapsedTimer);
  elapsedTimer = null;
  const task = state.overview?.currentTask;
  if (!task?.active || !task.startedAt || document.hidden) return;
  elapsedTimer = window.setInterval(() => {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(task.startedAt)) / 1000));
    setText(byId('task-elapsed'), ops.formatElapsed(seconds));
    setTimeCell(byId('last-updated'), state.lastFetchedAt, { relative: true });
  }, 1000);
}

function stopRefreshLoop() {
  window.clearTimeout(refreshTimer);
  window.clearInterval(elapsedTimer);
  refreshTimer = null;
  elapsedTimer = null;
}

function startRefreshLoop() {
  window.clearTimeout(refreshTimer);
  const delay = ops.nextRefreshDelayMs({
    visible: !document.hidden,
    activeRun: Boolean(state.overview?.currentTask?.active),
  });
  // `null` means "hidden tab": do no work at all until it becomes visible.
  if (delay === null) return;
  refreshTimer = window.setTimeout(async () => {
    if (sessionState.csrfToken) await refreshAll();
    startRefreshLoop();
  }, delay);
}

// -- theme --------------------------------------------------------------

const THEME_ORDER = ['system', 'light', 'dark'];
const THEME_LABELS = { system: 'Theme: follow system', light: 'Theme: light', dark: 'Theme: dark' };

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.theme);
  const button = byId('theme-button');
  if (button) {
    button.title = THEME_LABELS[state.theme];
    button.setAttribute('aria-pressed', state.theme === 'dark' ? 'true' : 'false');
    setText(button.querySelector('.visually-hidden'), `${THEME_LABELS[state.theme]} (memory-only; resets on reload)`);
  }
}

function cycleTheme() {
  state.theme = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
  applyTheme();
}

// -- init ---------------------------------------------------------------

function handleHashChange() {
  selectSection((window.location.hash || '#overview').slice(1));
}

function init() {
  renderNav();
  handleHashChange();
  applyTheme();

  byId('login-form').addEventListener('submit', handleLoginSubmit);
  byId('logout-button').addEventListener('click', handleLogout);
  byId('add-instance-form').addEventListener('submit', handleAddInstanceSubmit);
  byId('refresh-button').addEventListener('click', () => { if (sessionState.csrfToken) refreshAll(); });
  byId('theme-button').addEventListener('click', cycleTheme);
  byId('drawer-close').addEventListener('click', closeDrawer);
  byId('drawer-backdrop').addEventListener('click', closeDrawer);

  window.addEventListener('hashchange', handleHashChange);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
    trapFocus(event);
  });
  document.addEventListener('click', (event) => {
    const target = event.target.closest('a[data-nav]');
    if (!target || target.closest('#nav-list')) return;
    // In-page section links keep hash routing as the single source of truth.
    window.location.hash = `#${target.dataset.nav}`;
  });

  for (const control of ['activity-query', 'activity-source']) {
    byId(control).addEventListener('input', () => {
      state.timelineFilter = {
        query: byId('activity-query').value,
        source: byId('activity-source').value,
      };
      renderTimeline();
    });
  }

  // A hidden tab does no polling and runs no timer; becoming visible
  // refreshes once immediately so the operator never reads a stale screen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopRefreshLoop();
      return;
    }
    if (sessionState.csrfToken) {
      refreshAll().then(startRefreshLoop);
    }
  });

  bootstrapSession();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}