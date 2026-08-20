import { spawnSync } from 'node:child_process';

import { loadAgentRunnerConfig, projectIdentity } from './agent-runner-config.mjs';
import { readOnlyRunnerStateSnapshot, unitState } from './agent-runner-operator-doctor.mjs';
import { readCircuitState } from './agent-runner-operator-status.mjs';
import { buildRunnerActivity, buildRunnerMetrics, buildRunnerOperatorStatus } from './claude-runner-dashboard-api.mjs';
import { defaultRunnerStateDbPath } from './claude-runner-state.mjs';
import { attentionEventIdentity, buildAttentionReconciliationProjection } from './agent-runner-attention-reconciliation.mjs';
import { resolveAttentionReconciliationDbPath } from './agent-runner-attention-reconciliation-path.mjs';
import { readAttentionReconciliationState } from './agent-runner-attention-reconciliation-store.mjs';

/**
 * The smallest authenticated read-only operational projection needed to
 * render the standalone dashboard's Overview/Activity views (issue #175).
 *
 * Canonical-by-construction, not canonical-by-imitation. The state read is
 * `readOnlyRunnerStateSnapshot()` and the derivations are
 * `buildRunnerActivity()` / `buildRunnerMetrics()` /
 * `buildRunnerOperatorStatus()` — the exact same read path and the exact
 * same pure functions `agent-runner-operator-status.mjs` composes for the
 * `status` CLI. This module adds no business logic of its own: everything
 * below `buildOverviewProjection()` is presentation-layer *narrowing*
 * (allowlisting, bounding, labelling), never a second opinion about what
 * the runner is doing. `agent-runner-control-overview.test.mjs` asserts
 * field-for-field parity against `buildOperatorStatus()` for the same
 * database so the dashboard and the CLI cannot silently disagree.
 *
 * Read-only, by the same argument the operator CLI already relies on:
 * `readOnlyRunnerStateSnapshot()` takes a private snapshot copy (SQLite
 * Online Backup API when a WAL sidecar is live, a stat-verified quiescent
 * copy otherwise) and opens *that*, so nothing here can create, migrate or
 * write the live runner state database — not even a `-shm` sidecar. It
 * deliberately does not use `buildRunnerDashboard()`/`summarizeRunnerState()`,
 * whose `RunnerStateStore` constructor creates directories and opens SQLite
 * writable.
 *
 * Positive allowlist, enforced at the field level. Everything that reaches
 * the wire passes through `boundedText()`/`boundedReason()`/
 * `boundedCount()`/`boundedTimestamp()`. Specifically NOT forwarded, at any
 * nesting depth: `dbPath` and every other filesystem path (including
 * `projectIdentity().localRepoPath`), prompts, provider output, raw error
 * strings, manager packet or comment bodies, tokens, credentials, session
 * handles, and the raw `latest.*` rows themselves — those exist only as
 * inputs to the canonical pure functions above.
 */

export const OVERVIEW_SCHEMA_VERSION = 'agent-runner-control-overview/v1';

/**
 * The one status vocabulary shared conceptually with Grafana (#175). The
 * browser view module carries the same list; a test asserts the two stay
 * identical, so a state can never be rendered under a name the server does
 * not know (or vice versa).
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

const MAX_TEXT = 200;
const MAX_REASON = 160;
const MAX_LIST = 12;
const MAX_ACTIVITY = 40;
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** A scheduler poll older than this, while the timer is installed, is reported as `stale` rather than as healthy silence. */
export const STALE_POLL_SECONDS = 45 * 60;

function boundedText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Control characters are the only thing stripped here; the value is otherwise passed through verbatim and bounded.
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

/**
 * Reason/next-action strings are runner-authored codes and fixed operator
 * sentences, never provider output — but they are the only strings here
 * with any free-text surface at all, so absolute/home-relative paths are
 * replaced wholesale before bounding. Belt and braces for "no path values".
 */
export function boundedReason(value) {
  const text = boundedText(value, MAX_REASON);
  if (text === null) return null;
  return text
    .replace(/(?:~|(?:[A-Za-z]:)?)(?:\/[\w.@-]+){2,}\/?/g, '[path-redacted]')
    .slice(0, MAX_REASON);
}

function boundedCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function boundedPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function boundedTimestamp(value) {
  const text = boundedText(value, 40);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function boundedIssueNumber(value) {
  return Number.isInteger(value) && value > 0 && value < 10_000_000 ? value : null;
}

function boundedRepo(value) {
  const text = boundedText(value, 200);
  return text && REPO_SLUG.test(text) ? text : null;
}

/** Only ever built from an already-validated `owner/repo` slug and a positive integer. */
export function issueUrl(repo, issueNumber) {
  const slug = boundedRepo(repo);
  const number = boundedIssueNumber(issueNumber);
  return slug && number ? `https://github.com/${slug}/issues/${number}` : null;
}

/**
 * Operator-configured companion links (Grafana, the retained legacy static
 * dashboard). Absolute `http(s)` URLs only, length-bounded, with any
 * userinfo/credential component rejected outright — the dashboard renders
 * these as anchors and never fetches them, so an unreachable Grafana can
 * never affect this page.
 */
export function projectLinks(env = process.env) {
  const read = (name) => {
    const raw = boundedText(env?.[name], 300);
    if (!raw) return null;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  };
  return {
    grafanaRunnerUrl: read('AGENT_RUNNER_GRAFANA_RUNNER_URL'),
    grafanaOperationsUrl: read('AGENT_RUNNER_GRAFANA_OPERATIONS_URL'),
    legacyDashboardUrl: read('AGENT_RUNNER_LEGACY_DASHBOARD_URL'),
  };
}

// -- status derivation -------------------------------------------------

/**
 * One status record: a vocabulary `code`, a human label, a concise
 * explanation, and — for anything that is not plainly healthy — the next
 * operator action. Missing data is never `healthy`; it is `unavailable`,
 * `stale` or `unknown` with an explanation.
 */
function status(code, label, explanation, nextAction = null) {
  return {
    code: STATUS_VOCABULARY.includes(code) ? code : 'unknown',
    label,
    explanation: boundedReason(explanation),
    nextAction: boundedReason(nextAction),
  };
}

export function deriveRunnerStatus({ snapshot, operatorStatus, activity, circuit }) {
  if (!snapshot?.ok) {
    return status(
      'unavailable',
      'Runner state unavailable',
      `Runner state could not be read (${snapshot?.reason || 'unknown-reason'}).`,
      snapshot?.safeNextAction,
    );
  }
  if (operatorStatus?.code === 'global_systemic_pause') {
    return status('blocked', 'Globally paused', operatorStatus.reason || 'A systemic safety fault paused the whole runner.', 'Clear the systemic condition before any further work can be admitted.');
  }
  if (circuit?.blocked) {
    return status('blocked', 'Admission circuit tripped', `Candidate admission is blocked (${circuit.reason || 'unknown-reason'}).`, circuit.safeNextAction);
  }
  if (operatorStatus?.code === 'attention_required') {
    return status('attention', 'Attention required', `${operatorStatus.count || 0} unresolved attention event(s) are waiting on a human.`, 'Review the unresolved attention events and resolve or reassign them.');
  }
  if (operatorStatus?.code === 'attention_reconciliation_degraded') {
    return status('degraded', 'Attention state uncertain',
      `${operatorStatus.unknownCount || 0} unknown and ${operatorStatus.staleCount || 0} stale attention event(s) cannot be classified safely.`,
      'Restore fresh GitHub reconciliation or provide an exact-evidence acknowledgement.');
  }
  if (operatorStatus?.code === 'queue_inspection_degraded') {
    return status('degraded', 'Queue inspection degraded', operatorStatus.reason || 'GitHub could not be reached to check for eligible work, so "no eligible work" is unproven.', 'Restore GitHub reachability, then re-check queue inspection.');
  }
  if (operatorStatus?.code === 'task_local_quarantines') {
    return status('degraded', 'Task-local quarantines', `${operatorStatus.count || 0} quarantined queue event(s) while the timer stays healthy.`, 'Inspect the quarantined issues; the rest of the queue keeps moving.');
  }
  if (activity?.activeIssue) {
    return status('running', 'Running', 'An issue is claimed with no later terminal run result recorded.');
  }
  if (operatorStatus?.code === 'queue_moving') {
    return status('healthy', 'Healthy', 'The timer is healthy and the queue is moving; nothing is currently claimed.');
  }
  if (operatorStatus?.code === 'idle') {
    return status('idle', 'Idle', 'Idle with no eligible work — no runnable task is currently selected.');
  }
  return status('unknown', 'Unknown', 'The runner reported a status this dashboard does not recognise.', 'Check the operator CLI status output.');
}

/**
 * Unattended execution readiness, from systemd unit state only. Both units
 * must be installed *and* the timer active for this to read healthy; a unit
 * systemd could not be inspected at all is `unknown`, never healthy.
 */
export function deriveSchedulerStatus({ service, timer, lastPollAt, nowMs }) {
  if (service?.status === 'unavailable' || timer?.status === 'unavailable') {
    return status('unknown', 'Scheduler state unknown', 'systemd could not be inspected, so unattended execution cannot be confirmed either way.', 'Check the user systemd bus on this machine.');
  }
  if (service?.status !== 'installed' || timer?.status !== 'installed') {
    return status('disabled', 'Unattended execution not installed', 'The runner service and timer units are not both installed, so nothing runs unattended.', 'Install the user service and timer units to enable unattended execution.');
  }
  if (timer.activeState && timer.activeState !== 'active') {
    return status('paused', 'Timer not active', `The timer unit is installed but ${timer.activeState}.`, 'Start the timer unit to resume unattended execution.');
  }
  const pollMs = lastPollAt ? Date.parse(lastPollAt) : NaN;
  if (Number.isFinite(nowMs) && Number.isFinite(pollMs) && (nowMs - pollMs) / 1000 > STALE_POLL_SECONDS) {
    return status('stale', 'No recent scheduler poll', `The timer is active but the most recent recorded poll is older than ${Math.round(STALE_POLL_SECONDS / 60)} minutes.`, 'Check the timer and service journal for failed or skipped runs.');
  }
  if (!lastPollAt) {
    return status('unknown', 'No scheduler poll recorded', 'The units are installed and active but no poll is present in the retained history.', 'Wait for the next timer firing, or check the service journal.');
  }
  return status('healthy', 'Unattended execution enabled', 'The runner service and timer are installed and the timer is active.');
}

// -- projections -------------------------------------------------------

function projectAgentEvidence(row) {
  return {
    agent: boundedText(row?.agent, 64),
    assignmentLabel: boundedText(row?.assignment_label, 64),
    assignmentDisplayName: boundedText(row?.assignment_display_name, 64),
  };
}

/**
 * The current-task block. When nothing is active this is explicitly
 * `idle`/`empty` with the canonical message, never a blank object — "never
 * display missing data as healthy" applies to absence of work too.
 */
export function projectCurrentTask(activity, { nowMs } = {}) {
  const row = activity?.activeIssue || null;
  const latest = activity?.latestIssue || null;
  const source = row || latest;
  const startedAt = boundedTimestamp(source?.timestamp);
  const elapsedSeconds = row && startedAt && Number.isFinite(nowMs)
    ? Math.max(0, Math.round((nowMs - Date.parse(startedAt)) / 1000))
    : null;
  return {
    state: activity?.status === 'active-or-unresolved' ? 'running' : (activity?.status || 'unknown'),
    active: Boolean(row),
    message: boundedReason(activity?.message),
    repo: boundedRepo(source?.repo),
    issueNumber: boundedIssueNumber(source?.issue_number),
    issueUrl: issueUrl(source?.repo, source?.issue_number),
    kind: boundedText(source?.kind, 32),
    phase: boundedText(source?.mode, 48),
    statusLabel: boundedText(source?.status_label, 64),
    exitCode: Number.isInteger(source?.exit_code) ? source.exit_code : null,
    startedAt,
    elapsedSeconds,
    ...projectAgentEvidence(source),
  };
}

export function projectQueue(metrics) {
  const queue = metrics?.queue || {};
  return {
    skipEventCount: boundedCount(queue.skipEventCount) ?? 0,
    skippedIssueCount: boundedCount(queue.skippedIssueCount) ?? 0,
    skipReasonCount: boundedCount(queue.skipReasonCount) ?? 0,
    oldestQueuedOrSkippedAt: boundedTimestamp(queue.oldestQueuedOrSkippedAt),
    skipReasons: (Array.isArray(queue.skipReasons) ? queue.skipReasons : []).slice(0, MAX_LIST).map((entry) => ({
      reason: boundedReason(entry?.reason),
      count: boundedCount(entry?.count) ?? 0,
      latestAt: boundedTimestamp(entry?.latestAt),
    })),
    assignments: (Array.isArray(queue.assignments) ? queue.assignments : []).slice(0, MAX_LIST).map((entry) => ({
      assignmentLabel: boundedText(entry?.assignmentLabel, 64),
      assignmentDisplayName: boundedText(entry?.assignmentDisplayName, 64),
      issueCount: boundedCount(entry?.issueCount) ?? 0,
    })),
  };
}

export function projectRuns(metrics) {
  const runs = metrics?.runs || {};
  return {
    schedulerPolls: boundedCount(runs.schedulerPolls) ?? 0,
    issueRuns: boundedCount(runs.issueRuns) ?? 0,
    noSelectionPolls: boundedCount(runs.noSelectionPolls) ?? 0,
    quotaBlockedPolls: boundedCount(runs.quotaBlockedPolls) ?? 0,
    succeeded: boundedCount(runs.succeeded) ?? 0,
    failed: boundedCount(runs.failed) ?? 0,
    averageDurationSeconds: boundedCount(runs.averageDurationSeconds),
  };
}

/**
 * Included-quota headroom, from the same bounded `quota_history` projection
 * the static dashboard has always used: usage percentages and a blocked-poll
 * count. Deliberately no billing balance and no spend figure — this runner
 * cannot positively prove either, so it must not imply one.
 */
export function projectQuota(metrics) {
  const quota = metrics?.quota || {};
  const session = boundedPercent(quota.latestSessionUsagePercent);
  const weekly = boundedPercent(quota.latestWeeklyUsagePercent);
  const blockedCount = boundedCount(quota.blockedCount) ?? 0;
  const tracked = session !== null || weekly !== null;
  return {
    tracked,
    sessionUsagePercent: session,
    weeklyUsagePercent: weekly,
    sessionHeadroomPercent: session === null ? null : Math.round((100 - session) * 10) / 10,
    weeklyHeadroomPercent: weekly === null ? null : Math.round((100 - weekly) * 10) / 10,
    blockedPollCount: blockedCount,
    paidRoutingEnabled: false,
    admission: blockedCount > 0
      ? status('degraded', 'Quota-blocked polls recorded', `${blockedCount} poll(s) in the retained window were blocked on included-quota admission.`, 'Wait for the included quota window to reset before expecting new work.')
      : (tracked
        ? status('healthy', 'Included quota admitting work', 'No quota-blocked poll is present in the retained window.')
        : status('unknown', 'Quota not tracked', 'No included-quota usage has been recorded in the retained window.', 'Quota state appears once the runner records a provider usage sample.')),
  };
}

export function projectHealth(currentHealthConditions = []) {
  const rows = Array.isArray(currentHealthConditions) ? currentHealthConditions : [];
  return {
    unresolvedCount: rows.length,
    conditions: rows.slice(0, MAX_LIST).map((row) => ({
      conditionType: boundedText(row?.condition_type, 64),
      repo: boundedRepo(row?.repo),
      reason: boundedReason(row?.reason),
      safeNextAction: boundedReason(row?.safe_next_action),
      openedAt: boundedTimestamp(row?.opened_at),
    })),
  };
}

/**
 * Attention counts plus a bounded per-event summary. `dashboard_reference`
 * is deliberately never forwarded — it is the one attention column that can
 * carry a path/URL.
 */
export function projectAttention(attentionEvents = [], attentionProjection = null) {
  const projection = attentionProjection || buildAttentionReconciliationProjection(attentionEvents, [], null);
  const byEvent = new Map(projection.items.map((item) => [item.eventKey, item]));
  const rows = (Array.isArray(attentionEvents) ? attentionEvents : []).filter((row) => !row?.resolved_at);
  const project = (row) => {
    const item = byEvent.get(attentionEventIdentity(row));
    return {
      repo: boundedRepo(row?.repo),
      issueNumber: boundedIssueNumber(row?.issue_number),
      issueUrl: issueUrl(row?.repo, row?.issue_number),
      reason: boundedReason(row?.reason),
      agent: boundedText(row?.agent, 64),
      recoveryStatus: boundedText(row?.recovery_status, 48),
      nextAction: boundedReason(row?.next_action),
      createdAt: boundedTimestamp(row?.created_at),
      reconciliationStatus: boundedText(item?.status, 16) || 'unknown',
      reconciliationReason: boundedText(item?.reasonCode, 64) || 'reconciliation-missing',
    };
  };
  return {
    posture: projection.posture,
    unresolvedCount: projection.counts.actionable,
    actionableCount: projection.counts.actionable,
    historicalCount: projection.counts.historical,
    unknownCount: projection.counts.unknown,
    staleCount: projection.counts.stale,
    events: rows.filter((row) => byEvent.get(attentionEventIdentity(row))?.status === 'actionable').slice(0, MAX_LIST).map(project),
    uncertainEvents: rows.filter((row) => ['unknown', 'stale'].includes(byEvent.get(attentionEventIdentity(row))?.status || 'unknown')).slice(0, MAX_LIST).map(project),
  };
}

export function projectNotifications(notifications = []) {
  const rows = Array.isArray(notifications) ? notifications : [];
  const countsByDeliveryStatus = {};
  for (const row of rows) {
    const key = boundedText(row?.delivery_status, 32) || 'unknown';
    countsByDeliveryStatus[key] = (countsByDeliveryStatus[key] || 0) + 1;
  }
  return { countsByDeliveryStatus };
}

/**
 * The Activity timeline: only typed, already-safe runner events that exist
 * in the canonical bounded projection — selections, claims, run results,
 * quota blocks, queue skips, attention and health transitions. Operator
 * configuration changes are NOT merged here; the client shows those from
 * `/api/audit`, so runner activity and operator changes stay visually
 * distinguishable (#175 "Activity and audit quality").
 */
export function projectActivity(latest = {}) {
  const events = [];
  const push = (kind, row, extra = {}) => {
    const at = boundedTimestamp(row?.finished_at || row?.started_at || row?.created_at);
    if (!at) return;
    events.push({
      kind,
      at,
      repo: boundedRepo(row?.repo),
      issueNumber: boundedIssueNumber(row?.issue_number),
      issueUrl: issueUrl(row?.repo, row?.issue_number),
      ...projectAgentEvidence(row),
      ...extra,
    });
  };

  for (const row of latest.selections || []) {
    push('selection', row, { detail: boundedText(row?.selection_mode || row?.status_label, 64) });
  }
  for (const row of latest.claims || []) {
    push('claim', row, { detail: boundedText(row?.action || row?.status_label, 64) });
  }
  for (const row of latest.runResults || []) {
    push('run-result', row, {
      detail: boundedText(row?.mode, 64),
      exitCode: Number.isInteger(row?.exit_code) ? row.exit_code : null,
      outcome: Number.isInteger(row?.exit_code) ? (row.exit_code === 0 ? 'succeeded' : 'failed') : 'unresolved',
    });
  }
  for (const row of latest.queueEvents || []) {
    push('queue-event', row, {
      detail: boundedText(row?.event_type, 48),
      reason: boundedReason(row?.reason || row?.payload?.reason),
    });
  }
  for (const row of latest.attentionEvents || []) {
    push('attention', row, {
      detail: boundedText(row?.recovery_status, 48),
      reason: boundedReason(row?.reason),
      resolved: Boolean(row?.resolved_at),
    });
  }

  return events
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, MAX_ACTIVITY);
}

function projectProject(identity) {
  // `projectIdentity()` also carries `localRepoPath`; three fields only.
  return {
    projectId: boundedText(identity?.projectId, 64),
    displayName: boundedText(identity?.displayName, 96),
    githubRepo: boundedRepo(identity?.githubRepo),
  };
}

function projectCircuit(circuit) {
  return {
    blocked: Boolean(circuit?.blocked),
    scope: boundedText(circuit?.scope, 48),
    reason: boundedReason(circuit?.reason),
    occurrenceCount: boundedCount(circuit?.occurrenceCount),
    trippedAt: boundedTimestamp(circuit?.trippedAt),
    configurationCurrent: circuit?.configurationCurrent === undefined ? null : Boolean(circuit.configurationCurrent),
    safeNextAction: boundedReason(circuit?.safeNextAction),
  };
}

function latestSchedulerPollAt(latest) {
  let newest = null;
  for (const row of latest?.runResults || []) {
    const at = boundedTimestamp(row?.finished_at || row?.started_at || row?.created_at);
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Pure: takes an already-read snapshot plus already-inspected unit/circuit
 * state and returns the exact wire shape. No I/O, no clock of its own —
 * every test below drives it with fixtures.
 */
export function buildOverviewProjection({
  snapshot,
  circuit,
  service,
  timer,
  identity,
  links = { grafanaRunnerUrl: null, grafanaOperationsUrl: null, legacyDashboardUrl: null },
  generatedAt,
  nowMs = Date.parse(generatedAt),
  attentionProjection = null,
}) {
  const base = {
    ok: true,
    schemaVersion: OVERVIEW_SCHEMA_VERSION,
    generatedAt: boundedTimestamp(generatedAt),
    project: projectProject(identity),
    links,
    circuit: projectCircuit(circuit),
  };

  if (!snapshot?.ok) {
    const runner = deriveRunnerStatus({ snapshot, circuit });
    return {
      ...base,
      stateAvailable: false,
      runner,
      scheduler: deriveSchedulerStatus({ service, timer, lastPollAt: null, nowMs }),
      currentTask: { state: 'unknown', active: false, message: runner.explanation, repo: null, issueNumber: null, issueUrl: null, kind: null, phase: null, statusLabel: null, exitCode: null, startedAt: null, elapsedSeconds: null, agent: null, assignmentLabel: null, assignmentDisplayName: null },
      queue: projectQueue(null),
      runs: projectRuns(null),
      quota: projectQuota(null),
      health: projectHealth([]),
      attention: projectAttention([]),
      notifications: projectNotifications([]),
      activity: [],
    };
  }

  const latest = snapshot.latest || {};
  const activity = buildRunnerActivity(latest);
  const metrics = buildRunnerMetrics({ latest });
  const operatorStatus = buildRunnerOperatorStatus(latest, activity, snapshot.currentHealthConditions || [], attentionProjection);

  return {
    ...base,
    stateAvailable: true,
    runner: deriveRunnerStatus({ snapshot, operatorStatus, activity, circuit }),
    operatorStatusCode: boundedText(operatorStatus?.code, 48),
    scheduler: deriveSchedulerStatus({ service, timer, lastPollAt: latestSchedulerPollAt(latest), nowMs }),
    currentTask: projectCurrentTask(activity, { nowMs }),
    queue: projectQueue(metrics),
    runs: projectRuns(metrics),
    quota: projectQuota(metrics),
    health: projectHealth(snapshot.currentHealthConditions),
    attention: projectAttention(snapshot.attentionSource?.attentionEvents || latest.attentionEvents || [], attentionProjection),
    notifications: projectNotifications(latest.notifications),
    activity: projectActivity(latest),
  };
}

function resolveStateDbPath({ env, config, dbPath }) {
  if (dbPath) return dbPath;
  return env.CLAUDE_RUNNER_STATE_DB
    || config?.stateDbPath
    || defaultRunnerStateDbPath(env.CLAUDE_RUNNER_OUTPUT_DIR || config?.outputDir || '.var/claude-runner');
}

/**
 * Read side. Every failure mode — unreadable config, unreadable state,
 * systemd absent — degrades to an explicit `unavailable`/`unknown` status
 * with a bounded reason. It never throws a raw error out to the HTTP layer,
 * and it never reports missing data as healthy.
 */
export function readControlOverview({
  env = process.env,
  dbPath,
  now = () => new Date().toISOString(),
  spawn = spawnSync,
} = {}) {
  let config = null;
  try {
    config = loadAgentRunnerConfig({ env });
  } catch {
    config = null;
  }
  const generatedAt = now();
  if (!config) {
    return buildOverviewProjection({
      snapshot: { ok: false, reason: 'runner-config-unreadable', safeNextAction: 'Repair the Agent Runner configuration file before the dashboard can report runner state.' },
      circuit: { blocked: false },
      service: { status: 'unavailable' },
      timer: { status: 'unavailable' },
      identity: null,
      links: projectLinks(env),
      generatedAt,
    });
  }

  let snapshot;
  try {
    snapshot = readOnlyRunnerStateSnapshot(resolveStateDbPath({ env, config, dbPath }), { historyLimit: 20, includeLatest: true, attentionRepository: config.githubRepo });
  } catch {
    snapshot = { ok: false, reason: 'state-db-unreadable', safeNextAction: 'Repair or restore the runner state database; this read never creates or modifies it.' };
  }

  let circuit;
  try {
    circuit = readCircuitState(env);
  } catch {
    circuit = { blocked: false, reason: 'circuit-state-unavailable' };
  }

  const inspect = (unit) => {
    if (!unit) return { status: 'unavailable' };
    try {
      return unitState(unit, spawn);
    } catch {
      return { status: 'unavailable' };
    }
  };

  const reconciliationDbPath = resolveAttentionReconciliationDbPath({ env, config });
  const attentionState = config.githubRepo ? readAttentionReconciliationState(reconciliationDbPath, config.githubRepo) : null;
  const attentionProjection = buildAttentionReconciliationProjection(
    snapshot?.attentionSource?.attentionEvents || [], snapshot?.attentionSource?.recoveryAttempts || [], attentionState,
    { repository: config.githubRepo, now: generatedAt, sourceTotal: snapshot?.attentionSource?.total, sourceOverflow: snapshot?.attentionSource?.overflow },
  );

  return buildOverviewProjection({
    snapshot,
    circuit,
    service: inspect(env.AGENT_RUNNER_CONTROL_SCHEDULER_SERVICE || config.systemd?.serviceName),
    timer: inspect(env.AGENT_RUNNER_CONTROL_SCHEDULER_TIMER || config.systemd?.timerName),
    identity: projectIdentity(config),
    links: projectLinks(env),
    generatedAt,
    attentionProjection,
  });
}

/**
 * Short-TTL memoisation so a dashboard tab polling every few seconds cannot
 * turn into a systemd spawn plus a SQLite snapshot copy per poll. The cache
 * is process-local and holds only the already-narrowed wire object.
 */
export function createOverviewReader({ ttlMs = 4000, read = readControlOverview } = {}) {
  let cachedAt = 0;
  let cached = null;
  return {
    get(options = {}, monotonicNowMs = Date.now()) {
      if (cached && monotonicNowMs - cachedAt < ttlMs) return cached;
      cached = read(options);
      cachedAt = monotonicNowMs;
      return cached;
    },
    invalidate() {
      cached = null;
      cachedAt = 0;
    },
  };
}
