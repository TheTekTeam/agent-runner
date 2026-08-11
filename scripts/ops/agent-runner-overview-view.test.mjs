import assert from 'node:assert/strict';
import test from 'node:test';

import { STATUS_VOCABULARY as SERVER_VOCABULARY } from './agent-runner-control-overview.mjs';
import {
  NAV_SECTIONS,
  STATUS_VOCABULARY,
  activityEventLabel,
  activityEventTone,
  buildStatusAnnouncement,
  buildTimeline,
  classifyRunPosture,
  describeCurrentTask,
  describeLink,
  describeQuota,
  describeStatus,
  filterTimeline,
  formatClock,
  formatElapsed,
  formatRelative,
  formatUtc,
  nextRefreshDelayMs,
  normalizeStatusCode,
  statusGlyph,
  statusSignature,
  statusTone,
  summariseFleet,
  summariseQueue,
} from '../../.agent-runner/agents-dashboard/agents-overview-view.mjs';
import { mapAgentStateToStatusCode, summariseAgentRow } from '../../.agent-runner/agents-dashboard/agents-dashboard-view.mjs';

const NOW_MS = Date.parse('2026-08-11T12:00:00.000Z');

// -- one shared vocabulary --------------------------------------------

test('the browser and the control API share one status vocabulary, byte for byte', () => {
  assert.deepEqual([...STATUS_VOCABULARY], [...SERVER_VOCABULARY]);
});

test('every status has a tone and a non-colour glyph, so state is never colour-only', () => {
  for (const code of STATUS_VOCABULARY) {
    const tone = statusTone(code);
    const glyph = statusGlyph(code);
    assert.ok(['ok', 'active', 'warn', 'critical', 'neutral'].includes(tone), `${code} -> ${tone}`);
    assert.ok(typeof glyph === 'string' && glyph.length > 0, `${code} must have a redundant glyph`);
  }
});

test('an unrecognised or missing status degrades to unknown with an explanation, never to healthy', () => {
  assert.equal(normalizeStatusCode('not-a-state'), 'unknown');
  assert.equal(normalizeStatusCode(undefined), 'unknown');
  const described = describeStatus(null);
  assert.equal(described.code, 'unknown');
  assert.notEqual(described.code, 'healthy');
  assert.ok(described.explanation.length > 0);
  assert.ok(described.glyph.length > 0);
});

test('a status carrying a next action surfaces it for the operator', () => {
  const described = describeStatus({ code: 'blocked', label: 'Admission circuit tripped', explanation: 'Blocked.', nextAction: 'Verify the machine profile.' });
  assert.equal(described.tone, 'critical');
  assert.equal(described.nextAction, 'Verify the machine profile.');
});

test('the primary navigation is exactly the four required sections', () => {
  assert.deepEqual(NAV_SECTIONS.map((section) => section.id), ['overview', 'agents', 'activity', 'settings']);
  for (const section of NAV_SECTIONS) assert.ok(section.label && section.icon);
});

// -- time --------------------------------------------------------------

test('elapsed time is rendered compactly across seconds, minutes and hours', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(42), '42s');
  assert.equal(formatElapsed(125), '2m 05s');
  assert.equal(formatElapsed(3900), '1h 05m');
  assert.equal(formatElapsed(null), '—');
  assert.equal(formatElapsed(-5), '—');
});

test('timestamps render in operator-local time with a precise UTC value available separately', () => {
  const iso = '2026-08-11T09:30:00.000Z';
  assert.notEqual(formatClock(iso), '—');
  assert.equal(formatUtc(iso), '2026-08-11T09:30:00.000Z (UTC)');
  assert.equal(formatClock(null), '—');
  assert.equal(formatUtc(null), '');
  assert.equal(formatClock('not-a-date'), '—');
});

test('relative time is bounded and never claims freshness it cannot prove', () => {
  assert.equal(formatRelative(new Date(NOW_MS - 10_000).toISOString(), NOW_MS), 'just now');
  assert.equal(formatRelative(new Date(NOW_MS - 300_000).toISOString(), NOW_MS), '5m 00s ago');
  assert.equal(formatRelative(null, NOW_MS), '—');
});

// -- current task ------------------------------------------------------

test('an active task renders a repo/issue headline and elapsed time', () => {
  const described = describeCurrentTask({
    state: 'running',
    active: true,
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 175,
    elapsedSeconds: 754,
    message: 'A claim has no later terminal run result in the retained history.',
  }, { nowMs: NOW_MS });
  assert.equal(described.active, true);
  assert.equal(described.headline, 'TheTekTeam/agent-runner #175');
  assert.equal(described.elapsedText, '12m 34s');
  assert.equal(described.tone, 'active');
});

test('an idle runner says so explicitly instead of going blank', () => {
  const described = describeCurrentTask({ state: 'idle', active: false, issueNumber: 174, message: null }, { nowMs: NOW_MS });
  assert.equal(described.active, false);
  assert.equal(described.headline, 'Idle — no runnable task currently selected');
  assert.ok(described.detail.length > 0);
  assert.equal(described.previousIssueNumber, 174);
});

test('an unknown current-task state is reported as unknown, not idle', () => {
  const described = describeCurrentTask({ state: 'unknown', active: false, message: 'State unreadable.' });
  assert.equal(described.headline, 'Current task unknown');
  assert.equal(described.detail, 'State unreadable.');
});

test('an entirely absent current task still renders an explanation', () => {
  const described = describeCurrentTask(null);
  assert.equal(described.active, false);
  assert.ok(described.detail.length > 0);
});

test('actively running is distinguished from awaiting human attention', () => {
  const task = { active: true, issueNumber: 175 };
  assert.equal(classifyRunPosture(task, { events: [] }).code, 'running');
  assert.equal(classifyRunPosture(task, { events: [{ issueNumber: 175 }] }).code, 'awaiting-attention');
  assert.equal(classifyRunPosture({ active: false }, { events: [] }).code, 'idle');
});

// -- queue / quota / fleet --------------------------------------------

test('the queue summary reports skips and reasons without inventing a runnable count', () => {
  const summary = summariseQueue({
    skippedIssueCount: 4,
    skipEventCount: 6,
    skipReasons: [
      { reason: 'manager-preflight-required', count: 3 },
      { reason: 'quota-blocked', count: 2 },
      { reason: 'a', count: 1 }, { reason: 'b', count: 1 }, { reason: 'c', count: 1 }, { reason: 'd', count: 1 },
    ],
  });
  assert.equal(summary.skippedIssueCount, 4);
  assert.equal(summary.distinctReasonCount, 6);
  assert.equal(summary.topReasons.length, 5);
  assert.equal(summary.runnableClaim, 'Runnable eligibility is proven per scheduler pass, not counted here.');
  assert.equal(summary.runnableCount, undefined, 'no fabricated runnable total');
});

test('quota is described as included-quota headroom with paid routing visibly off', () => {
  const tracked = describeQuota({ tracked: true, sessionUsagePercent: 40, weeklyUsagePercent: 60, sessionHeadroomPercent: 60, weeklyHeadroomPercent: 40, paidRoutingEnabled: false });
  assert.equal(tracked.tracked, true);
  assert.match(tracked.summary, /headroom/);
  assert.match(tracked.costNote, /OFF/);
  assert.match(tracked.costNote, /No billing balance is implied/);

  const untracked = describeQuota(null);
  assert.equal(untracked.tracked, false);
  assert.equal(untracked.sessionText, '—');
  assert.match(untracked.costNote, /OFF/);
});

test('the fleet roll-up counts every lifecycle state and only calls a probed adapter ready', () => {
  const summary = summariseFleet([
    { state: 'enabled', readiness: { ok: true } },
    { state: 'enabled', readiness: { ok: false } },
    { state: 'paused' },
    { state: 'draining' },
    { state: 'disabled' },
    { state: 'unsupported' },
    { state: 'unavailable' },
  ]);
  assert.equal(summary.total, 7);
  assert.equal(summary.ready, 1);
  assert.equal(summary.counts.enabled, 2);
  assert.equal(summary.constrained, 3);
});

test('an enabled adapter with a failing readiness probe is never shown as healthy', () => {
  assert.equal(mapAgentStateToStatusCode({ state: 'enabled', readiness: { ok: true } }), 'healthy');
  assert.equal(mapAgentStateToStatusCode({ state: 'enabled', readiness: { ok: false } }), 'unavailable');
  assert.equal(mapAgentStateToStatusCode({ state: 'unsupported' }), 'unsupported');
  assert.equal(mapAgentStateToStatusCode({ state: 'draining' }), 'draining');
  assert.equal(mapAgentStateToStatusCode({}), 'unknown');
  for (const state of ['enabled', 'paused', 'draining', 'disabled', 'unavailable', 'unsupported']) {
    assert.ok(STATUS_VOCABULARY.includes(mapAgentStateToStatusCode({ state, readiness: { ok: true } })));
  }
});

test('the compact agent row carries every required summary field and no credential value', () => {
  const summary = summariseAgentRow({
    agentId: 'claude-code-cli',
    adapterType: 'claude',
    state: 'enabled',
    created: true,
    implemented: true,
    model: 'sonnet',
    profile: 'default',
    readiness: { ok: true },
    quota: { costClass: 'paid-metered', paid: true, quota: { latestSessionUsagePercent: 12, latestWeeklyUsagePercent: 30 } },
    load: { capacity: 1, active: 1 },
  }, { auditEntries: [{ at: '2026-08-11T08:00:00.000Z', changedFields: ['agents.claude-code-cli.state'] }], currentRevision: 7 });

  assert.equal(summary.statusCode, 'healthy');
  assert.equal(summary.costClass, 'Paid (metered)');
  assert.equal(summary.paid, true);
  assert.equal(summary.slotBusy, true);
  assert.equal(summary.revision, 7);
  assert.equal(summary.lastStateChangeAt, '2026-08-11T08:00:00.000Z');
  assert.match(summary.quotaText, /Session 12\.0%/);
  assert.ok(!/value|secret|token|password/i.test(JSON.stringify(summary)));
});

// -- timeline ----------------------------------------------------------

test('runner activity and operator changes merge chronologically but keep distinct sources', () => {
  const rows = buildTimeline({
    activity: [{ kind: 'run-result', at: '2026-08-11T10:00:00.000Z', outcome: 'succeeded', repo: 'a/b', issueNumber: 1, detail: 'issue-run' }],
    audit: [{ at: '2026-08-11T11:00:00.000Z', actor: 'operator', action: 'settings.update', changedFields: ['agents.claude-code-cli.model'], revision: 4 }],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'operator');
  assert.equal(rows[0].label, 'Operator: settings.update');
  assert.equal(rows[1].source, 'runner');
  assert.equal(rows[1].label, 'Run result');
});

test('the in-browser timeline is bounded so repeated refreshes cannot grow it without limit', () => {
  const activity = Array.from({ length: 500 }, (unused, index) => ({
    kind: 'claim',
    at: new Date(NOW_MS - index * 1000).toISOString(),
    issueNumber: index,
  }));
  assert.equal(buildTimeline({ activity, audit: [], limit: 80 }).length, 80);
});

test('rows without a usable timestamp are dropped rather than sorted arbitrarily', () => {
  const rows = buildTimeline({ activity: [{ kind: 'claim', at: null }], audit: [{ at: undefined, action: 'x' }] });
  assert.equal(rows.length, 0);
});

test('event labels and tones are typed, with failures and unresolved attention marked critical', () => {
  assert.equal(activityEventLabel({ kind: 'run-result' }), 'Run result');
  assert.equal(activityEventLabel({ kind: 'nope' }), 'Runner event');
  assert.equal(activityEventTone({ kind: 'run-result', outcome: 'failed' }), 'critical');
  assert.equal(activityEventTone({ kind: 'run-result', outcome: 'succeeded' }), 'ok');
  assert.equal(activityEventTone({ kind: 'run-result', outcome: 'unresolved' }), 'warn');
  assert.equal(activityEventTone({ kind: 'attention', resolved: false }), 'critical');
  assert.equal(activityEventTone({ kind: 'attention', resolved: true }), 'neutral');
});

test('filtering works over already-loaded fields only, including by source', () => {
  const rows = buildTimeline({
    activity: [{ kind: 'queue-event', at: '2026-08-11T10:00:00.000Z', reason: 'manager-preflight-required', issueNumber: 12, repo: 'a/b' }],
    audit: [{ at: '2026-08-11T11:00:00.000Z', actor: 'operator', action: 'secret.rotate', changedFields: ['secrets.claude-code-cli'] }],
  });
  assert.equal(filterTimeline(rows, { query: 'preflight' }).length, 1);
  assert.equal(filterTimeline(rows, { query: 'PREFLIGHT' }).length, 1);
  assert.equal(filterTimeline(rows, { query: '12' }).length, 1);
  assert.equal(filterTimeline(rows, { source: 'operator' }).length, 1);
  assert.equal(filterTimeline(rows, { source: 'runner' }).length, 1);
  assert.equal(filterTimeline(rows, { query: '' }).length, 2);
  assert.equal(filterTimeline(rows, { query: 'nothing-matches' }).length, 0);
});

// -- announcements and refresh ----------------------------------------

test('aria-live announces only genuinely changed state, so polling stays quiet', () => {
  const first = { runner: 'idle', scheduler: 'healthy', task: 'idle', attention: 0 };
  assert.equal(buildStatusAnnouncement(first, first), null);
  assert.equal(buildStatusAnnouncement(null, first), 'Runner idle. Scheduler healthy. Current task idle. 0 unresolved attention event(s)');
  assert.equal(
    buildStatusAnnouncement(first, { ...first, runner: 'running', task: 'running' }),
    'Runner running. Current task running',
  );
  assert.equal(buildStatusAnnouncement(first, null), null);
});

test('the status signature is derived from the vocabulary, so an unknown code cannot masquerade', () => {
  const signature = statusSignature({ runner: { code: 'made-up' }, scheduler: { code: 'healthy' }, currentTask: { active: true }, attention: { unresolvedCount: 2 } });
  assert.deepEqual(signature, { runner: 'unknown', scheduler: 'healthy', task: 'running', attention: 2 });
});

test('a hidden tab does no polling at all, and an active run refreshes faster than an idle one', () => {
  assert.equal(nextRefreshDelayMs({ visible: false }), null);
  assert.equal(nextRefreshDelayMs({ visible: true, activeRun: false }), 15000);
  assert.equal(nextRefreshDelayMs({ visible: true, activeRun: true }), 8000);
});

test('companion links render as an honest "not configured" note rather than a dead control', () => {
  const configured = describeLink('http://127.0.0.1:3000/d/runner', { label: 'Open Grafana Runner', unavailableNote: 'Not configured.' });
  assert.equal(configured.available, true);
  assert.equal(configured.url, 'http://127.0.0.1:3000/d/runner');

  const missing = describeLink(null, { label: 'Open Grafana Runner', unavailableNote: 'Not configured.' });
  assert.equal(missing.available, false);
  assert.equal(missing.url, null);
  assert.equal(missing.note, 'Not configured.');
});
