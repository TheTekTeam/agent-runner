import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildAttentionEvent } from './claude-runner-recovery.mjs';
import { openRunnerStateStore, RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';
import { parseArgs, run } from './claude-runner-state-doctor.mjs';

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

function seedFalseDryRunCliFixture(dbPath) {
  const repo = 'TheTekTeam/modelspend';
  const issueNumber = 300;
  const startedAt = '2026-07-19T09:00:00.000Z';
  const finishedAt = '2026-07-19T09:00:01.000Z';
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
  const store = openRunnerStateStore(dbPath);
  try {
    store.recordIssueSelection({
      repo,
      issueNumber,
      statusLabel: 'status:ready',
      selectionMode: 'preflight-direct',
      sourcePreflightCommentId: '72501',
      dryRun: true,
      payload: { dryRun: true, selectedIssue: issueNumber, selectionMode: 'preflight-direct' },
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
      // Exact preserved #725 shape: the child/process payload exited 0,
      // while the enclosing scheduler persisted its false failure as 1.
      exitCode: 1,
      startedAt,
      finishedAt,
      createdAt: finishedAt,
      payload: {
        dryRun: true,
        selectedIssue: issueNumber,
        selectionMode: 'preflight-direct',
        sourcePreflightCommentId: 72501,
        claim: null,
        runnerArgs: ['scripts/ops/claude-runner.mjs', '--issue', String(issueNumber)],
        startedAt,
        finishedAt,
        exitCode: 0,
        signal: null,
        stdout: 'restricted-session-sentinel',
        stderr: '',
        childRunFailure: null,
        terminalOutcome: 'unknown_failure',
        recoveryDecision: {
          policyRevision: 'runner-recovery-v1',
          eligible: false,
          action: 'attention_required',
          status: 'forbidden',
          reason: 'unknown_failure',
        },
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
    return { attemptId, runResultId: store.allRows('run_results')[0].id, attentionEventId: store.allRows('attention_events')[0].id };
  } finally {
    store.close();
  }
}

test('parseArgs defaults to env state DB when provided', () => {
  const args = parseArgs([], { CLAUDE_RUNNER_STATE_DB: '/tmp/runner.sqlite' });
  assert.equal(args.dbPath, '/tmp/runner.sqlite');
  assert.equal(args.historyLimit, 5);
  assert.equal(args.strict, false);
});

test('state doctor repair is report-only by default and apply requires the explicit repair command', () => {
  const report = parseArgs(['--repair-dry-run-false-attention'], {});
  assert.equal(report.repairDryRunFalseAttention, true);
  assert.equal(report.apply, false);
  const apply = parseArgs(['--repair-dry-run-false-attention', '--apply'], {});
  assert.equal(apply.apply, true);
  assert.throws(() => parseArgs(['--apply'], {}), /requires --repair-dry-run-false-attention/);
});

test('state doctor prints missing DB diagnostic and exits zero unless strict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-state-doctor-missing-'));
  const dbPath = join(dir, 'missing.sqlite');
  try {
    const nonStrict = memoryIo();
    assert.equal(run(['--db', dbPath], {}, nonStrict.io), 0);
    const summary = JSON.parse(nonStrict.read().stdout);
    assert.equal(summary.status, 'missing');
    assert.equal(summary.ok, true);

    const strict = memoryIo();
    assert.equal(run(['--db', dbPath, '--strict'], {}, strict.io), 1);
    const strictSummary = JSON.parse(strict.read().stdout);
    assert.equal(strictSummary.status, 'missing');
    assert.equal(strictSummary.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state doctor prints populated state counts as JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-state-doctor-ok-'));
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath, { now: () => '2026-07-09T12:00:00.000Z' });
  try {
    store.recordRunResult({
      repo: 'TheTekTeam/modelspend',
      issueNumber: 580,
      mode: 'issue-run',
      exitCode: 0,
      payload: { selectedIssue: 580 },
    });
  } finally {
    store.close();
  }

  try {
    const output = memoryIo();
    assert.equal(run(['--db', dbPath, '--history-limit', '1'], {}, output.io), 0);
    const summary = JSON.parse(output.read().stdout);
    assert.equal(summary.status, 'ok');
    assert.equal(summary.counts.run_results, 1);
    assert.equal(summary.latest.run_results.length, 1);
    assert.equal(summary.latest.run_results[0].issue_number, 580);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state doctor pretty mode prints compact operator summary', () => {
  const output = memoryIo();
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-state-doctor-pretty-'));
  const dbPath = join(dir, 'missing.sqlite');
  try {
    assert.equal(run(['--db', dbPath, '--pretty'], {}, output.io), 0);
    assert.match(output.read().stdout, /runner state: missing/);
    assert.match(output.read().stdout, /counts:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state doctor repair command safely reports zero candidates for a healthy database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-state-doctor-repair-empty-'));
  const dbPath = join(dir, 'state.sqlite');
  const store = openRunnerStateStore(dbPath);
  store.close();
  try {
    const output = memoryIo();
    assert.equal(run(['--db', dbPath, '--repair-dry-run-false-attention'], {}, output.io), 0);
    const result = JSON.parse(output.read().stdout);
    assert.equal(result.repair.mode, 'report-only');
    assert.equal(result.repair.candidatesFound, 0);
    assert.equal(result.repair.candidatesRepaired, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state doctor CLI reports then applies only an exact proven false fixture and leaves schema 8 healthy (#725)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-state-doctor-repair-exact-'));
  const dbPath = join(dir, 'state.sqlite');
  const fixture = seedFalseDryRunCliFixture(dbPath);
  try {
    const reportOutput = memoryIo();
    assert.equal(run(['--db', dbPath, '--repair-dry-run-false-attention'], {}, reportOutput.io), 0);
    const reportText = reportOutput.read().stdout;
    assert.equal(reportText.includes('restricted-session-sentinel'), false);
    assert.equal(reportText.includes('payload_json'), false);
    const reported = JSON.parse(reportText);
    assert.equal('latest' in reported, false);
    assert.equal('currentHealthConditions' in reported, false);
    assert.equal(reported.currentHealthConditionCount, 0);
    assert.equal(reported.repair.mode, 'report-only');
    assert.equal(reported.repair.candidatesEligible, 1);
    assert.deepEqual(reported.repair.wouldRepair.runResultIds, [fixture.runResultId]);
    assert.deepEqual(reported.repair.wouldRepair.attemptIds, [fixture.attemptId]);
    assert.deepEqual(reported.repair.wouldRepair.attentionEventIds, [fixture.attentionEventId]);
    assert.equal(reported.counts.recovery_attempts, 1, 'report-only preserved the attempt');
    assert.equal(reported.counts.attention_events, 1, 'report-only preserved the attention event');

    const applyOutput = memoryIo();
    assert.equal(run(['--db', dbPath, '--repair-dry-run-false-attention', '--apply'], {}, applyOutput.io), 0);
    const applyText = applyOutput.read().stdout;
    assert.equal(applyText.includes('restricted-session-sentinel'), false);
    assert.equal(applyText.includes('payload_json'), false);
    const applied = JSON.parse(applyText);
    assert.equal('latest' in applied, false);
    assert.equal('currentHealthConditions' in applied, false);
    assert.equal(applied.repair.candidatesRepaired, 1);
    assert.deepEqual(applied.repair.affected.runResultIds, [fixture.runResultId]);
    assert.deepEqual(applied.repair.affected.attemptIds, [fixture.attemptId]);
    assert.deepEqual(applied.repair.affected.attentionEventIds, [fixture.attentionEventId]);
    assert.equal(applied.ok, true);
    assert.equal(applied.status, 'ok');
    assert.equal(applied.schemaVersion, RUNNER_STATE_SCHEMA_VERSION);
    assert.equal(applied.counts.recovery_attempts, 0);
    assert.equal(applied.counts.attention_events, 0);
    assert.equal(applied.counts.issue_selections, 1);
    assert.equal(applied.counts.run_results, 1);
    assert.equal(applied.counts.queue_events, 0);
    assert.equal(applied.counts.runner_health_conditions, 0);
    assert.equal(applied.currentHealthConditionCount, 0);

    const store = openRunnerStateStore(dbPath);
    try {
      const repairedRun = store.allRows('run_results')[0];
      assert.equal(repairedRun.mode, 'scheduler-dry-run');
      assert.equal(repairedRun.exit_code, 0);
      assert.equal(store.currentHealthConditions().length, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state doctor refuses to report successful apply when the database is missing', () => {
  const output = memoryIo();
  const dir = mkdtempSync(join(tmpdir(), 'modelspend-runner-state-doctor-apply-missing-'));
  const dbPath = join(dir, 'missing.sqlite');
  try {
    assert.equal(run(['--db', dbPath, '--repair-dry-run-false-attention', '--apply'], {}, output.io), 1);
    const result = JSON.parse(output.read().stdout);
    assert.equal(result.repair.reason, 'state-db-missing');
    assert.equal(result.repair.candidatesRepaired, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
