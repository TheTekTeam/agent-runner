import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { defaultRunnerStateDbPath, openRunnerStateStore, RUNNER_STATE_SCHEMA_VERSION, summarizeRunnerState } from './claude-runner-state.mjs';
import { buildAttentionEvent } from './claude-runner-recovery.mjs';

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-state-'));
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-09T10:00:00.000Z' });
  try {
    return fn(store, dbPath, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedFalseDryRunDefect(store, {
  issueNumber = 300,
  startedAt = '2026-07-19T09:00:00.000Z',
  finishedAt = '2026-07-19T09:00:01.000Z',
  dryRun = true,
  schedulerExitCode = 1,
} = {}) {
  const repo = 'TheTekTeam/modelspend';
  const attemptId = `${repo}#${issueNumber}:${startedAt}`;
  const event = buildAttentionEvent({
    repository: repo,
    project: 'modelspend',
    issueNumber,
    attemptId,
    reason: 'unknown_failure',
    agent: 'claude-code-cli',
    startedAt,
    finishedAt,
    recoveryStatus: 'forbidden',
    nextAction: 'Manager review.',
  });
  store.recordIssueSelection({
    repo,
    issueNumber,
    statusLabel: 'status:ready',
    selectionMode: 'preflight-direct',
    sourcePreflightCommentId: '72501',
    dryRun,
    payload: { dryRun, selectedIssue: issueNumber, selectionMode: 'preflight-direct' },
    createdAt: startedAt,
  });
  store.recordRecoveryAttempt({
    attemptId,
    repo,
    project: 'modelspend',
    issueNumber,
    claimId: '72501',
    preflightRevision: '72501',
    agent: 'claude-code-cli',
    startedAt,
    finishedAt,
    outcome: 'unknown_failure',
    exitCode: 0,
    recoveryEligible: false,
    recoveryAction: 'attention_required',
    recoveryAttemptCount: 0,
    attentionStatus: 'attention_required',
    attentionDedupeKey: event.dedupeKey,
    resolutionState: 'unresolved',
  });
  store.upsertAttentionEvent(event);
  store.recordRunResult({
    repo,
    issueNumber,
    mode: 'issue-run',
    exitCode: schedulerExitCode,
    startedAt,
    finishedAt,
    createdAt: finishedAt,
    payload: {
      dryRun,
      selectedIssue: issueNumber,
      selectionMode: 'preflight-direct',
      sourcePreflightCommentId: 72501,
      claim: null,
      runnerArgs: ['scripts/ops/claude-runner.mjs', '--issue', String(issueNumber)],
      startedAt,
      finishedAt,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      childRunFailure: null,
      terminalOutcome: 'unknown_failure',
      recoveryDecision: { policyRevision: 'runner-recovery-v1', eligible: false, action: 'attention_required', status: 'forbidden', reason: 'unknown_failure' },
      recoveryTransition: null,
      attentionDedupeKey: event.dedupeKey,
      failureRecovery: null,
      executionPhase: null,
      worktreeIdentity: null,
      implementationEvidence: null,
      implementationPublication: null,
      usageAccounting: null,
      awaitingPlanApproval: false,
      planPath: null,
    },
  });
  return { repo, issueNumber, attemptId, event, runResultId: store.allRows('run_results').at(-1).id, attentionEventId: store.allRows('attention_events').at(-1).id };
}

test('defaultRunnerStateDbPath stores SQLite state under the runner output directory', () => {
  assert.equal(defaultRunnerStateDbPath('.var/claude-runner'), '.var/claude-runner/runner-state.sqlite');
});

test('openRunnerStateStore initialises the versioned schema', () => withStore((store) => {
  const rows = store.allRows('runner_state_schema');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, RUNNER_STATE_SCHEMA_VERSION);
  assert.equal(store.assertWritable(), true);
}));

test('runner state store persists queue, quota, preflight, selection, claim and run-result rows', () => withStore((store) => {
  store.recordQueueEvent({
    repo: 'TheTekTeam/modelspend',
    eventType: 'skip',
    issueNumber: 550,
    statusLabel: 'status:in-progress',
    reason: 'missing continue command',
    payload: { issue: 550 },
  });
  store.recordQuotaHistory({
    repo: 'TheTekTeam/modelspend',
    quotaPreflight: {
      blocked: false,
      skipped: false,
      status: 'available',
      payload: {
        status: 'available',
        sessionPercentUsed: 32,
        weeklyPercentUsed: 55,
        resetAt: '2026-07-09T14:00:00.000Z',
      },
    },
  });
  store.recordPreflightPacket({
    repo: 'TheTekTeam/modelspend',
    issueNumber: 580,
    sourceCommentId: 'https://example.invalid/comment',
    fingerprint: 'abc123',
    stale: false,
    action: 'generated',
    payload: { issue: 580 },
  });
  store.recordIssueSelection({
    repo: 'TheTekTeam/modelspend',
    issueNumber: 580,
    statusLabel: 'status:ready',
    selectionMode: 'preflight-direct',
    commandKind: null,
    sourcePreflightCommentId: '77',
    dryRun: false,
    payload: { selectedIssue: 580 },
  });
  store.recordClaim({
    repo: 'TheTekTeam/modelspend',
    issueNumber: 580,
    claim: {
      action: 'claim-ready-issue',
      statusLabel: 'status:ready',
      selectionMode: 'preflight-direct',
      sourceCommentId: null,
      sourcePreflightCommentId: '77',
    },
  });
  store.recordRunResult({
    repo: 'TheTekTeam/modelspend',
    issueNumber: 580,
    mode: 'issue-run',
    exitCode: 0,
    signal: null,
    logPath: '.var/claude-runner/cron.json',
    payload: { selectedIssue: 580, exitCode: 0 },
    startedAt: '2026-07-09T10:01:00.000Z',
    finishedAt: '2026-07-09T10:02:00.000Z',
  });

  assert.equal(store.countRows('queue_events'), 1);
  assert.equal(store.countRows('quota_history'), 1);
  assert.equal(store.countRows('preflight_packets'), 1);
  assert.equal(store.countRows('issue_selections'), 1);
  assert.equal(store.countRows('claims'), 1);
  assert.equal(store.countRows('run_results'), 1);

  const quota = store.allRows('quota_history')[0];
  assert.equal(quota.session_usage_percent, 32);
  assert.equal(quota.weekly_usage_percent, 55);
  assert.equal(quota.status, 'available');

  const result = store.allRows('run_results')[0];
  assert.equal(result.mode, 'issue-run');
  assert.equal(result.log_path, '.var/claude-runner/cron.json');
}));

test('runner state read helpers reject unsupported table names', () => withStore((store) => {
  assert.throws(() => store.countRows('not_a_real_table'), /Unsupported runner state table/);
}));

test('summarizeRunnerState returns a structured missing-db diagnostic without creating the DB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-state-missing-'));
  const dbPath = join(dir, 'missing.sqlite');
  try {
    const summary = summarizeRunnerState(dbPath, { now: () => '2026-07-09T11:00:00.000Z' });
    assert.equal(summary.ok, true);
    assert.equal(summary.status, 'missing');
    assert.equal(summary.dbPath, dbPath);
    assert.equal(summary.counts.queue_events, 0);
    assert.equal(summary.latest.queue_events.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizeRunnerState reports table counts and latest rows for populated DBs', () => withStore((store, dbPath) => {
  store.recordQueueEvent({
    repo: 'TheTekTeam/modelspend',
    eventType: 'skip',
    issueNumber: 452,
    statusLabel: 'status:in-progress',
    reason: 'missing continue command',
    payload: { issue: 452 },
  });
  store.recordRunResult({
    repo: 'TheTekTeam/modelspend',
    issueNumber: 452,
    mode: 'no-selection',
    exitCode: null,
    signal: null,
    logPath: '.var/claude-runner/cron-452.json',
    payload: { selectedIssue: null },
  });

  const summary = summarizeRunnerState(dbPath, { now: () => '2026-07-09T11:01:00.000Z', historyLimit: 1 });
  assert.equal(summary.ok, true);
  assert.equal(summary.status, 'ok');
  assert.equal(summary.schemaVersion, RUNNER_STATE_SCHEMA_VERSION);
  assert.equal(summary.counts.queue_events, 1);
  assert.equal(summary.counts.run_results, 1);
  assert.equal(summary.latest.queue_events.length, 1);
  assert.equal(summary.latest.queue_events[0].issue_number, 452);
}));

test('summarizeRunnerState reports corrupt DBs without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-state-corrupt-'));
  const dbPath = join(dir, 'corrupt.sqlite');
  try {
    writeFileSync(dbPath, 'not a sqlite database');
    const summary = summarizeRunnerState(dbPath, { now: () => '2026-07-09T11:02:00.000Z' });
    assert.equal(summary.ok, false);
    assert.equal(summary.status, 'error');
    assert.match(summary.error.message, /database|file|malformed|disk image/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery counters, deadlines, attention state and dedupe survive reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-recovery-state-'));
  const dbPath = join(dir, 'state.sqlite');
  const event = buildAttentionEvent({ repository: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, attemptId: 'attempt-1', reason: 'provider_execution_limit', agent: 'claude', recoveryStatus: 'forbidden', nextAction: 'Manager review.' });
  try {
    let store = openRunnerStateStore(dbPath, { now: () => '2026-07-17T10:00:00.000Z' });
    store.recordRecoveryAttempt({ attemptId: 'attempt-1', repo: event.repository, project: event.project, issueNumber: 698, startedAt: '2026-07-17T09:00:00.000Z', outcome: event.reason, recoveryEligible: true, recoveryAttemptCount: 1, retryAt: '2026-07-17T11:00:00.000Z', attentionStatus: 'attention_required', attentionDedupeKey: event.dedupeKey, processId: 321, processBootId: 'boot-a', processStartTicks: '456', systemdInvocationId: 'invocation-a' });
    assert.deepEqual(store.upsertAttentionEvent(event), { created: true, materiallyChanged: true });
    assert.deepEqual(store.upsertAttentionEvent(event), { created: false, materiallyChanged: false });
    assert.equal(store.claimRecovery('attempt-1', 1, '2026-07-17T11:00:00.000Z', { processId: 654, processBootId: 'boot-b', processStartTicks: '789', systemdInvocationId: 'invocation-b' }), true);
    assert.equal(store.claimRecovery('attempt-1', 1, '2026-07-17T11:00:00.000Z'), false);
    store.close();
    store = openRunnerStateStore(dbPath);
    assert.equal(store.allRows('recovery_attempts')[0].recovery_attempt_count, 2);
    assert.equal(store.allRows('recovery_attempts')[0].retry_at, '2026-07-17T11:00:00.000Z');
    assert.equal(store.allRows('recovery_attempts')[0].process_id, 654);
    assert.equal(store.allRows('recovery_attempts')[0].process_boot_id, 'boot-b');
    assert.equal(store.allRows('recovery_attempts')[0].process_start_ticks, '789');
    assert.equal(store.allRows('attention_events').length, 1);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unchanged attention preserves its stable timestamp and performs no material update', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-attention-stable-'));
  const dbPath = join(dir, 'state.sqlite');
  let tick = 0;
  const times = ['2026-07-17T10:00:00.000Z', '2026-07-17T10:01:00.000Z', '2026-07-17T10:02:00.000Z'];
  const event = buildAttentionEvent({ repository: 'TheTekTeam/modelspend', project: 'modelspend', issueNumber: 698, attemptId: 'stable', reason: 'unknown_failure', startedAt: '2026-07-17T09:00:00.000Z', finishedAt: '2026-07-17T09:30:00.000Z', recoveryStatus: 'forbidden', nextAction: 'Manager review.' });
  const store = openRunnerStateStore(dbPath, { now: () => times[Math.min(tick++, times.length - 1)] });
  try {
    assert.deepEqual(store.upsertAttentionEvent(event), { created: true, materiallyChanged: true });
    const first = store.allRows('attention_events')[0];
    assert.deepEqual(store.upsertAttentionEvent(event), { created: false, materiallyChanged: false });
    const second = store.allRows('attention_events')[0];
    assert.equal(second.updated_at, first.updated_at);
    assert.equal(second.event_json, first.event_json);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stall counters advance only for an unchanged persisted progress revision', () => withStore((store) => {
  store.recordRecoveryAttempt({
    attemptId: 'progress', repo: 'TheTekTeam/modelspend', issueNumber: 698,
    startedAt: '2026-07-17T09:00:00.000Z', resolutionState: 'active', processId: 10,
  });
  assert.equal(store.recordRecoveryProgress('progress', 'cpu:1', '2026-07-17T09:01:00.000Z'), true);
  assert.equal(store.markStalledPass('progress', 2, '2026-07-17T09:01:00.000Z').stalled_passes, 0);
  assert.equal(store.markStalledPass('progress', 2, '2026-07-17T09:02:00.000Z').stalled_passes, 1);
  const stalled = store.markStalledPass('progress', 2, '2026-07-17T09:03:00.000Z');
  assert.equal(stalled.stalled_passes, 2);
  assert.equal(stalled.attention_detected_at, '2026-07-17T09:03:00.000Z');
  assert.equal(store.recordRecoveryProgress('progress', 'cpu:2', '2026-07-17T09:04:00.000Z'), true);
  const progressing = store.markStalledPass('progress', 2, '2026-07-17T09:04:00.000Z');
  assert.equal(progressing.stalled_passes, 0);
  assert.equal(progressing.attention_detected_at, null);
}));

test('recovery authority and append-only revalidations survive an atomic claim', () => withStore((store) => {
  store.recordRecoveryAttempt({
    attemptId: 'authorized', repo: 'TheTekTeam/modelspend', issueNumber: 698, claimId: '41', preflightRevision: '40',
    startedAt: '2026-07-17T09:00:00.000Z', finishedAt: '2026-07-17T09:30:00.000Z',
    outcome: 'rate_limited', recoveryEligible: true, recoveryAction: 'fresh_retry', retryAt: '2026-07-17T10:00:00.000Z',
  });
  store.recordRecoveryRevalidation({ attemptId: 'authorized', stage: 'pre_claim', checkedAt: '2026-07-17T10:00:00.000Z', action: 'fresh_retry', allowed: true, authorizationId: '99', evidence: { issueOpen: true } });
  assert.equal(store.claimRecovery('authorized', 0, '2026-07-17T10:00:00.000Z', {
    processId: 50, processBootId: 'boot', processStartTicks: '100', systemdInvocationId: 'invocation',
  }, { expectedAction: 'fresh_retry', expectedClaimId: '41', expectedPreflightRevision: '40', authorizationId: '99', recoveryLeaseId: 'lease' }), true);
  const row = store.recoveryAttempt('authorized');
  assert.equal(row.claimed_recovery_action, 'fresh_retry');
  assert.equal(row.recovery_authorization_id, 'github-comment:database:99');
  assert.equal(row.recovery_lease_id, 'lease');
  assert.equal(store.allRows('recovery_revalidations').length, 1);
}));

test('restricted_handle_digest is write-once: set on first arrival, never overwritten or cleared by a later write (#698 finding 8)', () => withStore((store) => {
  store.recordRecoveryAttempt({
    attemptId: 'binding-write-once', repo: 'TheTekTeam/modelspend', issueNumber: 698, claimId: '41', preflightRevision: '40',
    startedAt: '2026-07-17T09:00:00.000Z', phase: 'starting', resolutionState: 'active',
  });
  // Insert time: unknown, matching the real flow (the digest is only known
  // once the child captures the restricted handle, after launch).
  assert.equal(store.recoveryAttempt('binding-write-once').restricted_handle_digest, null);

  store.recordRecoveryAttempt({
    attemptId: 'binding-write-once', repo: 'TheTekTeam/modelspend', issueNumber: 698,
    startedAt: '2026-07-17T09:00:00.000Z', finishedAt: '2026-07-17T09:30:00.000Z', outcome: 'completed',
    resolutionState: 'resolved', restrictedHandleDigest: 'digest-one',
  });
  assert.equal(store.recoveryAttempt('binding-write-once').restricted_handle_digest, 'digest-one');

  // A later write — even one that tries to overwrite or null it out — must
  // never change it once set; the generic payload_json blob is replaced on
  // every write, but this dedicated column is not (#698 finding 8).
  store.recordRecoveryAttempt({
    attemptId: 'binding-write-once', repo: 'TheTekTeam/modelspend', issueNumber: 698,
    startedAt: '2026-07-17T09:00:00.000Z', finishedAt: '2026-07-17T09:31:00.000Z', outcome: 'completed',
    resolutionState: 'resolved', restrictedHandleDigest: 'digest-two-should-be-ignored',
  });
  assert.equal(store.recoveryAttempt('binding-write-once').restricted_handle_digest, 'digest-one');

  store.recordRecoveryAttempt({
    attemptId: 'binding-write-once', repo: 'TheTekTeam/modelspend', issueNumber: 698,
    startedAt: '2026-07-17T09:00:00.000Z', finishedAt: '2026-07-17T09:32:00.000Z', outcome: 'completed', resolutionState: 'resolved',
  });
  assert.equal(store.recoveryAttempt('binding-write-once').restricted_handle_digest, 'digest-one');
}));

test('completeRecoveryTransitionAtomic records exactly one recovery-succeeded event and is idempotent (#698 finding 4)', () => withStore((store) => {
  store.recordRecoveryAttempt({
    attemptId: 'atomic-complete', repo: 'TheTekTeam/modelspend', issueNumber: 698, claimId: '41', preflightRevision: '40',
    startedAt: '2026-07-17T09:00:00.000Z', finishedAt: '2026-07-17T09:30:00.000Z',
    outcome: 'completed', recoveryEligible: false, recoveryAction: 'attention_required', resolutionState: 'attention_resolution_pending',
  });
  const event = buildAttentionEvent({ repository: 'TheTekTeam/modelspend', issueNumber: 698, attemptId: 'atomic-complete', reason: 'unknown_failure', recoveryStatus: 'transition_uncertain', nextAction: 'x' });
  store.upsertAttentionEvent(event);

  const first = store.completeRecoveryTransitionAtomic({
    attemptId: 'atomic-complete', repo: 'TheTekTeam/modelspend', issueNumber: 698, statusLabel: 'status:in-progress', reason: 'completed', payload: { attemptId: 'atomic-complete' },
  });
  assert.deepEqual(first, { completed: true, alreadyResolved: false });
  assert.equal(store.recoveryAttempt('atomic-complete').resolution_state, 'resolved');
  assert.equal(store.allRows('attention_events')[0].resolved_at !== null, true);
  const succeeded = store.allRows('queue_events').filter((row) => row.event_type === 'recovery-succeeded');
  assert.equal(succeeded.length, 1);

  // A repeated call over an already-resolved row must be a durable no-op:
  // no second queue event, no error.
  const second = store.completeRecoveryTransitionAtomic({
    attemptId: 'atomic-complete', repo: 'TheTekTeam/modelspend', issueNumber: 698, statusLabel: 'status:in-progress', reason: 'completed', payload: { attemptId: 'atomic-complete' },
  });
  assert.deepEqual(second, { completed: true, alreadyResolved: true });
  assert.equal(store.allRows('queue_events').filter((row) => row.event_type === 'recovery-succeeded').length, 1);
}));

test('completeRecoveryTransitionAtomic fails closed for an attempt that was never marked attention_resolution_pending', () => withStore((store) => {
  store.recordRecoveryAttempt({
    attemptId: 'never-pending', repo: 'TheTekTeam/modelspend', issueNumber: 698, startedAt: '2026-07-17T09:00:00.000Z',
    finishedAt: '2026-07-17T09:30:00.000Z', outcome: 'completed', resolutionState: 'transition_pending',
  });
  const result = store.completeRecoveryTransitionAtomic({ attemptId: 'never-pending', repo: 'TheTekTeam/modelspend', issueNumber: 698, statusLabel: 'status:in-progress' });
  assert.equal(result.completed, false);
  assert.equal(store.recoveryAttempt('never-pending').resolution_state, 'transition_pending');
  assert.equal(store.allRows('queue_events').filter((row) => row.event_type === 'recovery-succeeded').length, 0);
}));

test('openHealthCondition opens once, refreshes reason/updated_at without resetting opened_at on repeat occurrences, and resolveHealthCondition/reopen work as a durable current-state cycle (#698 round 5, finding 3)', () => withStore((store) => {
  const repo = 'TheTekTeam/modelspend';

  store.openHealthCondition({ repo, conditionType: 'systemic_pause', reason: 'runner_state_unavailable', safeNextAction: 'fix it', payload: { stage: 'startup' }, at: '2026-07-18T10:00:00Z' });
  const opened = store.currentHealthConditions(repo);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].condition_type, 'systemic_pause');
  assert.equal(opened[0].resolved_at, null);
  assert.equal(opened[0].opened_at, '2026-07-18T10:00:00Z');

  // A repeat occurrence while still open must refresh reason/updated_at but
  // never reset opened_at — an operator must see how long the condition has
  // actually been open, not just the latest tick (#698 round 5, finding 3's
  // "repeat/dedup" boundary).
  store.openHealthCondition({ repo, conditionType: 'systemic_pause', reason: 'still-bad', at: '2026-07-18T10:05:00Z' });
  const stillOpen = store.currentHealthConditions(repo)[0];
  assert.equal(stillOpen.opened_at, '2026-07-18T10:00:00Z', 'a repeat occurrence must not reset opened_at');
  assert.equal(stillOpen.updated_at, '2026-07-18T10:05:00Z');
  assert.equal(stillOpen.reason, 'still-bad');

  // Resolve: must disappear from currentHealthConditions immediately, not
  // linger because of a bounded history window.
  const resolved = store.resolveHealthCondition({ repo, conditionType: 'systemic_pause', at: '2026-07-18T10:10:00Z' });
  assert.equal(resolved, true);
  assert.equal(store.currentHealthConditions(repo).length, 0, 'a resolved condition must not remain displayed as current');
  // A second resolve on an already-resolved (or never-opened) condition is
  // a documented no-op, not an error.
  assert.equal(store.resolveHealthCondition({ repo, conditionType: 'systemic_pause', at: '2026-07-18T10:11:00Z' }), false);
  assert.equal(store.resolveHealthCondition({ repo, conditionType: 'queue_inspection_degraded', at: '2026-07-18T10:11:00Z' }), false);

  // Reopen: a fresh occurrence after resolution is a genuinely NEW open --
  // opened_at must reset, resolved_at must clear again.
  store.openHealthCondition({ repo, conditionType: 'systemic_pause', reason: 'recurred', at: '2026-07-18T11:00:00Z' });
  const reopened = store.currentHealthConditions(repo)[0];
  assert.equal(reopened.resolved_at, null);
  assert.equal(reopened.opened_at, '2026-07-18T11:00:00Z', 'reopening after resolution must start a fresh opened_at');
  assert.equal(reopened.reason, 'recurred');
}));

test('currentHealthConditions scopes by repo and by condition_type independently, and repo=null returns all repos', () => withStore((store) => {
  store.openHealthCondition({ repo: 'repo-a', conditionType: 'systemic_pause', reason: 'a', at: '2026-07-18T10:00:00Z' });
  store.openHealthCondition({ repo: 'repo-a', conditionType: 'queue_inspection_degraded', reason: 'b', at: '2026-07-18T10:00:00Z' });
  store.openHealthCondition({ repo: 'repo-b', conditionType: 'systemic_pause', reason: 'c', at: '2026-07-18T10:00:00Z' });

  assert.equal(store.currentHealthConditions('repo-a').length, 2);
  assert.equal(store.currentHealthConditions('repo-b').length, 1);
  assert.equal(store.currentHealthConditions(null).length, 3, 'repo=null must return conditions across all repos, matching activeRecoveryAttempts()\'s convention');

  store.resolveHealthCondition({ repo: 'repo-a', conditionType: 'systemic_pause', at: '2026-07-18T10:05:00Z' });
  assert.equal(store.currentHealthConditions('repo-a').length, 1);
  assert.equal(store.currentHealthConditions('repo-a')[0].condition_type, 'queue_inspection_degraded');
  assert.equal(store.currentHealthConditions('repo-b').length, 1, 'resolving repo-a\'s condition must not affect repo-b\'s independent condition');
}));

test('opening a populated pre-v8 database migrates cleanly to v9: existing data survives, new columns and tables are added, nothing is lost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-migration-'));
  const dbPath = join(dir, 'state.sqlite');
  try {
    // Build a genuinely pre-v8-shaped database by hand: the exact
    // recovery_attempts column set schema v7 produced (no next_retry_at/
    // retry_attempt/retry_cap/retry_reason, no runner_health_conditions
    // table), with a populated row, before ever calling migrate().
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE runner_state_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO runner_state_schema (version, applied_at) VALUES (7, '2026-07-01T00:00:00Z');
      CREATE TABLE recovery_attempts (
        attempt_id TEXT PRIMARY KEY, repo TEXT NOT NULL, project TEXT, issue_number INTEGER NOT NULL,
        claim_id TEXT, preflight_revision TEXT, phase TEXT, agent TEXT, model TEXT, harness TEXT, started_at TEXT NOT NULL, finished_at TEXT,
        outcome TEXT, exit_code INTEGER, signal TEXT, recovery_eligible INTEGER NOT NULL DEFAULT 0,
        recovery_action TEXT, recovery_attempt_count INTEGER NOT NULL DEFAULT 0, retry_at TEXT,
        checkpoint_available INTEGER NOT NULL DEFAULT 0, session_available INTEGER NOT NULL DEFAULT 0,
        worktree_available INTEGER NOT NULL DEFAULT 0, branch_available INTEGER NOT NULL DEFAULT 0, pr_available INTEGER NOT NULL DEFAULT 0,
        attention_status TEXT, attention_dedupe_key TEXT, last_notification_at TEXT, resolution_state TEXT,
        process_id INTEGER, process_boot_id TEXT, process_start_ticks TEXT, systemd_invocation_id TEXT,
        stalled_passes INTEGER NOT NULL DEFAULT 0, attention_detected_at TEXT,
        progress_revision INTEGER NOT NULL DEFAULT 0, observed_progress_revision INTEGER NOT NULL DEFAULT 0,
        progress_token TEXT, last_progress_at TEXT, claimed_recovery_action TEXT,
        recovery_authorization_id TEXT, recovery_lease_id TEXT,
        transition_mutation_count INTEGER NOT NULL DEFAULT 0, restricted_handle_digest TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO recovery_attempts (attempt_id, repo, project, issue_number, claim_id, preflight_revision, agent, model, harness,
        started_at, finished_at, outcome, recovery_eligible, recovery_action, recovery_attempt_count, retry_at,
        attention_status, resolution_state, transition_mutation_count, restricted_handle_digest, payload_json)
      VALUES ('pre-v8-attempt', 'TheTekTeam/modelspend', 'modelspend', 698, '41', '41', 'claude-code-cli', 'claude-sonnet-4-5', 'claude',
        '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z', 'rate_limited', 1, 'fresh_retry', 2, '2026-06-01T02:00:00Z',
        'none', 'unresolved', 0, 'preexisting-digest-value', '{"preexisting":"payload"}');
    `);
    raw.close();

    // Opening through the real store now runs the real migrate() path.
    const store = openRunnerStateStore(dbPath);
    const row = store.recoveryAttempt('pre-v8-attempt');

    // Every pre-existing value must survive byte-for-byte.
    assert.equal(row.repo, 'TheTekTeam/modelspend');
    assert.equal(row.outcome, 'rate_limited');
    assert.equal(row.recovery_eligible, 1);
    assert.equal(row.recovery_attempt_count, 2);
    assert.equal(row.retry_at, '2026-06-01T02:00:00Z');
    assert.equal(row.restricted_handle_digest, 'preexisting-digest-value');
    assert.equal(row.payload_json, '{"preexisting":"payload"}');

    // The v8/v9 columns must exist and default sanely for a pre-existing
    // row (never populated by the old writer) rather than erroring.
    assert.equal(row.next_retry_at, null);
    assert.equal(row.retry_attempt, 0);
    assert.equal(row.retry_cap, null);
    assert.equal(row.retry_reason, null);
    assert.equal(row.claim_identity_json, null);
    assert.equal(row.preflight_identity_json, null);
    assert.equal(row.recovery_authorization_identity_json, null);

    // The new table must exist and be immediately usable.
    store.openHealthCondition({ repo: 'TheTekTeam/modelspend', conditionType: 'systemic_pause', reason: 'post-migration-smoke-test' });
    assert.equal(store.currentHealthConditions('TheTekTeam/modelspend').length, 1);

    // The schema marker must reflect the new version.
    const schemaRows = store.allRows('runner_state_schema');
    assert.equal(Math.max(...schemaRows.map((r) => r.version)), RUNNER_STATE_SCHEMA_VERSION);
    assert.equal(schemaRows.some((r) => r.version === 7), true, 'the historical v7 marker row must not be deleted, only superseded');

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('false dry-run attention repair defaults to report-only and performs no mutation (#725)', () => withStore((store) => {
  const fixture = seedFalseDryRunDefect(store);
  const before = Object.fromEntries(['run_results', 'recovery_attempts', 'attention_events'].map((table) => [table, store.countRows(table)]));
  const report = store.repairFalseDryRunAttention();
  assert.equal(report.mode, 'report-only');
  assert.equal(report.candidatesFound, 1);
  assert.equal(report.candidatesEligible, 1, JSON.stringify(report));
  assert.equal(report.candidatesRepaired, 0);
  assert.deepEqual(report.wouldRepair.attemptIds, [fixture.attemptId]);
  assert.deepEqual(Object.fromEntries(['run_results', 'recovery_attempts', 'attention_events'].map((table) => [table, store.countRows(table)])), before);
  assert.equal(store.allRows('run_results')[0].mode, 'issue-run');
}));

test('false dry-run attention repair transaction removes only proven false rows and reclassifies the audit result (#725)', () => withStore((store) => {
  const fixture = seedFalseDryRunDefect(store);
  assert.equal(store.allRows('run_results')[0].exit_code, 1, 'fixture matches the preserved scheduler-level false failure');
  const report = store.repairFalseDryRunAttention({ execute: true, repairedAt: '2026-07-19T10:05:00.000Z' });
  assert.equal(report.candidatesRepaired, 1);
  assert.deepEqual(report.affected.runResultIds, [fixture.runResultId]);
  assert.deepEqual(report.affected.attemptIds, [fixture.attemptId]);
  assert.deepEqual(report.affected.attentionEventIds, [fixture.attentionEventId]);
  assert.equal(store.countRows('recovery_attempts'), 0);
  assert.equal(store.countRows('attention_events'), 0);
  assert.equal(store.countRows('issue_selections'), 1, 'selection audit is retained');
  const result = store.allRows('run_results')[0];
  assert.equal(result.mode, 'scheduler-dry-run');
  assert.equal(result.exit_code, 0, 'the repaired scheduler inspection is a successful non-execution');
  const payload = JSON.parse(result.payload_json);
  assert.equal(payload.executionStatus, 'not_executed');
  assert.equal('terminalOutcome' in payload, false);
  assert.equal(payload.historicalRepair.removedAttemptId, fixture.attemptId);
}));

test('false dry-run attention repair also accepts the earlier outer-exit-zero encoding (#725)', () => withStore((store) => {
  seedFalseDryRunDefect(store, { schedulerExitCode: 0 });
  const report = store.repairFalseDryRunAttention({ execute: true });
  assert.equal(report.candidatesRepaired, 1);
  assert.equal(store.allRows('run_results')[0].mode, 'scheduler-dry-run');
  assert.equal(store.allRows('run_results')[0].exit_code, 0);
}));

test('false dry-run attention repair preserves a genuine execute-mode failure (#725)', () => withStore((store) => {
  const fixture = seedFalseDryRunDefect(store, { dryRun: false });
  const report = store.repairFalseDryRunAttention({ execute: true });
  assert.equal(report.candidatesFound, 0);
  assert.equal(report.candidatesRepaired, 0);
  assert.equal(store.recoveryAttempt(fixture.attemptId).outcome, 'unknown_failure');
  assert.equal(store.countRows('attention_events'), 1);
  assert.equal(store.allRows('run_results')[0].mode, 'issue-run');
}));

test('false dry-run attention repair preserves ambiguous attempt identity (#725)', () => withStore((store) => {
  const fixture = seedFalseDryRunDefect(store);
  store.db.prepare('UPDATE recovery_attempts SET started_at = ? WHERE attempt_id = ?').run('2026-07-19T08:59:59.000Z', fixture.attemptId);
  const report = store.repairFalseDryRunAttention({ execute: true });
  assert.equal(report.candidatesFound, 1);
  assert.equal(report.candidatesEligible, 0);
  assert.equal(report.candidatesSkippedAmbiguous, 1);
  assert.equal(store.countRows('recovery_attempts'), 1);
  assert.equal(store.countRows('attention_events'), 1);
  assert.equal(store.allRows('run_results')[0].mode, 'issue-run');
}));

test('false dry-run attention repair preserves mismatched issue, attempt and dedupe evidence (#725)', () => {
  for (const mismatch of ['issue', 'attempt', 'dedupe']) {
    withStore((store) => {
      const fixture = seedFalseDryRunDefect(store);
      if (mismatch === 'issue') store.db.prepare('UPDATE recovery_attempts SET issue_number = issue_number + 1 WHERE attempt_id = ?').run(fixture.attemptId);
      if (mismatch === 'attempt') store.db.prepare('UPDATE attention_events SET attempt_id = ? WHERE id = ?').run('different-attempt', fixture.attentionEventId);
      if (mismatch === 'dedupe') store.db.prepare('UPDATE recovery_attempts SET attention_dedupe_key = ? WHERE attempt_id = ?').run('different-dedupe', fixture.attemptId);
      const report = store.repairFalseDryRunAttention({ execute: true });
      assert.equal(report.candidatesEligible, 0, mismatch);
      assert.equal(report.candidatesSkippedAmbiguous, 1, mismatch);
      assert.equal(store.countRows('recovery_attempts'), 1, mismatch);
      assert.equal(store.countRows('attention_events'), 1, mismatch);
    });
  }
});

test('false dry-run attention repair fails closed while repository health is unresolved (#725)', () => withStore((store) => {
  const fixture = seedFalseDryRunDefect(store);
  store.openHealthCondition({
    repo: fixture.repo,
    conditionType: 'systemic_pause',
    reason: 'runner_state_unavailable',
    safeNextAction: 'Repair runner state independently.',
  });

  const blocked = store.repairFalseDryRunAttention({ execute: true });
  assert.equal(blocked.candidatesFound, 1);
  assert.equal(blocked.candidatesEligible, 0);
  assert.equal(blocked.candidatesSkippedAmbiguous, 1);
  assert.deepEqual(blocked.skipped, [{ runResultId: fixture.runResultId, reason: 'unresolved-runner-health-condition' }]);
  assert.equal(store.countRows('recovery_attempts'), 1);
  assert.equal(store.countRows('attention_events'), 1);
  assert.equal(store.currentHealthConditions(fixture.repo).length, 1);

  store.resolveHealthCondition({ repo: fixture.repo, conditionType: 'systemic_pause' });
  const unblocked = store.repairFalseDryRunAttention({ execute: true });
  assert.equal(unblocked.candidatesRepaired, 1);
  assert.equal(store.countRows('recovery_attempts'), 0);
  assert.equal(store.countRows('attention_events'), 0);
  assert.equal(store.currentHealthConditions(fixture.repo).length, 0);
}));

test('false dry-run attention repair rolls back completely on transaction failure (#725)', () => withStore((store) => {
  const fixture = seedFalseDryRunDefect(store);
  store.db.exec(`CREATE TRIGGER fail_false_dry_run_attempt_delete BEFORE DELETE ON recovery_attempts
    BEGIN SELECT RAISE(ABORT, 'injected repair failure'); END;`);
  assert.throws(() => store.repairFalseDryRunAttention({ execute: true }), /injected repair failure/);
  assert.equal(store.recoveryAttempt(fixture.attemptId).outcome, 'unknown_failure');
  assert.equal(store.countRows('attention_events'), 1, 'attention delete was rolled back');
  assert.equal(store.allRows('run_results')[0].mode, 'issue-run');
}));

test('false dry-run attention repair is idempotent (#725)', () => withStore((store) => {
  seedFalseDryRunDefect(store);
  const first = store.repairFalseDryRunAttention({ execute: true });
  const second = store.repairFalseDryRunAttention({ execute: true });
  assert.equal(first.candidatesRepaired, 1);
  assert.equal(second.candidatesFound, 0);
  assert.equal(second.candidatesRepaired, 0);
  assert.equal(store.countRows('recovery_attempts'), 0);
  assert.equal(store.countRows('attention_events'), 0);
  assert.equal(store.countRows('run_results'), 1);
}));

// -- Issue #50: routing_events durable, deduplicated evidence --

test('recordRoutingEvent inserts a new row and reports inserted true on the first write for a dedupe key', () => withStore((store) => {
  const result = store.recordRoutingEvent({
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 50,
    eventType: 'no-qualified-agent',
    reason: 'no-qualified-agent',
    settingsRevision: 'sha256:aaa',
    dedupeKey: 'agent-runner/50:no-qualified-agent:sha256:aaa',
    payload: { note: 'bounded evidence only' },
  });
  assert.equal(result.inserted, true);
  assert.equal(store.countRows('routing_events'), 1);
}));

test('recordRoutingEvent is idempotent on a repeated dedupe key -- repeated reconciliation never duplicates events', () => withStore((store) => {
  const args = {
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 50,
    eventType: 'no-qualified-agent',
    reason: 'no-qualified-agent',
    dedupeKey: 'agent-runner/50:no-qualified-agent:sha256:aaa',
  };
  const first = store.recordRoutingEvent(args);
  const second = store.recordRoutingEvent(args);
  const third = store.recordRoutingEvent(args);
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(third.inserted, false);
  assert.equal(store.countRows('routing_events'), 1, 'exactly one durable row survives repeated reconciliation');
}));

test('recordRoutingEvent records a reassignment event with from/to agent ids', () => withStore((store) => {
  const result = store.recordRoutingEvent({
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 51,
    eventType: 'reassignment-applied',
    fromAgentId: 'claude-code-cli',
    toAgentId: 'ollama-agent',
    reason: 'agent-disabled',
    settingsRevision: 'sha256:bbb',
    dedupeKey: 'agent-runner/51:reassignment-applied:sha256:bbb',
  });
  assert.equal(result.inserted, true);
  const row = store.allRows('routing_events')[0];
  assert.equal(row.from_agent_id, 'claude-code-cli');
  assert.equal(row.to_agent_id, 'ollama-agent');
  assert.equal(row.event_type, 'reassignment-applied');
}));

test('recordRoutingEvent requires a dedupeKey', () => withStore((store) => {
  assert.throws(() => store.recordRoutingEvent({ repo: 'TheTekTeam/agent-runner', eventType: 'no-qualified-agent' }), /dedupeKey/);
}));

test('hasRoutingEvent reflects whether a dedupe key has already been recorded', () => withStore((store) => {
  const dedupeKey = 'agent-runner/52:no-qualified-agent:sha256:ccc';
  assert.equal(store.hasRoutingEvent({ dedupeKey }), false);
  store.recordRoutingEvent({ repo: 'TheTekTeam/agent-runner', issueNumber: 52, eventType: 'no-qualified-agent', dedupeKey });
  assert.equal(store.hasRoutingEvent({ dedupeKey }), true);
}));

test('a routing_events row (full serialized shape, including payload_json) never contains raw settings, secretref, credential, executable path, endpoint, or prompt text', () => withStore((store) => {
  store.recordRoutingEvent({
    repo: 'TheTekTeam/agent-runner',
    issueNumber: 53,
    eventType: 'reassignment-applied',
    fromAgentId: 'claude-code-cli',
    toAgentId: 'ollama-agent',
    reason: 'agent-disabled',
    settingsRevision: 'sha256:ddd',
    dedupeKey: 'agent-runner/53:reassignment-applied:sha256:ddd',
    // A bounded payload only -- the exact shape claude-runner-cron.mjs
    // actually passes (verification/eligibility reasons), never a raw
    // settings entry.
    payload: { verification: { ok: true, liveLabels: ['status:ready', 'agent:ollama'] } },
  });
  const row = store.allRows('routing_events')[0];
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /executablePath|sessionSecretRef|vault:\/\/|http:\/\/|https:\/\/|Bearer\s/);
}));

test('latestQuotaHistoryForRepo is repository-scoped, unlike the generic global-latest-N latestRows() view (#53 round 2, item 3)', () => withStore((store) => {
  store.recordQuotaHistory({ repo: 'TheTekTeam/modelspend', quotaPreflight: { blocked: true, status: 'exhausted' }, createdAt: '2026-07-24T09:00:00.000Z' });
  store.recordQuotaHistory({ repo: 'TheTekTeam/agent-runner', quotaPreflight: { blocked: false, status: 'available' }, createdAt: '2026-07-24T09:30:00.000Z' });
  assert.equal(store.latestQuotaHistoryForRepo('TheTekTeam/modelspend').blocked, 1);
  assert.equal(store.latestQuotaHistoryForRepo('TheTekTeam/agent-runner').blocked, 0);
  assert.equal(store.latestQuotaHistoryForRepo('TheTekTeam/nonexistent'), null);
  // The generic global view would instead return whichever repo polled most recently, regardless of which repo is asked about.
  assert.equal(store.latestRows('quota_history', 1)[0].repo, 'TheTekTeam/agent-runner');
}));

test('recordNotificationEvent requires a dedupeKey', () => withStore((store) => {
  assert.throws(() => store.recordNotificationEvent({ repo: 'TheTekTeam/agent-runner', eventType: 'completed', reasonCode: 'run-completed', sourceTable: 'recovery_attempts', sourceRef: 'x', occurredAt: '2026-07-24T10:00:00.000Z' }), /dedupeKey/);
}));

test('recordNotificationEvent is idempotent on a repeated dedupeKey (#53)', () => withStore((store) => {
  const params = {
    repo: 'TheTekTeam/agent-runner', issueNumber: 53, eventType: 'completed', reasonCode: 'run-completed',
    sourceTable: 'recovery_attempts', sourceRef: 'agent-runner#53:2026-07-24T10:00:00.000Z',
    occurredAt: '2026-07-24T10:00:00.000Z', dedupeKey: 'completed:agent-runner#53:2026-07-24T10:00:00.000Z',
    content: { eventType: 'completed', reasonCode: 'run-completed', repo: 'TheTekTeam/agent-runner', issueNumber: 53, agent: null, occurredAt: '2026-07-24T10:00:00.000Z' },
  };
  const first = store.recordNotificationEvent(params);
  assert.equal(first.inserted, true);
  const second = store.recordNotificationEvent(params);
  assert.equal(second.inserted, false);
  assert.equal(second.existing.dedupe_key, params.dedupeKey);
  assert.equal(store.allRows('notification_events').length, 1);
}));

test('notification_events delivery state machine: pending -> in-flight -> retryable-failed -> in-flight -> exhausted, and in-flight -> delivered -> resolved (#53 round 2)', () => withStore((store) => {
  const dedupeKey = 'attention:dedupe-1';
  store.recordNotificationEvent({
    repo: 'TheTekTeam/agent-runner', issueNumber: 60, eventType: 'failed_attention', reasonCode: 'attention-required',
    sourceTable: 'attention_events', sourceRef: dedupeKey, occurredAt: '2026-07-24T10:00:00.000Z', dedupeKey,
    content: { eventType: 'failed_attention' }, maxAttempts: 2,
  });
  let [row] = store.allRows('notification_events');
  assert.equal(row.delivery_status, 'pending');

  assert.equal(store.dueNotificationEvents('TheTekTeam/agent-runner').length, 1);
  // markNotificationDeliveryFailed only transitions from 'in-flight' -- an
  // unclaimed row must fail closed.
  assert.deepEqual(store.markNotificationDeliveryFailed({ dedupeKey, attemptedAt: '2026-07-24T10:00:30.000Z' }), { updated: false, exhausted: false });

  assert.equal(store.claimNotificationForDelivery({ dedupeKey, owner: 'pass-1', at: '2026-07-24T10:00:30.000Z' }).claimed, true);
  row = store.allRows('notification_events')[0];
  assert.equal(row.delivery_status, 'in-flight');
  assert.equal(row.in_flight_owner, 'pass-1');
  // A claimed row is not "due" again until it leaves in-flight.
  assert.equal(store.dueNotificationEvents('TheTekTeam/agent-runner').length, 0);
  // A second concurrent claim attempt on an already-claimed row must fail.
  assert.equal(store.claimNotificationForDelivery({ dedupeKey, owner: 'pass-2', at: '2026-07-24T10:00:31.000Z' }).claimed, false);

  let failure = store.markNotificationDeliveryFailed({ dedupeKey, attemptedAt: '2026-07-24T10:01:00.000Z', errorCode: 'synthetic-failure-injected', nextAttemptAt: '2026-07-24T10:02:00.000Z' });
  assert.equal(failure.updated, true);
  assert.equal(failure.exhausted, false);
  row = store.allRows('notification_events')[0];
  assert.equal(row.delivery_status, 'retryable-failed');
  assert.equal(row.attempt_count, 1);
  assert.equal(row.in_flight_owner, null);

  assert.equal(store.claimNotificationForDelivery({ dedupeKey, owner: 'pass-3', at: '2026-07-24T10:03:00.000Z' }).claimed, true);
  failure = store.markNotificationDeliveryFailed({ dedupeKey, attemptedAt: '2026-07-24T10:03:00.000Z', errorCode: 'synthetic-failure-injected' });
  assert.equal(failure.exhausted, true);
  row = store.allRows('notification_events')[0];
  assert.equal(row.delivery_status, 'exhausted');
  assert.equal(store.dueNotificationEvents('TheTekTeam/agent-runner').length, 0, 'an exhausted row must never be due again');

  const otherKey = 'attention:dedupe-2';
  store.recordNotificationEvent({
    repo: 'TheTekTeam/agent-runner', issueNumber: 61, eventType: 'failed_attention', reasonCode: 'attention-required',
    sourceTable: 'attention_events', sourceRef: otherKey, occurredAt: '2026-07-24T10:00:00.000Z', dedupeKey: otherKey,
    content: { eventType: 'failed_attention' },
  });
  // markNotificationDelivered only transitions from 'in-flight' too.
  assert.equal(store.markNotificationDelivered({ dedupeKey: otherKey, deliveredAt: '2026-07-24T10:05:00.000Z' }), false);
  assert.equal(store.claimNotificationForDelivery({ dedupeKey: otherKey, owner: 'pass-4', at: '2026-07-24T10:04:59.000Z' }).claimed, true);
  assert.equal(store.markNotificationDelivered({ dedupeKey: otherKey, deliveredAt: '2026-07-24T10:05:00.000Z' }), true);
  let otherRow = store.allRows('notification_events').find((r) => r.dedupe_key === otherKey);
  assert.equal(otherRow.delivery_status, 'delivered');
  assert.equal(otherRow.resolved_at, null);
  assert.equal(otherRow.in_flight_owner, null);
  assert.equal(store.deliveredUnresolvedNotificationEvents('TheTekTeam/agent-runner').length, 1);

  assert.equal(store.resolveNotificationEvent({ dedupeKey: otherKey, resolvedAt: '2026-07-24T10:10:00.000Z' }), true);
  otherRow = store.allRows('notification_events').find((r) => r.dedupe_key === otherKey);
  assert.equal(otherRow.delivery_status, 'resolved');
  assert.equal(otherRow.resolved_at, '2026-07-24T10:10:00.000Z');
  assert.equal(store.deliveredUnresolvedNotificationEvents('TheTekTeam/agent-runner').length, 0);
}));

test('markNotificationDelivered can resolve a one-shot notification in the same write, once claimed', () => withStore((store) => {
  const dedupeKey = 'completed:agent-runner#70:2026-07-24T10:00:00.000Z';
  store.recordNotificationEvent({
    repo: 'TheTekTeam/agent-runner', issueNumber: 70, eventType: 'completed', reasonCode: 'run-completed',
    sourceTable: 'recovery_attempts', sourceRef: 'agent-runner#70:2026-07-24T10:00:00.000Z', occurredAt: '2026-07-24T10:00:00.000Z',
    dedupeKey, content: { eventType: 'completed' },
  });
  store.claimNotificationForDelivery({ dedupeKey, owner: 'pass-1', at: '2026-07-24T10:04:59.000Z' });
  assert.equal(store.markNotificationDelivered({ dedupeKey, deliveredAt: '2026-07-24T10:05:00.000Z', resolveNow: true }), true);
  const [row] = store.allRows('notification_events');
  assert.equal(row.delivery_status, 'resolved');
  assert.equal(row.resolved_at, '2026-07-24T10:05:00.000Z');
  assert.equal(row.delivered_at, '2026-07-24T10:05:00.000Z');
}));

test('a disabled/paused transport reverts an in-flight row to pending without consuming an attempt (#53 round 2, item 1)', () => withStore((store) => {
  const dedupeKey = 'quota:TheTekTeam/agent-runner:2026-07-24T10:00:00.000Z';
  store.recordNotificationEvent({
    repo: 'TheTekTeam/agent-runner', eventType: 'quota_blocked', reasonCode: 'quota-or-paid-use-blocked',
    sourceTable: 'quota_history', sourceRef: '2026-07-24T10:00:00.000Z', occurredAt: '2026-07-24T10:00:00.000Z', dedupeKey,
    content: { eventType: 'quota_blocked' },
  });
  store.claimNotificationForDelivery({ dedupeKey, owner: 'pass-1', at: '2026-07-24T10:01:00.000Z' });
  assert.equal(store.revertNotificationInFlightToPending({ dedupeKey, at: '2026-07-24T10:01:01.000Z' }), true);
  const [row] = store.allRows('notification_events');
  assert.equal(row.delivery_status, 'pending');
  assert.equal(row.attempt_count, 0);
  assert.equal(row.last_error, null);
  assert.equal(row.next_attempt_at, null);
  assert.equal(row.in_flight_owner, null);
  assert.equal(store.dueNotificationEvents('TheTekTeam/agent-runner').length, 1, 'the row must remain deliverable indefinitely while paused');
}));

test('a non-retryable delivery failure moves an in-flight row directly to exhausted in one call, regardless of max_attempts headroom (#53 round 2, item 1)', () => withStore((store) => {
  const dedupeKey = 'routing:no-qualified-agent-dedupe';
  store.recordNotificationEvent({
    repo: 'TheTekTeam/agent-runner', issueNumber: 90, eventType: 'no_qualified_agent', reasonCode: 'no-qualified-agent',
    sourceTable: 'routing_events', sourceRef: dedupeKey, occurredAt: '2026-07-24T10:00:00.000Z', dedupeKey,
    content: { eventType: 'no_qualified_agent' }, maxAttempts: 10,
  });
  store.claimNotificationForDelivery({ dedupeKey, owner: 'pass-1', at: '2026-07-24T10:00:00.000Z' });
  const failure = store.markNotificationDeliveryFailed({ dedupeKey, attemptedAt: '2026-07-24T10:00:01.000Z', errorCode: 'transport-rejected-permanent', retryable: false });
  assert.equal(failure.exhausted, true);
  const [row] = store.allRows('notification_events');
  assert.equal(row.delivery_status, 'exhausted');
  assert.equal(row.attempt_count, 1, 'exactly one attempt was consumed, not the full max_attempts budget');
}));

test('reconcileStaleInFlightNotifications recovers a crash-abandoned in-flight row onto the same dedupe_key (#53 round 2, item 2)', () => withStore((store) => {
  const dedupeKey = 'attention:stale-dedupe';
  store.recordNotificationEvent({
    repo: 'TheTekTeam/agent-runner', issueNumber: 91, eventType: 'failed_attention', reasonCode: 'attention-required',
    sourceTable: 'attention_events', sourceRef: dedupeKey, occurredAt: '2026-07-24T10:00:00.000Z', dedupeKey,
    content: { eventType: 'failed_attention' },
  });
  store.claimNotificationForDelivery({ dedupeKey, owner: 'crashed-pass', at: '2026-07-24T10:00:00.000Z' });

  // Not yet stale: the claim is recent relative to the staleness boundary.
  let result = store.reconcileStaleInFlightNotifications({ repo: 'TheTekTeam/agent-runner', staleBeforeAt: '2026-07-24T09:59:00.000Z', at: '2026-07-24T10:05:00.000Z' });
  assert.deepEqual(result, { checked: 0, recovered: 0 });
  assert.equal(store.allRows('notification_events')[0].delivery_status, 'in-flight');

  // Stale: the claim predates the staleness boundary -- the previous process crashed mid-delivery.
  result = store.reconcileStaleInFlightNotifications({ repo: 'TheTekTeam/agent-runner', staleBeforeAt: '2026-07-24T10:00:30.000Z', at: '2026-07-24T10:05:00.000Z' });
  assert.deepEqual(result, { checked: 1, recovered: 1 });
  const [row] = store.allRows('notification_events');
  assert.equal(row.delivery_status, 'retryable-failed');
  assert.equal(row.dedupe_key, dedupeKey, 'reconciliation reuses the exact same notification identity, never a new one');
  assert.equal(row.attempt_count, 1);
  assert.equal(row.in_flight_owner, null);
  assert.equal(store.dueNotificationEvents('TheTekTeam/agent-runner', '2026-07-24T10:05:00.000Z').length, 1);
}));

test('notification_source_cursors: activation skips existing history, and only new rows are returned past the cursor (#53 round 2, item 4)', () => withStore((store) => {
  const repo = 'TheTekTeam/agent-runner';
  store.upsertAttentionEvent({
    dedupeKey: 'attn-1', repository: repo, project: 'agent-runner', issueNumber: 100, attemptId: 'a1', reason: 'unknown_failure',
    agent: 'claude-code-cli', startedAt: '2026-07-24T09:00:00.000Z', finishedAt: '2026-07-24T09:01:00.000Z',
    recoveryStatus: 'forbidden', nextAction: 'x', policyRevision: 'v1',
  });
  assert.equal(store.getNotificationSourceCursor(repo, 'attention_events'), null);
  const historicalMax = store.maxRowId('attention_events', repo);
  assert.equal(historicalMax >= 1, true);
  const activated = store.activateNotificationSourceCursor(repo, 'attention_events', historicalMax, '2026-07-24T10:00:00.000Z');
  assert.equal(activated, String(historicalMax));
  assert.deepEqual(store.attentionEventsSince(repo, activated, 10), [], 'pre-activation history must not be returned as new');

  // Activating again must not reset an already-activated cursor.
  assert.equal(store.activateNotificationSourceCursor(repo, 'attention_events', '0', '2026-07-24T10:05:00.000Z'), String(historicalMax));

  store.upsertAttentionEvent({
    dedupeKey: 'attn-2', repository: repo, project: 'agent-runner', issueNumber: 101, attemptId: 'a2', reason: 'unknown_failure',
    agent: 'claude-code-cli', startedAt: '2026-07-24T10:00:00.000Z', finishedAt: '2026-07-24T10:01:00.000Z',
    recoveryStatus: 'forbidden', nextAction: 'x', policyRevision: 'v1',
  });
  const sinceRows = store.attentionEventsSince(repo, activated, 10);
  assert.equal(sinceRows.length, 1, 'only the row created after activation is returned');
  assert.equal(sinceRows[0].dedupe_key, 'attn-2');

  store.advanceNotificationSourceCursor(repo, 'attention_events', sinceRows[sinceRows.length - 1].id, '2026-07-24T10:06:00.000Z');
  assert.equal(store.getNotificationSourceCursor(repo, 'attention_events'), String(sinceRows[0].id));
  assert.deepEqual(store.attentionEventsSince(repo, store.getNotificationSourceCursor(repo, 'attention_events'), 10), []);
}));

test('a notification_events row (full serialized shape, including content_json) never contains raw prompts, provider output, credentials, paths or session handles', () => withStore((store) => {
  store.recordNotificationEvent({
    repo: 'TheTekTeam/agent-runner', issueNumber: 80, eventType: 'failed_attention', reasonCode: 'attention-required',
    sourceTable: 'attention_events', sourceRef: 'attention:dedupe-80', occurredAt: '2026-07-24T10:00:00.000Z',
    dedupeKey: 'attention:dedupe-80',
    content: { eventType: 'failed_attention', reasonCode: 'attention-required', repo: 'TheTekTeam/agent-runner', issueNumber: 80, agent: null, occurredAt: '2026-07-24T10:00:00.000Z' },
  });
  const row = store.allRows('notification_events')[0];
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /executablePath|sessionSecretRef|vault:\/\/|http:\/\/|https:\/\/|Bearer\s|\/home\/|Authorization:/);
}));
