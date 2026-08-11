import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OVERVIEW_SCHEMA_VERSION,
  STALE_POLL_SECONDS,
  STATUS_VOCABULARY,
  boundedReason,
  buildOverviewProjection,
  createOverviewReader,
  deriveRunnerStatus,
  deriveSchedulerStatus,
  issueUrl,
  projectActivity,
  projectAttention,
  projectCurrentTask,
  projectHealth,
  projectLinks,
  projectQueue,
  projectQuota,
  readControlOverview,
} from './agent-runner-control-overview.mjs';
import { buildOperatorStatus } from './agent-runner-operator-status.mjs';
import { buildRunnerActivity, buildRunnerMetrics, buildRunnerOperatorStatus } from './claude-runner-dashboard-api.mjs';
import { loadAgentRunnerConfig } from './agent-runner-config.mjs';
import { openRunnerStateStore } from './claude-runner-state.mjs';

const NOW = '2026-08-11T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function baseLatest(overrides = {}) {
  return {
    runResults: [],
    attentionEvents: [],
    notifications: [],
    claims: [],
    selections: [],
    queueEvents: [],
    quota: [],
    ...overrides,
  };
}

function okSnapshot(latest = baseLatest(), currentHealthConditions = []) {
  return { ok: true, status: 'ok', reason: null, safeNextAction: null, schemaVersion: 16, counts: {}, currentHealthConditions, latest };
}

function project(snapshot, extra = {}) {
  return buildOverviewProjection({
    snapshot,
    circuit: { blocked: false },
    service: { status: 'installed', activeState: 'active' },
    timer: { status: 'installed', activeState: 'active' },
    identity: { projectId: 'agent-runner', displayName: 'Agent Runner', githubRepo: 'TheTekTeam/agent-runner', localRepoPath: '/home/operator/projects/agent-runner' },
    generatedAt: NOW,
    ...extra,
  });
}

// -- bounding / allowlisting ------------------------------------------

test('boundedReason strips filesystem paths and clamps length, so no reason string can leak a path', () => {
  assert.equal(
    boundedReason('state read failed at /home/operator/.local/state/agent-runner/x/state.sqlite while polling'),
    'state read failed at [path-redacted] while polling',
  );
  assert.equal(boundedReason('rooted at ~/.local/state/agent-runner/db'), 'rooted at [path-redacted]');
  assert.equal(boundedReason('x'.repeat(500)).length, 160);
  assert.equal(boundedReason(null), null);
  assert.equal(boundedReason(''), null);
  assert.equal(boundedReason(42), null);
});

test('issueUrl is built only from a validated owner/repo slug and a positive integer', () => {
  assert.equal(issueUrl('TheTekTeam/agent-runner', 175), 'https://github.com/TheTekTeam/agent-runner/issues/175');
  assert.equal(issueUrl('../../etc/passwd', 1), null);
  assert.equal(issueUrl('TheTekTeam/agent runner', 1), null);
  assert.equal(issueUrl('TheTekTeam/agent-runner', 0), null);
  assert.equal(issueUrl('TheTekTeam/agent-runner', '175'), null);
  assert.equal(issueUrl('javascript:alert(1)', 1), null);
});

test('projectLinks accepts only absolute http(s) URLs and rejects credentialed or non-http schemes', () => {
  const links = projectLinks({
    AGENT_RUNNER_GRAFANA_RUNNER_URL: 'http://127.0.0.1:3000/d/runner',
    AGENT_RUNNER_GRAFANA_OPERATIONS_URL: 'https://user:secret@grafana.internal/d/ops',
    AGENT_RUNNER_LEGACY_DASHBOARD_URL: 'javascript:alert(1)',
  });
  assert.equal(links.grafanaRunnerUrl, 'http://127.0.0.1:3000/d/runner');
  assert.equal(links.grafanaOperationsUrl, null, 'a URL carrying a credential must never be forwarded');
  assert.equal(links.legacyDashboardUrl, null);
  assert.deepEqual(projectLinks({}), { grafanaRunnerUrl: null, grafanaOperationsUrl: null, legacyDashboardUrl: null });
});

test('the projection never forwards a filesystem path, even when the identity carries one', () => {
  const serialized = JSON.stringify(project(okSnapshot()));
  assert.ok(!serialized.includes('localRepoPath'));
  assert.ok(!serialized.includes('/home/operator'));
  assert.ok(!serialized.includes('dbPath'));
});

test('raw state rows never reach the wire — only the derived, allowlisted blocks do', () => {
  const snapshot = okSnapshot(baseLatest({
    claims: [{ id: 1, created_at: NOW, repo: 'TheTekTeam/agent-runner', issue_number: 175, action: 'claimed', status_label: 'in-progress', selection_mode: 'issue-run' }],
  }));
  const projection = project(snapshot);
  assert.equal(projection.latest, undefined);
  assert.equal(projection.counts, undefined);
  assert.equal(projection.payload, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(projection, 'dbPath'));
  const keys = Object.keys(projection).sort();
  assert.deepEqual(keys, [
    'activity', 'attention', 'circuit', 'currentTask', 'generatedAt', 'health', 'links', 'notifications',
    'ok', 'operatorStatusCode', 'project', 'queue', 'quota', 'runner', 'runs', 'scheduler', 'schemaVersion', 'stateAvailable',
  ]);
  assert.equal(projection.schemaVersion, OVERVIEW_SCHEMA_VERSION);
});

test('attention events never forward dashboard_reference, the one column that can carry a path or URL', () => {
  const projection = projectAttention([
    { repo: 'TheTekTeam/agent-runner', issue_number: 7, reason: 'stalled', dashboard_reference: '/var/www/runner/index.html', created_at: NOW, resolved_at: null },
  ]);
  assert.equal(projection.unresolvedCount, 1);
  assert.equal(projection.events[0].reason, 'stalled');
  assert.ok(!JSON.stringify(projection).includes('/var/www'));
  assert.ok(!JSON.stringify(projection).includes('dashboardReference'));
});

// -- status vocabulary -------------------------------------------------

test('every status the derivations can produce is inside the shared vocabulary', () => {
  const produced = [
    deriveRunnerStatus({ snapshot: { ok: false, reason: 'state-db-missing' } }),
    deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'global_systemic_pause' } }),
    deriveRunnerStatus({ snapshot: okSnapshot(), circuit: { blocked: true } }),
    deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'attention_required', count: 2 } }),
    deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'queue_inspection_degraded' } }),
    deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'task_local_quarantines', count: 1 } }),
    deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'queue_moving' }, activity: { activeIssue: { issue_number: 1 } } }),
    deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'queue_moving' }, activity: {} }),
    deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'idle' }, activity: {} }),
    deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'something-new' }, activity: {} }),
    deriveSchedulerStatus({ service: { status: 'unavailable' }, timer: { status: 'unavailable' }, nowMs: NOW_MS }),
    deriveSchedulerStatus({ service: { status: 'not-found' }, timer: { status: 'not-found' }, nowMs: NOW_MS }),
    deriveSchedulerStatus({ service: { status: 'installed' }, timer: { status: 'installed', activeState: 'inactive' }, nowMs: NOW_MS }),
    deriveSchedulerStatus({ service: { status: 'installed', activeState: 'active' }, timer: { status: 'installed', activeState: 'active' }, lastPollAt: NOW, nowMs: NOW_MS }),
  ];
  for (const entry of produced) {
    assert.ok(STATUS_VOCABULARY.includes(entry.code), `unexpected status code ${entry.code}`);
    assert.ok(entry.label.length > 0);
    assert.ok(entry.explanation.length > 0, `${entry.code} must carry a human explanation`);
  }
});

test('each vocabulary state maps to the expected derivation', () => {
  assert.equal(deriveRunnerStatus({ snapshot: { ok: false, reason: 'state-db-missing' } }).code, 'unavailable');
  assert.equal(deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'global_systemic_pause' } }).code, 'blocked');
  assert.equal(deriveRunnerStatus({ snapshot: okSnapshot(), circuit: { blocked: true } }).code, 'blocked');
  assert.equal(deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'attention_required', count: 3 } }).code, 'attention');
  assert.equal(deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'queue_inspection_degraded' } }).code, 'degraded');
  assert.equal(deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'task_local_quarantines', count: 1 } }).code, 'degraded');
  assert.equal(deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'queue_moving' }, activity: { activeIssue: {} } }).code, 'running');
  assert.equal(deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'queue_moving' } }).code, 'healthy');
  assert.equal(deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'idle' } }).code, 'idle');
  assert.equal(deriveRunnerStatus({ snapshot: okSnapshot(), operatorStatus: { code: 'not-a-known-code' } }).code, 'unknown');
});

test('a tripped admission circuit outranks a merely-moving queue and carries its safe next action', () => {
  const derived = deriveRunnerStatus({
    snapshot: okSnapshot(),
    operatorStatus: { code: 'queue_moving' },
    activity: {},
    circuit: { blocked: true, reason: 'machine_profile_changed', safeNextAction: 'Change and verify the effective machine configuration before retrying candidate selection.' },
  });
  assert.equal(derived.code, 'blocked');
  assert.match(derived.explanation, /machine_profile_changed/);
  assert.match(derived.nextAction, /machine configuration/);
});

test('missing data is never reported as healthy', () => {
  const projection = project({ ok: false, status: 'missing', reason: 'state-db-missing', safeNextAction: 'Provision the runner state database.' });
  assert.equal(projection.stateAvailable, false);
  assert.equal(projection.runner.code, 'unavailable');
  assert.notEqual(projection.runner.code, 'healthy');
  assert.equal(projection.currentTask.state, 'unknown');
  assert.equal(projection.currentTask.active, false);
  assert.equal(projection.quota.admission.code, 'unknown');
  assert.deepEqual(projection.activity, []);
});

test('an installed, active timer with no recent poll reports stale rather than healthy', () => {
  const lastPollAt = new Date(NOW_MS - (STALE_POLL_SECONDS + 60) * 1000).toISOString();
  const stale = deriveSchedulerStatus({
    service: { status: 'installed', activeState: 'active' },
    timer: { status: 'installed', activeState: 'active' },
    lastPollAt,
    nowMs: NOW_MS,
  });
  assert.equal(stale.code, 'stale');
  assert.ok(stale.nextAction);

  const fresh = deriveSchedulerStatus({
    service: { status: 'installed', activeState: 'active' },
    timer: { status: 'installed', activeState: 'active' },
    lastPollAt: new Date(NOW_MS - 60 * 1000).toISOString(),
    nowMs: NOW_MS,
  });
  assert.equal(fresh.code, 'healthy');
});

test('systemd being uninspectable reports unknown, never healthy or disabled-by-assumption', () => {
  const derived = deriveSchedulerStatus({ service: { status: 'unavailable' }, timer: { status: 'unavailable' }, nowMs: NOW_MS });
  assert.equal(derived.code, 'unknown');
});

// -- current task ------------------------------------------------------

test('an active claim renders as a running current task with elapsed time and an exact GitHub link', () => {
  const startedAt = new Date(NOW_MS - 754 * 1000).toISOString();
  const snapshot = okSnapshot(baseLatest({
    claims: [{ id: 3, created_at: startedAt, repo: 'TheTekTeam/agent-runner', issue_number: 175, action: 'claimed', status_label: 'in-progress', selection_mode: 'issue-run' }],
    selections: [{ id: 2, created_at: startedAt, repo: 'TheTekTeam/agent-runner', issue_number: 175, status_label: 'ready', selection_mode: 'issue-run', payload: { agent: { agentId: 'claude-code-cli', assignmentLabel: 'agent:codex-claude' } } }],
  }));
  const projection = project(snapshot);
  assert.equal(projection.runner.code, 'running');
  assert.equal(projection.currentTask.active, true);
  assert.equal(projection.currentTask.state, 'running');
  assert.equal(projection.currentTask.repo, 'TheTekTeam/agent-runner');
  assert.equal(projection.currentTask.issueNumber, 175);
  assert.equal(projection.currentTask.issueUrl, 'https://github.com/TheTekTeam/agent-runner/issues/175');
  assert.equal(projection.currentTask.agent, 'claude-code-cli');
  assert.equal(projection.currentTask.assignmentLabel, 'agent:codex-claude');
  assert.equal(projection.currentTask.elapsedSeconds, 754);
  assert.equal(projection.currentTask.startedAt, startedAt);
});

test('an idle runner still explains itself rather than rendering blank', () => {
  const finishedAt = new Date(NOW_MS - 3600 * 1000).toISOString();
  const snapshot = okSnapshot(baseLatest({
    runResults: [{ id: 9, created_at: finishedAt, finished_at: finishedAt, repo: 'TheTekTeam/agent-runner', issue_number: 174, mode: 'issue-run', exit_code: 0 }],
  }));
  const projection = project(snapshot);
  assert.equal(projection.currentTask.active, false);
  assert.equal(projection.currentTask.state, 'idle');
  assert.ok(projection.currentTask.message.length > 0);
  assert.equal(projection.currentTask.elapsedSeconds, null);
  assert.equal(projection.currentTask.issueNumber, 174, 'the latest recorded issue is still shown as context');
});

test('an empty history is reported as empty, not as idle-with-a-phantom-issue', () => {
  const projection = projectCurrentTask(buildRunnerActivity(baseLatest()), { nowMs: NOW_MS });
  assert.equal(projection.state, 'empty');
  assert.equal(projection.active, false);
  assert.equal(projection.issueNumber, null);
  assert.equal(projection.issueUrl, null);
});

// -- queue / quota / health -------------------------------------------

test('queue projection reports bounded skip reason codes with counts', () => {
  const metrics = buildRunnerMetrics({
    latest: baseLatest({
      queueEvents: [
        { id: 1, created_at: NOW, repo: 'TheTekTeam/agent-runner', event_type: 'skip', issue_number: 11, reason: 'manager-preflight-required', payload: {} },
        { id: 2, created_at: NOW, repo: 'TheTekTeam/agent-runner', event_type: 'skip', issue_number: 12, reason: 'manager-preflight-required', payload: {} },
        { id: 3, created_at: NOW, repo: 'TheTekTeam/agent-runner', event_type: 'skip', issue_number: 13, reason: 'quota-blocked', payload: {} },
      ],
    }),
  });
  const queue = projectQueue(metrics);
  assert.equal(queue.skipEventCount, 3);
  assert.equal(queue.skippedIssueCount, 3);
  assert.equal(queue.skipReasons[0].reason, 'manager-preflight-required');
  assert.equal(queue.skipReasons[0].count, 2);
});

test('quota projection reports headroom and admission state, never a billing balance', () => {
  const quota = projectQuota({ quota: { latestSessionUsagePercent: 42.35, latestWeeklyUsagePercent: 61, blockedCount: 0 } });
  assert.equal(quota.tracked, true);
  assert.equal(quota.sessionUsagePercent, 42.4);
  assert.equal(quota.sessionHeadroomPercent, 57.6);
  assert.equal(quota.weeklyHeadroomPercent, 39);
  assert.equal(quota.admission.code, 'healthy');
  assert.equal(quota.paidRoutingEnabled, false, 'paid/credit-backed routing must stay visibly OFF');
  const serialized = JSON.stringify(quota);
  assert.ok(!/balance|credit|\$/i.test(serialized), 'nothing may imply a billing balance');

  const blocked = projectQuota({ quota: { latestSessionUsagePercent: 99, latestWeeklyUsagePercent: 99, blockedCount: 4 } });
  assert.equal(blocked.admission.code, 'degraded');

  const untracked = projectQuota(null);
  assert.equal(untracked.tracked, false);
  assert.equal(untracked.admission.code, 'unknown');
});

test('open health conditions are forwarded with their safe next action', () => {
  const health = projectHealth([
    { id: 1, repo: 'TheTekTeam/agent-runner', condition_type: 'systemic_pause', reason: 'attention-backlog', opened_at: NOW, safe_next_action: 'Resolve the attention backlog.', resolved_at: null },
  ]);
  assert.equal(health.unresolvedCount, 1);
  assert.equal(health.conditions[0].conditionType, 'systemic_pause');
  assert.equal(health.conditions[0].safeNextAction, 'Resolve the attention backlog.');
});

// -- activity ----------------------------------------------------------

test('activity is a bounded, typed, most-recent-first timeline of already-safe events only', () => {
  const activity = projectActivity(baseLatest({
    runResults: [{ id: 1, created_at: '2026-08-11T10:00:00.000Z', finished_at: '2026-08-11T10:00:00.000Z', repo: 'TheTekTeam/agent-runner', issue_number: 1, mode: 'issue-run', exit_code: 1 }],
    claims: [{ id: 2, created_at: '2026-08-11T11:00:00.000Z', repo: 'TheTekTeam/agent-runner', issue_number: 2, action: 'claimed' }],
    queueEvents: [{ id: 3, created_at: '2026-08-11T09:00:00.000Z', repo: 'TheTekTeam/agent-runner', event_type: 'skip', issue_number: 3, reason: 'not-ready', payload: {} }],
  }));
  assert.equal(activity[0].kind, 'claim');
  assert.equal(activity[1].kind, 'run-result');
  assert.equal(activity[1].outcome, 'failed');
  assert.equal(activity[2].kind, 'queue-event');
  for (const event of activity) assert.ok(Date.parse(event.at) > 0);
});

test('activity is capped so a long retained window cannot produce an unbounded payload', () => {
  const rows = Array.from({ length: 200 }, (unused, index) => ({
    id: index,
    created_at: new Date(NOW_MS - index * 1000).toISOString(),
    repo: 'TheTekTeam/agent-runner',
    issue_number: index + 1,
    action: 'claimed',
  }));
  assert.equal(projectActivity(baseLatest({ claims: rows })).length, 40);
});

// -- canonical parity --------------------------------------------------

test('the projection reuses the canonical derivations rather than a second opinion', () => {
  const latest = baseLatest({
    claims: [{ id: 3, created_at: NOW, repo: 'TheTekTeam/agent-runner', issue_number: 175, action: 'claimed' }],
    queueEvents: [{ id: 1, created_at: NOW, repo: 'TheTekTeam/agent-runner', event_type: 'skip', issue_number: 11, reason: 'not-ready', payload: {} }],
    quota: [{ id: 1, created_at: NOW, blocked: 0, session_usage_percent: 10, weekly_usage_percent: 20 }],
  });
  const snapshot = okSnapshot(latest);
  const projection = project(snapshot);

  const canonicalActivity = buildRunnerActivity(latest);
  const canonicalMetrics = buildRunnerMetrics({ latest });
  const canonicalStatus = buildRunnerOperatorStatus(latest, canonicalActivity, []);

  assert.equal(projection.operatorStatusCode, canonicalStatus.code);
  assert.equal(projection.currentTask.issueNumber, canonicalActivity.activeIssue.issue_number);
  assert.equal(projection.queue.skipEventCount, canonicalMetrics.queue.skipEventCount);
  assert.equal(projection.quota.sessionUsagePercent, canonicalMetrics.quota.latestSessionUsagePercent);
});

// -- caching -----------------------------------------------------------

test('the overview reader memoises within its TTL and re-reads after it', () => {
  let calls = 0;
  const reader = createOverviewReader({ ttlMs: 5000, read: () => { calls += 1; return { ok: true, calls }; } });
  reader.get({}, 1000);
  reader.get({}, 2000);
  assert.equal(calls, 1, 'a second read inside the TTL must not re-open SQLite or spawn systemctl');
  reader.get({}, 7000);
  assert.equal(calls, 2);
  reader.invalidate();
  reader.get({}, 7100);
  assert.equal(calls, 3);
});

// -- against a real state database ------------------------------------

function withStateDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-runner-overview-'));
  const dbPath = join(dir, 'runner-state.sqlite');
  const store = openRunnerStateStore(dbPath);
  try {
    store.recordQueueEvent({ repo: 'TheTekTeam/agent-runner', eventType: 'skip', issueNumber: 11, reason: 'manager-preflight-required' });
    store.recordIssueSelection({ repo: 'TheTekTeam/agent-runner', issueNumber: 175, statusLabel: 'ready', selectionMode: 'issue-run' });
    store.recordClaim({ repo: 'TheTekTeam/agent-runner', issueNumber: 175, claim: { action: 'claimed', statusLabel: 'in-progress' } });
    store.close?.();
    return fn({ dir, dbPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a real state database produces the same operator status and current task as the operator CLI', () => {
  withStateDb(({ dir, dbPath }) => {
    const env = { ...process.env, HOME: dir, CLAUDE_RUNNER_STATE_DB: dbPath };
    const spawn = () => ({ error: new Error('systemctl unavailable in test'), status: 1, stdout: '' });
    const config = loadAgentRunnerConfig({ env });

    const cliReport = buildOperatorStatus(config, env, { now: () => NOW, spawn });
    const projection = readControlOverview({ env, dbPath, now: () => NOW, spawn });

    assert.equal(projection.operatorStatusCode, cliReport.operatorStatus.code);
    assert.equal(projection.currentTask.issueNumber, cliReport.currentTask.activeIssue?.issue_number ?? null);
    assert.equal(projection.currentTask.repo, cliReport.currentTask.activeIssue?.repo ?? null);
    assert.equal(projection.queue.skipEventCount, cliReport.queue.skipEventCount);
    assert.equal(projection.queue.skippedIssueCount, cliReport.queue.skippedIssueCount);
  });
});

test('reading the overview never mutates the runner state directory', () => {
  withStateDb(({ dir, dbPath }) => {
    const env = { ...process.env, HOME: dir, CLAUDE_RUNNER_STATE_DB: dbPath };
    const spawn = () => ({ error: new Error('systemctl unavailable in test'), status: 1, stdout: '' });
    const before = snapshotDirectory(dir);
    const projection = readControlOverview({ env, dbPath, now: () => NOW, spawn });
    assert.equal(projection.ok, true);
    const after = snapshotDirectory(dir);
    assert.deepEqual(after, before, 'the read must not create, remove or modify any durable file (including -wal/-shm sidecars)');
  });
});

/** Durable-state evidence: every file under the state directory, with its size and mtime. */
function snapshotDirectory(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = join(entry.parentPath || entry.path || dir, entry.name);
      const stats = statSync(full);
      return `${full}:${stats.size}:${stats.mtimeMs}`;
    })
    .sort();
}
