/**
 * Pure, framework-free view/derivation helpers for the operations console
 * (issue #175). Same contract as `agents-dashboard-view.mjs`: nothing here
 * touches the DOM, `fetch`, `window`, `document` or any Node built-in, so
 * every derivation that decides what an operator sees is unit-testable
 * without a browser or a DOM shim.
 *
 * This module formats only fields the authenticated `/api/overview`
 * projection already allowlists. It has no way to reach a secret value,
 * credential, prompt, provider output, session handle or filesystem path,
 * because none of those are ever sent to this client — and it deliberately
 * adds no "render whatever the server sent" escape hatch: every field it
 * displays is named explicitly below.
 */

/**
 * The status vocabulary, shared conceptually with Grafana. Kept
 * byte-identical to `STATUS_VOCABULARY` in
 * `scripts/ops/agent-runner-control-overview.mjs`; a test asserts the two
 * lists match, so the server can never emit a state this client would
 * render as "unknown" by accident.
 */
export const STATUS_VOCABULARY = Object.freeze([
  'healthy',
  'idle',
  'running',
  'disabled',
  'paused',
  'draining',
  'degraded',
  'blocked',
  'attention',
  'unavailable',
  'unsupported',
  'stale',
  'unknown',
]);

export const NAV_SECTIONS = Object.freeze([
  Object.freeze({ id: 'overview', label: 'Overview', icon: 'icon-overview' }),
  Object.freeze({ id: 'agents', label: 'Agents', icon: 'icon-agents' }),
  Object.freeze({ id: 'activity', label: 'Activity', icon: 'icon-activity' }),
  Object.freeze({ id: 'settings', label: 'Settings & audit', icon: 'icon-settings' }),
]);

const TONE_BY_STATUS = Object.freeze({
  healthy: 'ok',
  idle: 'neutral',
  running: 'active',
  disabled: 'neutral',
  paused: 'warn',
  draining: 'warn',
  degraded: 'warn',
  blocked: 'critical',
  attention: 'critical',
  unavailable: 'critical',
  unsupported: 'neutral',
  stale: 'warn',
  unknown: 'neutral',
});

/**
 * A non-colour redundant marker for every status. Colour is a *secondary*
 * signal only (#175 accessibility): a badge always renders its label text
 * and this glyph, so the state survives greyscale, colour-blindness and a
 * monochrome print.
 */
const GLYPH_BY_TONE = Object.freeze({
  ok: '✓',
  active: '▶',
  warn: '!',
  critical: '✕',
  neutral: '–',
});

export function normalizeStatusCode(code) {
  return STATUS_VOCABULARY.includes(code) ? code : 'unknown';
}

export function statusTone(code) {
  return TONE_BY_STATUS[normalizeStatusCode(code)] || 'neutral';
}

export function statusGlyph(code) {
  return GLYPH_BY_TONE[statusTone(code)] || '–';
}

/**
 * Never renders a missing status as healthy: an absent/!unrecognised status
 * object degrades to `unknown` with an explicit explanation rather than to
 * an empty badge.
 */
export function describeStatus(statusObject) {
  const code = normalizeStatusCode(statusObject?.code);
  return {
    code,
    tone: statusTone(code),
    glyph: statusGlyph(code),
    label: statusObject?.label || 'Unknown',
    explanation: statusObject?.explanation || 'No explanation was provided for this state.',
    nextAction: statusObject?.nextAction || null,
  };
}

// -- time formatting ---------------------------------------------------

export function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

/** Operator-local wall-clock rendering; `formatUtc()` supplies the precise UTC value for the tooltip. */
export function formatClock(iso) {
  if (!iso) return '—';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

export function formatUtc(iso) {
  if (!iso) return '';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '' : `${parsed.toISOString()} (UTC)`;
}

export function formatRelative(iso, nowMs = Date.now()) {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  const deltaSeconds = Math.round((nowMs - parsed) / 1000);
  if (deltaSeconds < 0) return 'in the future';
  if (deltaSeconds < 45) return 'just now';
  return `${formatElapsed(deltaSeconds)} ago`;
}

export function formatPercentValue(value) {
  return Number.isFinite(value) ? `${value}%` : '—';
}

export function formatCount(value) {
  return Number.isFinite(value) ? String(value) : '—';
}

// -- overview derivations ---------------------------------------------

/**
 * The current-task headline. When nothing is running this returns the
 * explicit idle sentence required by #175 ("Idle — no runnable task
 * currently selected") or the more specific safe reason the server sent,
 * never a blank area.
 */
export function describeCurrentTask(task, { nowMs = Date.now() } = {}) {
  if (!task || task.state === 'unknown') {
    return {
      active: false,
      tone: 'neutral',
      headline: 'Current task unknown',
      detail: task?.message || 'The runner did not report a current-task state.',
      elapsedText: '—',
    };
  }
  if (!task.active) {
    const hasPrevious = Number.isFinite(task.issueNumber);
    return {
      active: false,
      tone: 'neutral',
      headline: 'Idle — no runnable task currently selected',
      detail: task.message
        || (hasPrevious ? 'Showing the most recent recorded issue activity only.' : 'No selected, claimed or executed issue is recorded.'),
      elapsedText: '—',
      previousIssueNumber: hasPrevious ? task.issueNumber : null,
    };
  }
  const elapsed = Number.isFinite(task.elapsedSeconds)
    ? task.elapsedSeconds
    : (task.startedAt ? Math.max(0, Math.round((nowMs - Date.parse(task.startedAt)) / 1000)) : null);
  return {
    active: true,
    tone: 'active',
    headline: task.repo && Number.isFinite(task.issueNumber)
      ? `${task.repo} #${task.issueNumber}`
      : 'Active run (issue identity not recorded)',
    detail: task.message || 'A claim has no later terminal run result in the retained history.',
    elapsedText: formatElapsed(elapsed),
  };
}

/**
 * "Actively running" vs "awaiting a gate/review" (#175 current-task
 * experience). The runner records a claim without a terminal result for
 * both, so the distinguishing evidence is an unresolved attention event or
 * an open health condition for the same issue — reported honestly as
 * `awaiting-attention` rather than guessed.
 */
export function classifyRunPosture(task, attention) {
  if (!task?.active) return { code: 'idle', label: 'Not running' };
  const issueNumber = task.issueNumber;
  const waiting = (attention?.events || []).some((event) => event.issueNumber === issueNumber);
  if (waiting) return { code: 'awaiting-attention', label: 'Awaiting human attention' };
  return { code: 'running', label: 'Actively running' };
}

export function summariseQueue(queue) {
  const skipped = Number.isFinite(queue?.skippedIssueCount) ? queue.skippedIssueCount : 0;
  const reasons = Array.isArray(queue?.skipReasons) ? queue.skipReasons : [];
  return {
    skippedIssueCount: skipped,
    skipEventCount: Number.isFinite(queue?.skipEventCount) ? queue.skipEventCount : 0,
    distinctReasonCount: reasons.length,
    topReasons: reasons.slice(0, 5),
    assignments: Array.isArray(queue?.assignments) ? queue.assignments : [],
    oldestQueuedOrSkippedAt: queue?.oldestQueuedOrSkippedAt || null,
    /**
     * Deliberately not a "runnable count": nothing in the canonical
     * projection proves how many issues are currently *eligible* — only how
     * many were selected or skipped in the retained window. Claiming a
     * runnable total here would be inventing a number.
     */
    runnableClaim: 'Runnable eligibility is proven per scheduler pass, not counted here.',
  };
}

export function describeQuota(quota) {
  if (!quota || quota.tracked !== true) {
    return {
      tracked: false,
      summary: 'No included-quota usage recorded in the retained window.',
      sessionText: '—',
      weeklyText: '—',
      costNote: 'Paid/credit-backed routing is OFF. No billing balance is implied — this runner cannot prove one.',
    };
  }
  return {
    tracked: true,
    summary: `Session headroom ${formatPercentValue(quota.sessionHeadroomPercent)}, weekly headroom ${formatPercentValue(quota.weeklyHeadroomPercent)}.`,
    sessionText: `${formatPercentValue(quota.sessionUsagePercent)} used`,
    weeklyText: `${formatPercentValue(quota.weeklyUsagePercent)} used`,
    costNote: quota.paidRoutingEnabled
      ? 'Paid/credit-backed routing is ON.'
      : 'Paid/credit-backed routing is OFF. No billing balance is implied — this runner cannot prove one.',
  };
}

/** Fleet readiness roll-up for the Overview tile, from the instance list the Agents view already loads. */
export function summariseFleet(instances = []) {
  const counts = { enabled: 0, paused: 0, draining: 0, disabled: 0, unavailable: 0, unsupported: 0 };
  for (const instance of instances) {
    const state = instance?.state;
    if (state && Object.prototype.hasOwnProperty.call(counts, state)) counts[state] += 1;
  }
  const ready = instances.filter((instance) => instance?.state === 'enabled' && instance?.readiness?.ok === true).length;
  return {
    total: instances.length,
    ready,
    counts,
    constrained: counts.paused + counts.draining + counts.unavailable,
  };
}

// -- activity ----------------------------------------------------------

const ACTIVITY_LABELS = Object.freeze({
  selection: 'Issue selected',
  claim: 'Issue claimed',
  'run-result': 'Run result',
  'queue-event': 'Queue event',
  attention: 'Attention event',
});

export function activityEventLabel(event) {
  return ACTIVITY_LABELS[event?.kind] || 'Runner event';
}

export function activityEventTone(event) {
  if (event?.kind === 'attention') return event.resolved ? 'neutral' : 'critical';
  if (event?.kind === 'run-result') {
    if (event.outcome === 'failed') return 'critical';
    if (event.outcome === 'succeeded') return 'ok';
    return 'warn';
  }
  if (event?.kind === 'queue-event') return 'warn';
  if (event?.kind === 'claim') return 'active';
  return 'neutral';
}

/**
 * Operator configuration changes (`/api/audit`) and runner activity
 * (`/api/overview`) are merged into one chronological timeline but keep a
 * distinct `source`, so "the runner did this" is never confused with "an
 * operator changed this". Bounded to `limit` entries — the in-browser
 * timeline never grows unbounded across refreshes.
 */
export function buildTimeline({ activity = [], audit = [], limit = 80 } = {}) {
  const runnerRows = activity.map((event) => ({
    source: 'runner',
    at: event.at,
    label: activityEventLabel(event),
    tone: activityEventTone(event),
    repo: event.repo || null,
    issueNumber: event.issueNumber ?? null,
    issueUrl: event.issueUrl || null,
    detail: event.detail || null,
    reason: event.reason || null,
    agent: event.agent || null,
  }));
  const auditRows = audit.map((entry) => ({
    source: 'operator',
    at: entry.at,
    label: entry.action ? `Operator: ${entry.action}` : 'Operator change',
    tone: 'info',
    repo: null,
    issueNumber: null,
    issueUrl: null,
    detail: Array.isArray(entry.changedFields) && entry.changedFields.length ? entry.changedFields.join(', ') : null,
    reason: null,
    actor: entry.actor || null,
    revision: Number.isFinite(entry.revision) ? entry.revision : null,
  }));
  return [...runnerRows, ...auditRows]
    .filter((row) => Boolean(row.at))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, limit);
}

/** Filters only over already-loaded bounded fields — never a server round-trip, never a free-text query to any API. */
export function filterTimeline(rows, { query = '', source = 'all' } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  return rows.filter((row) => {
    if (source !== 'all' && row.source !== source) return false;
    if (!needle) return true;
    const haystack = [row.label, row.detail, row.reason, row.repo, row.agent, row.actor, row.issueNumber]
      .filter((value) => value !== null && value !== undefined)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

// -- announcements -----------------------------------------------------

/**
 * `aria-live` announcements for *meaningful* changes only. Polling every
 * few seconds must not re-announce an unchanged state, so this returns
 * `null` unless one of the tracked status codes actually moved.
 */
export function buildStatusAnnouncement(previous, next) {
  if (!next) return null;
  const parts = [];
  if (previous?.runner !== next.runner) parts.push(`Runner ${next.runner}`);
  if (previous?.scheduler !== next.scheduler) parts.push(`Scheduler ${next.scheduler}`);
  if (previous?.task !== next.task) parts.push(`Current task ${next.task}`);
  if (previous?.attention !== next.attention) parts.push(`${next.attention} unresolved attention event(s)`);
  return parts.length ? parts.join('. ') : null;
}

export function statusSignature(overview) {
  return {
    runner: normalizeStatusCode(overview?.runner?.code),
    scheduler: normalizeStatusCode(overview?.scheduler?.code),
    task: overview?.currentTask?.active ? 'running' : (overview?.currentTask?.state || 'unknown'),
    attention: Number.isFinite(overview?.attention?.unresolvedCount) ? overview.attention.unresolvedCount : 0,
  };
}

/**
 * Refresh cadence. Live state refreshes no faster than it needs to, and a
 * hidden tab does no work at all (#175 performance requirements) — the
 * caller pauses rather than polls when this returns `null`.
 */
export function nextRefreshDelayMs({ visible = true, activeRun = false, baseMs = 15000, activeMs = 8000 } = {}) {
  if (!visible) return null;
  return activeRun ? activeMs : baseMs;
}

/** Link targets are rendered only when the operator configured them; otherwise the UI says so rather than showing a dead control. */
export function describeLink(url, { label, unavailableNote }) {
  return url
    ? { available: true, url, label }
    : { available: false, url: null, label, note: unavailableNote };
}
