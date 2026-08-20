import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openRunnerStateStore, RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';
import { buildAttentionEvent } from './claude-runner-recovery.mjs';
import { buildRunnerActivity, buildRunnerDashboard, buildRunnerMetrics, buildRunnerOperatorStatus, parseArgs, run } from './claude-runner-dashboard-api.mjs';
import { main } from './claude-runner-cron.mjs';

function memoryIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } },
    },
    read: () => ({ stdout, stderr }),
  };
}

// `await`s `fn(dir)` (not merely returns it) so an async callback's I/O
// against `dir` — e.g. driving the real `main()` scheduler — fully settles
// before cleanup; returning the pending promise directly would let the
// `finally` below delete the directory out from under still-running work.
async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseArgs defaults to env state DB and accepts dashboard options', () => {
  const args = parseArgs(['--limit', '7', '--strict'], { CLAUDE_RUNNER_STATE_DB: '/tmp/runner.sqlite' });
  assert.equal(args.dbPath, '/tmp/runner.sqlite');
  assert.equal(args.historyLimit, 7);
  assert.equal(args.strict, true);
});

test('operator summary distinguishes systemic pause, attention, quarantine, moving, degraded queue inspection, and idle (#698 round 5, finding 3)', () => {
  // systemic_pause/queue_inspection_degraded now come from the third
  // argument (`currentHealthConditions`, the resolvable
  // runner_health_conditions table), not from `latest.queueEvents` — a
  // prior version inferred these from a bounded latest-N event window,
  // which could keep showing a cleared condition indefinitely.
  const systemicPause = [{ condition_type: 'systemic_pause', reason: 'runner_state_unavailable' }];
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [] }, {}, systemicPause).code, 'global_systemic_pause');
  const actionableAttention = { counts: { actionable: 1, historical: 0, unknown: 0, stale: 0 } };
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [{ resolved_at: null }] }, {}, [], actionableAttention).code, 'attention_required');
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [{ resolved_at: null }] }, {}, []).code, 'attention_reconciliation_degraded');
  // A *resolved* attention event must never itself trigger
  // `attention_required` — only the still-unresolved subset does (#698
  // round 4, finding 4's fourth enumerated state: "resolved attention").
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [{ resolved_at: '2026-07-18T12:00:00Z' }], runResults: [] }, {}, []).code, 'idle');
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [{ event_type: 'quarantine' }], attentionEvents: [] }, {}, []).code, 'task_local_quarantines');
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [], runResults: [{ mode: 'issue-run' }] }, {}, []).code, 'queue_moving');
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [], runResults: [] }, {}, []).code, 'idle');

  // #698 finding 3: a repo-wide GitHub outage that prevented the queue from
  // ever being inspected must read as visibly degraded, never as an
  // unproven "no eligible work" idle claim.
  const degradedCondition = [{ condition_type: 'queue_inspection_degraded', reason: 'candidate-scan-failed' }];
  const degraded = buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [], runResults: [] }, {}, degradedCondition);
  assert.equal(degraded.code, 'queue_inspection_degraded');
  assert.notEqual(degraded.code, 'idle');
  assert.equal(degraded.reason, 'candidate-scan-failed');

  // Degraded queue inspection must never mask or outrank a more urgent,
  // already-known state — it only replaces what would otherwise be an
  // unproven `idle`.
  const both = [{ condition_type: 'systemic_pause' }, { condition_type: 'queue_inspection_degraded' }];
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [] }, {}, both).code, 'global_systemic_pause');
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [{ resolved_at: null }] }, {}, degradedCondition, actionableAttention).code, 'attention_required');
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [{ event_type: 'quarantine' }], attentionEvents: [] }, {}, degradedCondition).code, 'task_local_quarantines');
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [], runResults: [{ mode: 'issue-run' }] }, {}, degradedCondition).code, 'queue_moving');

  // A *resolved* health condition (opened, then resolved) must never keep
  // showing — `currentHealthConditions` only ever contains unresolved rows
  // by construction (the store method filters `resolved_at IS NULL`), so a
  // resolved row simply isn't in the array passed here at all.
  assert.equal(buildRunnerOperatorStatus({ queueEvents: [], attentionEvents: [], runResults: [] }, {}, []).code, 'idle', 'no current (unresolved) health conditions must read as idle, not paused/degraded');
});

test('dashboard/operator status reads degraded, never idle, after repeated repo-wide GitHub list failures through the real scheduler (#698 round 4, finding 3)', () => withTempDir('modelspend-runner-dashboard-degraded-', async (dir) => {
  const stateDbPath = join(dir, 'state.sqlite');
  const ghRunner = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') throw new Error('simulated repeated GitHub outage listing open PRs');
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([]);
    return '';
  };
  // Run the real scheduler pass three times in a row, as a cron timer
  // would — each pass fails the repo-wide list the same way. Nothing else
  // ever runs (no candidate was ever inspected), so an operator watching
  // only `idle` would wrongly conclude the queue is simply empty rather
  // than that it was never actually checked.
  for (let i = 0; i < 3; i += 1) {
    const exitCode = await main([
      '--allow-root', '--skip-quota-preflight', '--output-dir', dir,
      '--state-db', stateDbPath, '--lock-path', join(dir, `cron-${i}.lock`),
    ], { GH_TOKEN: 'test-token' }, { ghRunner });
    assert.notEqual(exitCode, undefined);
  }
  const dashboard = buildRunnerDashboard(stateDbPath, { now: () => '2026-07-18T12:00:00.000Z' });
  assert.equal(dashboard.operatorStatus.code, 'queue_inspection_degraded');
  assert.notEqual(dashboard.operatorStatus.code, 'idle');
}));

test('dashboard API returns structured diagnostic for missing DB without crashing', () => withTempDir('modelspend-runner-dashboard-missing-', (dir) => {
  const dbPath = join(dir, 'missing.sqlite');
  const dashboard = buildRunnerDashboard(dbPath, { now: () => '2026-07-09T13:00:00.000Z' });

  assert.deepEqual(dashboard.project, {
    projectId: 'modelspend',
    displayName: 'ModelSpend',
    githubRepo: 'TheTekTeam/modelspend',
    localRepoPath: '/workspace/modelspend',
  });
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.status, 'missing');
  assert.equal(dashboard.dbPath, dbPath);
  assert.equal(dashboard.counts.queue_events, 0);
  assert.deepEqual(dashboard.latest.queueEvents, []);
  assert.equal(dashboard.activity.status, 'empty');
  assert.equal(dashboard.diagnostics[0].code, 'state-db-missing');
}));

test('dashboard API returns valid empty payload for empty DB', () => withTempDir('modelspend-runner-dashboard-empty-', (dir) => {
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-09T13:01:00.000Z' });
  store.close();

  const dashboard = buildRunnerDashboard(dbPath, { now: () => '2026-07-09T13:02:00.000Z' });
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.status, 'ok');
  assert.equal(dashboard.schemaVersion, RUNNER_STATE_SCHEMA_VERSION);
  assert.equal(dashboard.counts.queue_events, 0);
  assert.equal(dashboard.counts.quota_history, 0);
  assert.deepEqual(dashboard.latest.runs, []);
  assert.deepEqual(dashboard.aggregates.skippedQueueReasons, []);
  assert.deepEqual(dashboard.metrics, {
    runs: {
      total: 0,
      schedulerPolls: 0,
      noSelectionPolls: 0,
      quotaBlockedPolls: 0,
      issueRuns: 0,
      succeeded: 0,
      failed: 0,
      averageDurationSeconds: null,
    },
    quota: { blockedCount: 0, latestSessionUsagePercent: null, latestWeeklyUsagePercent: null },
    queue: {
      skipReasons: [], skipEventCount: 0, skippedIssueCount: 0, skipReasonCount: 0, oldestQueuedOrSkippedAt: null, assignments: [],
    },
    eta: {
      status: 'insufficient-data',
      confidence: 'low',
      message: 'Not enough completed issue-run history to estimate ETA.',
    },
  });
  assert.equal(dashboard.activity.status, 'empty');
}));

test('dashboard API groups populated DB rows into operator-readable sections', () => withTempDir('modelspend-runner-dashboard-populated-', (dir) => {
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-09T13:03:00.000Z' });
  try {
    store.recordQueueEvent({
      repo: 'TheTekTeam/modelspend',
      eventType: 'skip',
      issueNumber: 580,
      statusLabel: 'status:ready',
      reason: 'quota-blocked',
      payload: { reason: 'quota-blocked' },
      createdAt: '2026-07-09T13:03:01.000Z',
    });
    store.recordQuotaHistory({
      repo: 'TheTekTeam/modelspend',
      quotaPreflight: {
        status: 'available',
        blocked: false,
        payload: { state: { sessionPercentUsed: 12, weeklyPercentUsed: 34 } },
      },
      createdAt: '2026-07-09T13:03:02.000Z',
    });
    store.recordPreflightPacket({
      repo: 'TheTekTeam/modelspend',
      issueNumber: 653,
      sourceCommentId: '99',
      fingerprint: 'abc123def4567890',
      stale: false,
      action: 'generated',
      payload: { issue: 653 },
      createdAt: '2026-07-09T13:03:03.000Z',
    });
    store.recordIssueSelection({
      repo: 'TheTekTeam/modelspend',
      issueNumber: 653,
      statusLabel: 'status:ready',
      selectionMode: 'preflight-direct',
      sourcePreflightCommentId: '99',
      dryRun: false,
      payload: { selectedIssue: 653 },
      createdAt: '2026-07-09T13:03:04.000Z',
    });
    store.recordClaim({
      repo: 'TheTekTeam/modelspend',
      issueNumber: 653,
      claim: { action: 'claim-ready-issue', statusLabel: 'status:ready', selectionMode: 'preflight-direct' },
      createdAt: '2026-07-09T13:00:05.000Z',
    });
    store.recordRunResult({
      repo: 'TheTekTeam/modelspend',
      issueNumber: 653,
      mode: 'issue-run',
      exitCode: 0,
      logPath: '.var/claude-runner/cron.json',
      payload: { selectedIssue: 653, exitCode: 0 },
      startedAt: '2026-07-09T13:00:00.000Z',
      finishedAt: '2026-07-09T13:03:00.000Z',
      createdAt: '2026-07-09T13:03:06.000Z',
    });
    store.recordRunResult({
      repo: 'TheTekTeam/modelspend',
      mode: 'no-selection',
      exitCode: 0,
      payload: { selectedIssue: null },
      createdAt: '2026-07-09T13:03:07.000Z',
    });
  } finally {
    store.close();
  }

  const dashboard = buildRunnerDashboard(dbPath, { now: () => '2026-07-09T13:04:00.000Z', historyLimit: 10 });
  assert.equal(dashboard.status, 'ok');
  assert.equal(dashboard.counts.issue_selections, 1);
  assert.equal(dashboard.latest.queueEvents[0].reason, 'quota-blocked');
  assert.equal(dashboard.latest.quota[0].session_usage_percent, 12);
  assert.equal(dashboard.latest.preflights[0].fingerprint, 'abc123def4567890');
  assert.equal(dashboard.latest.selections[0].selection_mode, 'preflight-direct');
  assert.equal(dashboard.latest.claims[0].action, 'claim-ready-issue');
  assert.equal(dashboard.latest.runResults[0].mode, 'no-selection');
  assert.equal(dashboard.latest.runs[1].issue_number, 653);
  assert.deepEqual(dashboard.aggregates.skippedQueueReasons, [{ reason: 'quota-blocked', count: 1, latestAt: '2026-07-09T13:03:01.000Z' }]);
  assert.equal(dashboard.aggregates.preflightFingerprints[0].fingerprint, 'abc123def4567890');
  assert.deepEqual(dashboard.metrics.runs, {
    total: 1,
    schedulerPolls: 2,
    noSelectionPolls: 1,
    quotaBlockedPolls: 0,
    issueRuns: 1,
    succeeded: 1,
    failed: 0,
    averageDurationSeconds: 180,
  });
  assert.deepEqual(dashboard.metrics.quota, { blockedCount: 0, latestSessionUsagePercent: 12, latestWeeklyUsagePercent: 34 });
  assert.deepEqual(dashboard.metrics.queue, {
    skipReasons: [{ reason: 'quota-blocked', count: 1, latestAt: '2026-07-09T13:03:01.000Z' }],
    skipEventCount: 1,
    skippedIssueCount: 1,
    skipReasonCount: 1,
    oldestQueuedOrSkippedAt: '2026-07-09T13:03:01.000Z',
    assignments: [],
  });
  assert.equal(dashboard.metrics.eta.status, 'insufficient-data');
  assert.equal(dashboard.activity.status, 'idle');
  assert.equal(dashboard.activity.latestIssue.issue_number, 653);
}));

test('dashboard normalizes historical quota rows whose numeric columns were left null by the old persistence shape', () => withTempDir('modelspend-runner-dashboard-quota-recovery-', (dir) => {
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-17T15:54:55.388Z' });
  try {
    store.db.prepare(`
      INSERT INTO quota_history (created_at, repo, status, blocked, skipped, reason, session_usage_percent, weekly_usage_percent, reset_at, payload_json)
      VALUES (?, ?, ?, 0, 0, NULL, NULL, NULL, NULL, ?)
    `).run(
      '2026-07-17T15:54:55.388Z',
      'TheTekTeam/modelspend',
      'available',
      JSON.stringify({
        blocked: false,
        status: 'available',
        payload: {
          status: 'available',
          state: {
            sessionPercentUsed: 0,
            weeklyPercentUsed: 52,
            quotaUsage: {
              session: { usedPercent: 0, resetAt: '2026-07-17T18:00:00.000Z' },
              week: { usedPercent: 52, resetAt: '2026-07-20T18:00:00.000Z' },
            },
          },
        },
      }),
    );
  } finally {
    store.close();
  }

  const dashboard = buildRunnerDashboard(dbPath, { historyLimit: 5 });
  assert.equal(dashboard.latest.quota[0].session_usage_percent, 0);
  assert.equal(dashboard.latest.quota[0].weekly_usage_percent, 52);
  assert.equal(dashboard.latest.quota[0].reset_at, '2026-07-17T18:00:00.000Z');
  assert.equal(dashboard.metrics.quota.latestSessionUsagePercent, 0);
  assert.equal(dashboard.metrics.quota.latestWeeklyUsagePercent, 52);
}));

test('buildRunnerActivity distinguishes unresolved claims from historical activity', () => {
  const unresolved = buildRunnerActivity({
    claims: [{ repo: 'TheTekTeam/modelspend', issue_number: 700, action: 'claim-ready-issue', created_at: '2026-07-09T12:00:00.000Z' }],
    runResults: [], selections: [], queueEvents: [], quota: [], preflights: [], runs: [],
  });
  assert.equal(unresolved.status, 'active-or-unresolved');
  assert.equal(unresolved.activeIssue.issue_number, 700);

  const completed = buildRunnerActivity({
    claims: [{ repo: 'TheTekTeam/modelspend', issue_number: 700, action: 'claim-ready-issue', created_at: '2026-07-09T12:00:00.000Z' }],
    runResults: [{ repo: 'TheTekTeam/modelspend', issue_number: 700, mode: 'issue-run', exit_code: 0, finished_at: '2026-07-09T12:05:00.000Z' }],
    selections: [], queueEvents: [], quota: [], preflights: [], runs: [],
  });
  assert.equal(completed.status, 'idle');
  assert.equal(completed.activeIssue, null);
});

test('dashboard CLI reports corrupt DBs and only exits non-zero in strict mode', () => withTempDir('modelspend-runner-dashboard-corrupt-', (dir) => {
  const dbPath = join(dir, 'corrupt.sqlite');
  writeFileSync(dbPath, 'not a sqlite database');

  const nonStrict = memoryIo();
  assert.equal(run(['--db', dbPath], {}, nonStrict.io), 0);
  const payload = JSON.parse(nonStrict.read().stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, 'error');
  assert.equal(payload.diagnostics[0].code, 'state-db-error');

  const strict = memoryIo();
  assert.equal(run(['--db', dbPath, '--strict'], {}, strict.io), 1);
}));

test('buildRunnerMetrics excludes no-selection polls from implementation success and produces a distinct-issue ETA', () => {
  const metrics = buildRunnerMetrics({
    latest: {
      runResults: [
        { mode: 'no-selection', exit_code: 0, created_at: '2026-07-09T09:55:00.000Z' },
        { mode: 'issue-run', exit_code: 0, started_at: '2026-07-09T10:00:00.000Z', finished_at: '2026-07-09T10:10:00.000Z' },
        { mode: 'issue-run', exit_code: 1, started_at: '2026-07-09T10:20:00.000Z', finished_at: '2026-07-09T10:40:00.000Z' },
        { mode: 'issue-run', exit_code: 0, started_at: '2026-07-09T11:00:00.000Z', finished_at: '2026-07-09T11:30:00.000Z' },
        { mode: 'quota-blocked', exit_code: 0, created_at: '2026-07-09T11:45:00.000Z' },
      ],
      selections: [{ issue_number: 656, created_at: '2026-07-09T12:00:00.000Z' }],
      queueEvents: [
        { event_type: 'skip', issue_number: 580, reason: 'quota-blocked', created_at: '2026-07-09T09:00:00.000Z' },
        { event_type: 'skip', issue_number: 581, reason: 'missing preflight', created_at: '2026-07-09T09:30:00.000Z' },
        { event_type: 'skip', issue_number: 582, reason: 'quota-blocked', created_at: '2026-07-09T09:45:00.000Z' },
        { event_type: 'skip', issue_number: 580, reason: 'quota-blocked', created_at: '2026-07-09T09:50:00.000Z' },
      ],
      quota: [
        { blocked: 1, session_usage_percent: 91, weekly_usage_percent: 88, created_at: '2026-07-09T12:05:00.000Z' },
        { blocked: 0, session_usage_percent: 40, weekly_usage_percent: 50, created_at: '2026-07-09T08:00:00.000Z' },
      ],
      preflights: [], claims: [], runs: [],
    },
  });

  assert.deepEqual(metrics.runs, {
    total: 3,
    schedulerPolls: 5,
    noSelectionPolls: 1,
    quotaBlockedPolls: 1,
    issueRuns: 3,
    succeeded: 2,
    failed: 1,
    averageDurationSeconds: 1200,
  });
  assert.deepEqual(metrics.quota, { blockedCount: 1, latestSessionUsagePercent: 91, latestWeeklyUsagePercent: 88 });
  assert.equal(metrics.queue.skipEventCount, 4);
  assert.equal(metrics.queue.skippedIssueCount, 3);
  assert.equal(metrics.queue.skipReasonCount, 2);
  assert.deepEqual(metrics.queue.skipReasons, [
    { reason: 'quota-blocked', count: 3, latestAt: '2026-07-09T09:50:00.000Z' },
    { reason: 'missing preflight', count: 1, latestAt: '2026-07-09T09:30:00.000Z' },
  ]);
  assert.equal(metrics.queue.oldestQueuedOrSkippedAt, '2026-07-09T09:00:00.000Z');
  assert.deepEqual(metrics.eta, {
    status: 'estimated-range',
    confidence: 'low',
    estimatedSecondsLow: 2400,
    estimatedSecondsHigh: 7200,
    basis: { completedRuns: 3, outstandingIssues: 4 },
    message: 'Rough ETA range based on persisted issue-run durations and distinct selected/skipped issues.',
  });
});

test('current-attempt projection shows the shared assignment as Codex / Claude and keeps the actual selected worker separate (#97)', () => {
  const latest = {
    claims: [{ repo: 'TheTekTeam/modelspend', issue_number: 97, action: 'claim-ready-issue', status_label: 'status:in-progress', created_at: '2026-07-28T12:00:00.000Z' }],
    selections: [{
      repo: 'TheTekTeam/modelspend',
      issue_number: 97,
      status_label: 'status:ready',
      selection_mode: 'preflight-direct',
      created_at: '2026-07-28T11:59:00.000Z',
      payload: { agent: { agentId: 'claude-code-cli', assignmentLabel: 'agent:codex-claude' } },
    }],
    runResults: [], queueEvents: [], quota: [], preflights: [], recoveryAttempts: [], attentionEvents: [], runs: [],
  };

  const activity = buildRunnerActivity(latest);
  assert.equal(activity.status, 'active-or-unresolved');
  assert.equal(activity.activeIssue.issue_number, 97);
  // The eligibility label is displayed, and the worker that actually holds
  // the attempt is retained beside it -- never in place of it.
  assert.equal(activity.activeIssue.assignment_label, 'agent:codex-claude');
  assert.equal(activity.activeIssue.assignment_display_name, 'Codex / Claude');
  assert.equal(activity.activeIssue.agent, 'claude-code-cli');

  const queue = buildRunnerMetrics({ latest }).queue;
  assert.deepEqual(queue.assignments, [
    { assignmentLabel: 'agent:codex-claude', assignmentDisplayName: 'Codex / Claude', issueCount: 1 },
  ]);
});

test('buildRunnerActivity correlates a claim\'s terminal result by repo AND issue number, not issue number alone (#172)', () => {
  const latest = {
    claims: [{ repo: 'TheTekTeam/modelspend', issue_number: 757, action: 'claim-ready-issue', status_label: 'status:in-progress', created_at: '2026-07-28T21:23:13.615Z' }],
    // A terminal run result for the SAME issue number under a DIFFERENT
    // repo must never be mistaken for this claim's own terminal result.
    runResults: [{ repo: 'TheTekTeam/other-project', issue_number: 757, finished_at: '2026-07-28T21:26:31.556Z', exit_code: 1 }],
    selections: [], queueEvents: [], quota: [], preflights: [], recoveryAttempts: [], attentionEvents: [], runs: [],
  };
  const activity = buildRunnerActivity(latest);
  assert.equal(activity.status, 'active-or-unresolved');
  assert.equal(activity.activeIssue.repo, 'TheTekTeam/modelspend');

  // The genuine terminal result, once correctly scoped to the same repo,
  // resolves the claim.
  latest.runResults.push({ repo: 'TheTekTeam/modelspend', issue_number: 757, finished_at: '2026-07-28T21:26:31.556Z', exit_code: 1 });
  const resolved = buildRunnerActivity(latest);
  assert.equal(resolved.status, 'idle');
});

test('assignment projection preserves non-shared labels, fails closed on unknown label/agent text and never invents evidence (#97)', () => {
  const nonShared = buildRunnerActivity({
    claims: [{ repo: 'TheTekTeam/modelspend', issue_number: 11, action: 'claim-ready-issue', created_at: '2026-07-28T12:00:00.000Z' }],
    selections: [{
      repo: 'TheTekTeam/modelspend',
      issue_number: 11,
      created_at: '2026-07-28T11:00:00.000Z',
      payload: { agent: { agentId: 'claude-code-cli', assignmentLabel: 'agent:claude-code-cli' } },
    }],
    runResults: [], queueEvents: [], quota: [], preflights: [], recoveryAttempts: [], attentionEvents: [], runs: [],
  });
  // No display alias exists for a non-shared label, so the canonical helper
  // returns the label unchanged -- existing output is not rewritten.
  assert.equal(nonShared.activeIssue.assignment_display_name, 'agent:claude-code-cli');
  assert.equal(nonShared.activeIssue.agent, 'claude-code-cli');

  const untrusted = buildRunnerActivity({
    claims: [{ repo: 'TheTekTeam/modelspend', issue_number: 12, action: 'claim-ready-issue', created_at: '2026-07-28T12:00:00.000Z' }],
    selections: [{
      repo: 'TheTekTeam/modelspend',
      issue_number: 12,
      created_at: '2026-07-28T11:00:00.000Z',
      payload: { agent: { agentId: '/home/secret/path', assignmentLabel: 'agent:UNTRUSTED-LABEL-TEXT' } },
    }],
    runResults: [], queueEvents: [], quota: [], preflights: [], recoveryAttempts: [], attentionEvents: [], runs: [],
  });
  assert.equal(untrusted.activeIssue.assignment_label, null);
  assert.equal(untrusted.activeIssue.assignment_display_name, null);
  assert.equal(untrusted.activeIssue.agent, null);
  assert.equal(JSON.stringify(untrusted).includes('UNTRUSTED-LABEL-TEXT'), false);
  assert.equal(JSON.stringify(untrusted).includes('/home/secret/path'), false);

  // Assignment evidence for a different issue is never borrowed.
  const unrelated = buildRunnerActivity({
    claims: [{ repo: 'TheTekTeam/modelspend', issue_number: 13, action: 'claim-ready-issue', created_at: '2026-07-28T12:00:00.000Z' }],
    selections: [{
      repo: 'TheTekTeam/modelspend',
      issue_number: 99,
      created_at: '2026-07-28T11:00:00.000Z',
      payload: { agent: { agentId: 'claude-code-cli', assignmentLabel: 'agent:codex-claude' } },
    }],
    runResults: [], queueEvents: [], quota: [], preflights: [], recoveryAttempts: [], attentionEvents: [], runs: [],
  });
  assert.equal(unrelated.activeIssue.assignment_display_name, null);
  assert.equal(unrelated.activeIssue.agent, null);
});

test('dashboard API allowlists recovery_attempts/run_results/attention_events output and never exposes restricted columns (#698 finding 9)', () => withTempDir('modelspend-runner-dashboard-allowlist-', (dir) => {
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-09T13:03:00.000Z' });
  const SENTINEL = 'RESTRICTED-SENTINEL-f9-do-not-leak';
  try {
    store.recordRecoveryAttempt({
      attemptId: 'attempt-f9', repo: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698,
      claimId: '41', preflightRevision: '41', phase: 'implementation', agent: 'claude-code-cli', model: 'claude-sonnet-4-5', harness: 'claude',
      startedAt: '2026-07-09T13:00:00Z', finishedAt: '2026-07-09T13:03:00Z', outcome: 'completed',
      recoveryEligible: false, recoveryAction: 'none', resolutionState: 'resolved',
      processId: 4242, processBootId: `${SENTINEL}-boot`, processStartTicks: `${SENTINEL}-ticks`, systemdInvocationId: `${SENTINEL}-invocation`,
      restrictedEvidence: { logPath: `/home/modelspend/${SENTINEL}/cron.json`, restrictedRecoveryHandleDigest: `${SENTINEL}-digest`, stdout: `${SENTINEL}-stdout` },
    });
    store.recordRunResult({
      repo: 'TheTekTeam/modelspend', issueNumber: 698, mode: 'issue-run', exitCode: 0,
      logPath: `/home/modelspend/${SENTINEL}/run.json`,
      payload: { claudeArgsPreview: [`${SENTINEL}-arg`], stdout: `${SENTINEL}-stdout`, prompt: `${SENTINEL}-prompt` },
      startedAt: '2026-07-09T13:00:00Z', finishedAt: '2026-07-09T13:03:00Z',
    });
    store.upsertAttentionEvent(buildAttentionEvent({
      repository: 'TheTekTeam/modelspend', issueNumber: 698, attemptId: 'attempt-f9', reason: 'unknown_failure',
      recoveryStatus: 'forbidden', nextAction: 'Investigate.', finishedAt: '2026-07-09T13:03:00Z',
    }));

    const dashboard = buildRunnerDashboard(dbPath, { now: () => '2026-07-09T13:04:00.000Z' });
    const serialized = JSON.stringify(dashboard);
    assert.equal(serialized.includes(SENTINEL), false, `restricted sentinel leaked into dashboard output: ${serialized}`);

    // Positive check: the allowlisted safe fields are still present and correct.
    const attempt = dashboard.latest.recoveryAttempts[0];
    assert.equal(attempt.attempt_id, 'attempt-f9');
    assert.equal(attempt.outcome, 'completed');
    assert.equal(attempt.resolution_state, 'resolved');
    assert.equal('process_id' in attempt, false);
    assert.equal('process_boot_id' in attempt, false);
    assert.equal('payload' in attempt, false);
    assert.equal('payload_json' in attempt, false);

    const run = dashboard.latest.runResults[0];
    assert.equal(run.mode, 'issue-run');
    assert.equal(run.exit_code, 0);
    assert.equal('log_path' in run, false);
    assert.equal('payload' in run, false);

    const attention = dashboard.latest.attentionEvents[0];
    assert.equal(attention.issue_number, 698);
    assert.equal(attention.reason, 'unknown_failure');
    assert.equal('event_json' in attention, false);
    assert.equal('dedupe_key' in attention, false);
  } finally {
    store.close();
  }
}));

test('dashboard API allowlists notification_events output and never exposes dedupe_key/source_ref/content_json/last_error (#53)', () => withTempDir('agent-runner-notifications-dashboard-allowlist-', (dir) => {
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-24T13:00:00.000Z' });
  const SENTINEL = 'RESTRICTED-SENTINEL-53-do-not-leak';
  try {
    store.recordNotificationEvent({
      repo: 'TheTekTeam/agent-runner', issueNumber: 53, eventType: 'failed_attention', reasonCode: 'attention-required',
      sourceTable: 'attention_events', sourceRef: `${SENTINEL}-ref`, occurredAt: '2026-07-24T12:00:00.000Z',
      dedupeKey: `${SENTINEL}-dedupe`,
      content: { eventType: 'failed_attention', reasonCode: 'attention-required', repo: 'TheTekTeam/agent-runner', issueNumber: 53, agent: null, occurredAt: '2026-07-24T12:00:00.000Z', leaked: `${SENTINEL}-content` },
    });
    store.claimNotificationForDelivery({ dedupeKey: `${SENTINEL}-dedupe`, owner: 'test-pass', at: '2026-07-24T12:04:00.000Z' });
    store.markNotificationDeliveryFailed({ dedupeKey: `${SENTINEL}-dedupe`, attemptedAt: '2026-07-24T12:05:00.000Z', errorCode: `${SENTINEL}-error`, nextAttemptAt: '2026-07-24T12:10:00.000Z' });

    const dashboard = buildRunnerDashboard(dbPath, { now: () => '2026-07-24T13:01:00.000Z' });
    const serialized = JSON.stringify(dashboard);
    assert.equal(serialized.includes(SENTINEL), false, `restricted sentinel leaked into dashboard output: ${serialized}`);

    const notification = dashboard.latest.notifications[0];
    assert.equal(notification.issue_number, 53);
    assert.equal(notification.event_type, 'failed_attention');
    assert.equal(notification.delivery_status, 'retryable-failed');
    assert.equal(notification.attempt_count, 1);
    assert.equal('dedupe_key' in notification, false);
    assert.equal('source_table' in notification, false);
    assert.equal('source_ref' in notification, false);
    assert.equal('content_json' in notification, false);
    assert.equal('last_error' in notification, false);
    assert.equal('in_flight_owner' in notification, false);
    assert.equal('in_flight_claimed_at' in notification, false);
  } finally {
    store.close();
  }
}));

test('#44: dashboard API surfaces a bounded profile-quota-headroom-insufficient skip reason with no raw quota-preflight process evidence', () => withTempDir('modelspend-runner-dashboard-quota-profile-', (dir) => {
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-09T13:03:00.000Z' });
  try {
    store.recordQueueEvent({
      repo: 'TheTekTeam/modelspend',
      eventType: 'skip',
      issueNumber: 910,
      statusLabel: 'status:ready',
      reason: 'profile-quota-headroom-insufficient',
      payload: {
        reason: 'profile-quota-headroom-insufficient',
        profile: 'critical',
        quotaAdmission: { allowed: false, profile: 'critical', threshold: 50, sessionPercentUsed: 60, status: 'exhausted', reason: 'profile-session-usage-threshold-exceeded' },
      },
      createdAt: '2026-07-09T13:03:01.000Z',
    });
  } finally {
    store.close();
  }

  const dashboard = buildRunnerDashboard(dbPath, { now: () => '2026-07-09T13:04:00.000Z' });
  assert.deepEqual(dashboard.aggregates.skippedQueueReasons, [{ reason: 'profile-quota-headroom-insufficient', count: 1, latestAt: '2026-07-09T13:03:01.000Z' }]);
  assert.equal(dashboard.latest.queueEvents[0].payload.quotaAdmission.threshold, 50);
  const serialized = JSON.stringify(dashboard);
  assert.equal(/stdout|stderr|nodeArgs|payload_json/.test(serialized), false, 'no raw quota-preflight process evidence leaks into dashboard output');
}));
