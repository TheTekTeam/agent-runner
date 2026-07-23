import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canaryProofHelp,
  evaluateCanaryProof,
  parseCanaryProofArgs,
  runCanaryProofCli,
} from './agent-runner-canary-proof.mjs';

const PREFLIGHT = 'github-comment:database:5057357402';
const SINCE = '2026-07-23T10:40:00.000Z';
const STARTED = '2026-07-23T10:45:00.000Z';
const FINISHED = '2026-07-23T10:50:00.000Z';

function completeEvidence(overrides = {}) {
  const attemptId = 'TheTekTeam/modelspend#686:2026-07-23T10:45:00.000Z';
  const runId = 52;
  return {
    issueNumber: 686,
    sourcePreflightComment: PREFLIGHT,
    since: SINCE,
    claims: [{
      id: 42,
      issue_number: 686,
      created_at: '2026-07-23T10:44:59.000Z',
      source_preflight_comment_id: PREFLIGHT,
    }],
    recoveryAttempts: [{
      attempt_id: attemptId,
      issue_number: 686,
      started_at: STARTED,
      finished_at: FINISHED,
      phase: 'implementation',
      outcome: 'completed',
      exit_code: 0,
      preflight_revision: PREFLIGHT,
    }],
    runResults: [{
      id: runId,
      issue_number: 686,
      created_at: FINISHED,
      started_at: STARTED,
      finished_at: FINISHED,
      exit_code: 0,
      payload_json: JSON.stringify({
        startedAt: STARTED,
        sourcePreflightCommentId: PREFLIGHT,
        terminalOutcome: 'completed',
        attentionDedupeKey: null,
        failureRecovery: null,
        implementationEvidence: { changedFiles: 3, commitSha: 'abcdef1234567890', repositoryMutated: true },
        implementationPublication: {
          pullRequestNumber: 42,
          pullRequestUrl: 'https://github.com/TheTekTeam/agent-runner/pull/42',
          draft: true,
        },
      }),
    }],
    queueEvents: [],
    attentionEvents: [],
    dashboardSnapshot: {
      generatedAt: '2026-07-23T10:51:00.000Z',
      latest: {
        runResults: [{ id: runId, issue_number: 686 }],
        recoveryAttempts: [{ attempt_id: attemptId, issue_number: 686 }],
      },
    },
    ...overrides,
  };
}

test('passes only when the exact preflight, attempt, run, notification disposition and dashboard rows correlate', () => {
  const result = evaluateCanaryProof(completeEvidence());
  assert.equal(result.passed, true);
  assert.equal(result.state, 'terminal_success');
  assert.deepEqual(result.failedChecks, []);
  assert.equal(result.evidence.publication.number, 42);
  assert.equal(result.evidence.implementation.kind, 'changed');
  assert.equal(result.evidence.notification, 'not-required');
});

test('historical success before the requested window cannot satisfy a new canary', () => {
  const input = completeEvidence();
  input.claims[0].created_at = '2026-07-22T10:00:00.000Z';
  input.recoveryAttempts[0].started_at = '2026-07-22T10:00:00.000Z';
  input.runResults[0].started_at = '2026-07-22T10:00:00.000Z';
  const result = evaluateCanaryProof(input);
  assert.equal(result.passed, false);
  assert.ok(result.failedChecks.includes('claimPersisted'));
  assert.ok(result.failedChecks.includes('attemptPersisted'));
});

test('exact preflight identity is required for claim, attempt and terminal correlation', () => {
  const input = completeEvidence();
  input.claims[0].source_preflight_comment_id = 'github-comment:database:5040770658';
  input.recoveryAttempts[0].preflight_revision = 'github-comment:database:5040770658';
  const payload = JSON.parse(input.runResults[0].payload_json);
  payload.sourcePreflightCommentId = 'github-comment:database:5040770658';
  input.runResults[0].payload_json = JSON.stringify(payload);
  const result = evaluateCanaryProof(input);
  assert.equal(result.passed, false);
  assert.equal(result.state, 'handled_noop');
});

test('a persisted claim and worker start without terminal result are not success', () => {
  const input = completeEvidence({ runResults: [] });
  input.recoveryAttempts[0].finished_at = null;
  input.recoveryAttempts[0].phase = 'implementation';
  const result = evaluateCanaryProof(input);
  assert.equal(result.passed, false);
  assert.equal(result.state, 'worker_started');
  assert.ok(result.failedChecks.includes('terminalPersistence'));
});

test('valid explicit no-change completion does not require a draft pull request', () => {
  const input = completeEvidence();
  const payload = JSON.parse(input.runResults[0].payload_json);
  payload.implementationEvidence = { changedFiles: 0, repositoryMutated: false };
  delete payload.implementationPublication;
  input.runResults[0].payload_json = JSON.stringify(payload);
  const result = evaluateCanaryProof(input);
  assert.equal(result.passed, true);
  assert.equal(result.evidence.implementation.kind, 'no-change');
  assert.equal(result.checks.draftPublication, true);
});

test('missing notification disposition fails when terminal evidence requires attention', () => {
  const input = completeEvidence();
  const payload = JSON.parse(input.runResults[0].payload_json);
  payload.attentionDedupeKey = 'attention-1';
  payload.failureRecovery = { reason: 'failure' };
  input.runResults[0].payload_json = JSON.stringify(payload);
  const result = evaluateCanaryProof(input);
  assert.equal(result.passed, false);
  assert.equal(result.evidence.notification, 'missing');
  assert.ok(result.failedChecks.includes('notificationSatisfied'));
});

test('dashboard proof requires the exact correlated run and attempt after terminal persistence', () => {
  const input = completeEvidence();
  input.dashboardSnapshot.latest.runResults[0].id = 51;
  const result = evaluateCanaryProof(input);
  assert.equal(result.passed, false);
  assert.ok(result.failedChecks.includes('dashboardRefreshed'));
});

test('CLI parser requires exact source identity, time window and dashboard snapshot', () => {
  assert.throws(() => parseCanaryProofArgs(['--issue', '686']), /source-preflight-comment/);
  const parsed = parseCanaryProofArgs([
    '--project', 'modelspend',
    '--issue', '686',
    '--source-preflight-comment', PREFLIGHT,
    '--since', SINCE,
    '--dashboard-snapshot', '/tmp/dashboard-data.js',
    '--state-db', '/tmp/runner-state.sqlite',
  ]);
  assert.equal(parsed.issueNumber, 686);
  assert.equal(parsed.sourcePreflightComment, PREFLIGHT);
});

test('proof CLI prints meaningful help', () => {
  const writes = [];
  const exitCode = runCanaryProofCli(['--help'], {}, { stdout: { write: (value) => writes.push(value) }, stderr: { write: () => {} } });
  assert.equal(exitCode, 0);
  assert.match(writes.join(''), /--source-preflight-comment/);
  assert.match(canaryProofHelp(), /--dashboard-snapshot/);
});

test('proof CLI exit code matches passed and emits sanitized JSON only', () => {
  const input = completeEvidence();
  const tableRows = {
    claims: input.claims,
    recovery_attempts: input.recoveryAttempts,
    run_results: input.runResults,
    queue_events: input.queueEvents,
    attention_events: input.attentionEvents,
  };
  const db = {
    prepare(sql) {
      const table = Object.keys(tableRows).find((name) => sql.includes(`FROM ${name}`));
      return { all: () => tableRows[table] || [] };
    },
    close() {},
  };
  const writes = [];
  const exitCode = runCanaryProofCli([
    '--issue', '686',
    '--source-preflight-comment', PREFLIGHT,
    '--since', SINCE,
    '--dashboard-snapshot', '/tmp/dashboard-data.js',
    '--state-db', '/tmp/runner-state.sqlite',
  ], {}, {
    stdout: { write: (value) => writes.push(value) },
    stderr: { write: (value) => writes.push(value) },
  }, {
    openDb: () => db,
    parseDashboardSnapshot: () => input.dashboardSnapshot,
  });
  assert.equal(exitCode, 0);
  const output = JSON.parse(writes.join(''));
  assert.equal(output.passed, true);
  assert.equal(output.evidence.runResultId, 52);
  assert.doesNotMatch(writes.join(''), /provider response|ANTHROPIC_API_KEY|stdout/);
});
