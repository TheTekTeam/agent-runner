import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GATE_IDS,
  REPORT_SCHEMA_VERSION,
  evaluateReliabilityAcceptance,
  runReliabilityAcceptanceCli,
} from './agent-runner-reliability-acceptance.mjs';
import { RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';

const HEAD = '36adcedee9341bedeab0db668f4408268ac466d2';
const OTHER = 'cccccccccccccccccccccccccccccccccccccccc';
const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = '2026-07-24T20:00:00.000Z';
const DB = 'state-db-main-001';
const HERE = dirname(fileURLToPath(import.meta.url));
const ACCEPTANCE_MODULE = join(HERE, 'agent-runner-reliability-acceptance.mjs');
const base = (evidenceId, capturedAt = '2026-07-24T19:10:00.000Z') => ({ evidenceId, capturedAt, head: HEAD });
const state = (id, at) => ({ ...base(id, at), stateDbId: DB });
const attempt = (id, at) => ({ ...state(id, at), issueNumber: 901, attemptId: 'attempt-901-a' });

function bundle() {
  const revision = 'AR901-CANARY-2026-07-24.1';
  const fingerprint = `sha256:${'b'.repeat(64)}`;
  return {
    schemaVersion: 'agent-runner-reliability-evidence/v1',
    acceptanceId: 'dell-acceptance-20260724-a',
    repository: 'TheTekTeam/agent-runner', issueNumber: 5,
    expectedHead: HEAD, deployedHead: HEAD, stateDbId: DB, stateSchemaVersion: RUNNER_STATE_SCHEMA_VERSION,
    windowStartedAt: '2026-07-24T19:00:00.000Z', windowEndedAt: '2026-07-24T19:59:00.000Z',
    records: {
      repository: { ...base('repo-1', '2026-07-24T19:01:00.000Z'), repository: 'TheTekTeam/agent-runner', clean: true },
      timer: { ...base('timer-1', '2026-07-24T19:02:00.000Z'), phase: 'preacceptance', serviceState: 'inactive', timerEnabled: false, timerActive: false },
      backup: { ...state('backup-1', '2026-07-24T19:03:00.000Z'), backupId: 'backup-copy-1', backupStateDbId: DB, schemaVersion: RUNNER_STATE_SCHEMA_VERSION, backupSchemaVersion: RUNNER_STATE_SCHEMA_VERSION, consistent: true },
      focusedValidation: { ...base('focused-1', '2026-07-24T19:04:00.000Z'), status: 'passed', total: 35, passed: 35, failed: 0, skipped: 0, assertions: ['parser', 'correlation', 'stale_evidence', 'fault_injection', 'adversarial_redaction'] },
      fullValidation: { ...base('full-1', '2026-07-24T19:05:00.000Z'), status: 'passed', total: 1300, passed: 1298, failed: 0, skipped: 2, assertions: ['node_check', 'npm_test', 'npm_validate', 'diff_check'] },
      notification: { ...state('notification-1', '2026-07-24T19:06:00.000Z'), issueNumber: 900, attemptId: 'smoke-a', synthetic: true, transport: 'synthetic-capture', eventType: 'completed', deliveryStatus: 'delivered', notificationEventId: 'event-1' },
      dashboard: { ...state('dashboard-1', '2026-07-24T19:07:00.000Z'), issueNumber: 900, attemptId: 'smoke-a', generatedAt: '2026-07-24T19:06:30.000Z', notificationEventId: 'event-1', runResultId: 'run-smoke-1', containsNotification: true, containsRun: true },
      negativeAdmission: { ...state('negative-1', '2026-07-24T19:08:00.000Z'), profileFingerprintId: 'profile-1', refusalReason: 'machine_profile', beforeGithubIdentityId: 'github-1', afterGithubIdentityId: 'github-1', claimDelta: 0, attemptDelta: 0, workerStartDelta: 0, githubMutationDelta: 0 },
      repeatedRefusal: { ...state('repeat-1', '2026-07-24T19:09:00.000Z'), profileFingerprintId: 'profile-1', refusalReason: 'machine_profile', refusalCount: 2, nextCandidateId: 'candidate-next-1', nextCandidateConsumed: false, claimDelta: 0, attemptDelta: 0, workerStartDelta: 0, githubMutationDelta: 0 },
      issueSkip: { ...state('skip-1', '2026-07-24T19:10:00.000Z'), skippedIssueNumber: 910, skipReason: 'issue_not_runnable', continuedIssueNumber: 911, continuedCandidateSelected: true, skippedClaimDelta: 0, skippedGithubMutationDelta: 0 },
      taskFailure: { ...state('task-1', '2026-07-24T19:11:00.000Z'), issueNumber: 912, attemptId: 'attempt-912-a', scope: 'task_attempt', serviceExitCode: 0, systemdResult: 'success', unrelatedIssueNumber: 913, unrelatedIssueStatusPreserved: true, blockedMutation: false },
      blockerAudit: { ...state('blocker-1', '2026-07-24T19:12:00.000Z'), entries: [
        { evidenceId: 'block-entry-1', issueNumber: 914, scope: 'issue_not_runnable', blockedApplied: true, realBlockerEvidenceId: 'dependency-1' },
        { evidenceId: 'block-entry-2', issueNumber: 915, scope: 'machine_profile', blockedApplied: false, realBlockerEvidenceId: null },
      ] },
      canary: {
        ...attempt('canary-1', '2026-07-24T19:30:00.000Z'),
        managerPacket: { ...base('manager-1', '2026-07-24T19:20:00.000Z'), issueNumber: 901, attemptId: 'attempt-901-a', revision, fingerprint },
        claim: { ...attempt('claim-1', '2026-07-24T19:21:00.000Z'), revision, fingerprint },
        workerStart: { ...attempt('worker-1', '2026-07-24T19:22:00.000Z'), revision, fingerprint, started: true },
        repositoryChange: { ...attempt('change-1', '2026-07-24T19:23:00.000Z'), commitSha: COMMIT, changedFiles: 3 },
        draftPr: { ...attempt('pr-1', '2026-07-24T19:24:00.000Z'), commitSha: COMMIT, prNumber: 100, draft: true },
        terminal: { ...attempt('terminal-1', '2026-07-24T19:25:00.000Z'), outcome: 'completed', durable: true, exitCode: 0, runResultId: 'canary-run-1' },
        notification: { ...attempt('canary-notification-1', '2026-07-24T19:26:00.000Z'), disposition: 'delivered', notificationEventId: 'canary-event-1' },
        dashboard: { ...attempt('canary-dashboard-1', '2026-07-24T19:27:00.000Z'), generatedAt: '2026-07-24T19:26:30.000Z', runResultId: 'canary-run-1', notificationEventId: 'canary-event-1' },
      },
      repair: { ...state('repair-1', '2026-07-24T19:35:00.000Z'), incidentId: 'incident-1',
        firstPass: { evidenceId: 'repair-first-1', proposalDigestId: 'digest-1', eligibleCount: 2, appliedCount: 2, restoredIssueNumbers: [920, 921], deterministic: true },
        secondPass: { evidenceId: 'repair-second-1', proposalDigestId: 'digest-2', eligibleCount: 0, appliedCount: 0, restoredIssueNumbers: [], deterministic: true, noChanges: true } },
      recurrence: { ...state('recurrence-1', '2026-07-24T19:45:00.000Z'), timerUnitId: 'agent-runner-modelspend.timer', triggerIds: ['trigger-1', 'trigger-2'], runIds: ['run-1', 'run-2'], triggeredAt: ['2026-07-24T19:40:00.000Z', '2026-07-24T19:44:00.000Z'], enabled: true },
      reboot: { ...state('reboot-1', '2026-07-24T19:55:00.000Z'), beforeBootId: 'boot-1', afterBootId: 'boot-2', postBootTriggerId: 'post-trigger-1', postBootRunId: 'post-run-1', unitEnabled: true, serviceHealthy: true },
      redaction: { ...base('redaction-1', '2026-07-24T19:56:00.000Z'), fixtureSetId: 'fixtures-1', serializedOutputDigestId: 'output-digest-1', cases: ['credentials', 'environment_values', 'exception_messages', 'full_issue_bodies', 'local_secret_paths', 'prompts', 'provider_output', 'raw_logs', 'restricted_handles'], leakCount: 0, serialized: true },
    },
  };
}

const evaluate = (value = bundle(), options = {}) => evaluateReliabilityAcceptance(value, { expectedHead: HEAD, now: NOW, maxAgeSeconds: 3600, ...options });
const gate = (report, id) => report.gates.find((item) => item.id === id);

 test('complete canonical evidence passes all gates in closed order and schema', () => {
  const report = evaluate();
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(report.mode, 'report-only');
  assert.equal(report.passed, true);
  assert.deepEqual(report.gates.map((item) => item.id), GATE_IDS);
  assert.deepEqual(report.summary, { required: 20, passed: 20, failed: 0 });
  report.gates.forEach((item) => assert.deepEqual(Object.keys(item), ['id', 'passed', 'reasonCode', 'evidenceIds', 'safeNextAction']));
});

test('canonical schema values pass state_schema_current', () => {
  const value = bundle();
  assert.equal(value.stateSchemaVersion, RUNNER_STATE_SCHEMA_VERSION);
  assert.equal(value.records.backup.schemaVersion, RUNNER_STATE_SCHEMA_VERSION);
  assert.equal(value.records.backup.backupSchemaVersion, RUNNER_STATE_SCHEMA_VERSION);
  assert.equal(gate(evaluate(value), 'state_schema_current').passed, true);
});

test('self-consistent stale top-level, live and backup schema values fail', () => {
  const value = bundle();
  const stale = RUNNER_STATE_SCHEMA_VERSION - 1;
  value.stateSchemaVersion = stale;
  value.records.backup.schemaVersion = stale;
  value.records.backup.backupSchemaVersion = stale;
  assert.deepEqual(gate(evaluate(value), 'state_schema_current'), {
    id: 'state_schema_current', passed: false, reasonCode: 'schema_mismatch',
    evidenceIds: ['backup-1'], safeNextAction: 'Migrate the copied state through the authorised process, then recapture schema evidence.',
  });
});

for (const [name, mutate] of [
  ['top-level', (value, stale) => { value.stateSchemaVersion = stale; }],
  ['live', (value, stale) => { value.records.backup.schemaVersion = stale; }],
  ['backup', (value, stale) => { value.records.backup.backupSchemaVersion = stale; }],
]) test(`one stale ${name} schema component fails`, () => {
  const value = bundle();
  mutate(value, RUNNER_STATE_SCHEMA_VERSION - 1);
  assert.equal(gate(evaluate(value), 'state_schema_current').reasonCode, 'schema_mismatch');
});

test('importing the evaluator is side-effect free and grants no operational capability', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runner-acceptance-import-'));
  try {
    execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(ACCEPTANCE_MODULE).href)});`,
    ], { cwd: root, stdio: 'pipe' });
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const source = readFileSync(ACCEPTANCE_MODULE, 'utf8');
  const imports = source.split('\n').filter((line) => line.startsWith('import '));
  assert.deepEqual(imports, [
    "import { readFileSync, statSync } from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    "import { RUNNER_STATE_SCHEMA_VERSION } from './claude-runner-state.mjs';",
  ]);
  assert.doesNotMatch(source, /node:(?:child_process|http|https|net|tls|sqlite)/);
  assert.doesNotMatch(source, /\b(?:DatabaseSync|openRunnerStateStore|fetch|exec|execFile|spawn|systemctl)\s*\(/);
  assert.doesNotMatch(source, /\b(?:writeFile|appendFile|mkdir|rm|rename|unlink|chmod)(?:Sync)?\s*\(/);
  assert.doesNotMatch(source, /from ['"][^'"]*(?:github|octokit|provider)[^'"]*['"]/i);
});

test('identical input and time produce deterministic output', () => assert.deepEqual(evaluate(), evaluate()));

test('unknown secret-like input fields fail closed without echo', () => {
  const value = bundle(); value.rawProviderOutput = 'ghp_should_never_appear';
  const text = JSON.stringify(evaluate(value));
  assert.doesNotMatch(text, /ghp_should_never_appear|rawProviderOutput/);
  assert.ok(JSON.parse(text).gates.every((item) => item.reasonCode === 'input_schema_invalid'));
});

test('oversized arrays fail schema validation closed', () => {
  const value = bundle(); value.records.blockerAudit.entries = Array.from({ length: 33 }, (_, i) => ({ evidenceId: `e-${i}`, issueNumber: i + 1, scope: 'machine_profile', blockedApplied: false, realBlockerEvidenceId: null }));
  assert.ok(evaluate(value).gates.every((item) => item.reasonCode === 'input_schema_invalid'));
});

test('stale, future and contradictory windows fail every gate closed', () => {
  let value = bundle(); value.windowStartedAt = '2026-07-24T17:00:00.000Z'; value.windowEndedAt = '2026-07-24T18:00:00.000Z';
  assert.ok(evaluate(value, { maxAgeSeconds: 60 }).gates.every((item) => item.reasonCode === 'evidence_stale'));
  value = bundle(); value.windowEndedAt = '2026-07-24T21:00:00.000Z';
  assert.ok(evaluate(value).gates.every((item) => item.reasonCode === 'evidence_future_dated'));
  value = bundle(); value.windowStartedAt = '2026-07-24T20:00:00.000Z';
  assert.ok(evaluate(value).gates.every((item) => item.reasonCode === 'contradictory_evidence'));
});

test('expected, bundle and deployed heads must match exactly', () => {
  assert.ok(evaluate(bundle(), { expectedHead: OTHER }).gates.every((item) => item.reasonCode === 'head_mismatch'));
});

const cases = [
  ['checkout dirty', 'checkout_clean', 'checkout_dirty', (v) => { v.records.repository.clean = false; }],
  ['timer enabled', 'timer_preacceptance_disabled', 'timer_not_disabled', (v) => { v.records.timer.timerEnabled = true; }],
  ['service active', 'timer_preacceptance_disabled', 'service_state_invalid', (v) => { v.records.timer.serviceState = 'active'; }],
  ['backup identity', 'state_backup_recorded', 'backup_identity_mismatch', (v) => { v.records.backup.backupStateDbId = 'other-db'; }],
  ['schema mismatch', 'state_schema_current', 'schema_mismatch', (v) => { v.records.backup.backupSchemaVersion = RUNNER_STATE_SCHEMA_VERSION - 1; }],
  ['focused assertion missing', 'focused_validation_passed', 'validation_failed', (v) => { v.records.focusedValidation.assertions.pop(); }],
  ['full assertion missing', 'full_validation_passed', 'validation_failed', (v) => { v.records.fullValidation.assertions = ['node_check']; }],
  ['notification pending', 'synthetic_notification_smoke_passed', 'notification_unproven', (v) => { v.records.notification.deliveryStatus = 'pending'; }],
  ['dashboard cross attempt', 'dashboard_refresh_correlated', 'dashboard_uncorrelated', (v) => { v.records.dashboard.attemptId = 'old-attempt'; }],
  ['negative mutation', 'negative_admission_zero_mutation', 'unexpected_mutation', (v) => { v.records.negativeAdmission.workerStartDelta = 1; }],
  ['candidate consumed', 'repeated_refusal_no_queue_consumption', 'candidate_consumed', (v) => { v.records.repeatedRefusal.nextCandidateConsumed = true; }],
  ['cross-head refusal baseline', 'repeated_refusal_no_queue_consumption', 'head_mismatch', (v) => { v.records.negativeAdmission.head = OTHER; }],
  ['scan stopped', 'issue_skip_continues_scan', 'scan_not_continued', (v) => { v.records.issueSkip.continuedCandidateSelected = false; }],
  ['task not isolated', 'task_local_failure_isolated', 'task_failure_not_isolated', (v) => { v.records.taskFailure.systemdResult = 'failed'; }],
  ['unsafe blocked status', 'real_blocker_only_blocked', 'unsafe_blocked_status', (v) => { v.records.blockerAudit.entries[1].blockedApplied = true; }],
  ['canary issue mismatch', 'supervised_canary_correlated', 'issue_mismatch', (v) => { v.records.canary.claim.issueNumber = 902; }],
  ['canary attempt mismatch', 'supervised_canary_correlated', 'attempt_mismatch', (v) => { v.records.canary.workerStart.attemptId = 'old-attempt'; }],
  ['canary authority mismatch', 'supervised_canary_correlated', 'authority_mismatch', (v) => { v.records.canary.claim.revision = 'AR901-CANARY-2026-07-24.2'; }],
  ['canary historical order', 'supervised_canary_correlated', 'contradictory_evidence', (v) => { v.records.canary.repositoryChange.capturedAt = '2026-07-24T19:19:00.000Z'; }],
  ['canary non-draft', 'supervised_canary_correlated', 'canary_uncorrelated', (v) => { v.records.canary.draftPr.draft = false; }],
  ['exit code alone', 'supervised_canary_correlated', 'exit_code_only', (v) => { v.records.canary.terminal.durable = false; v.records.canary.terminal.outcome = 'failed'; }],
  ['canary dashboard mismatch', 'supervised_canary_correlated', 'canary_uncorrelated', (v) => { v.records.canary.dashboard.notificationEventId = 'old-event'; }],
  ['repair partial', 'false_block_repair_verified', 'repair_not_deterministic', (v) => { v.records.repair.firstPass.appliedCount = 1; }],
  ['repair second mutation', 'repair_second_pass_idempotent', 'repair_not_idempotent', (v) => { v.records.repair.secondPass.appliedCount = 1; v.records.repair.secondPass.noChanges = false; }],
  ['recurrence duplicate', 'timer_recurrence_passed', 'recurrence_unproven', (v) => { v.records.recurrence.triggerIds[1] = 'trigger-1'; }],
  ['reboot same boot', 'reboot_survival_passed', 'reboot_unproven', (v) => { v.records.reboot.afterBootId = 'boot-1'; }],
  ['reboot cross head', 'reboot_survival_passed', 'head_mismatch', (v) => { v.records.reboot.head = OTHER; }],
  ['redaction leak', 'redaction_passed', 'redaction_failed', (v) => { v.records.redaction.leakCount = 1; }],
];
for (const [name, id, reason, mutate] of cases) test(name, () => { const value = bundle(); mutate(value); assert.equal(gate(evaluate(value), id).reasonCode, reason); });

test('CLI read fault emits bounded report without exception or secret path', () => {
  let stdout = '';
  const exit = runReliabilityAcceptanceCli(['--evidence', '/home/gp/private-token', '--expected-head', HEAD, '--now', NOW], { stdout: { write: (v) => { stdout += v; } }, stderr: { write() {} } }, { stat: () => { throw new Error('ghp_raw_exception'); } });
  assert.equal(exit, 2); assert.doesNotMatch(stdout, /private-token|ghp_raw_exception/);
  assert.ok(JSON.parse(stdout).gates.every((item) => item.reasonCode === 'input_read_failed'));
});

test('CLI reads one bounded regular file and performs no operational action', () => {
  let stdout = '', reads = 0; const raw = JSON.stringify(bundle());
  const exit = runReliabilityAcceptanceCli(['--evidence', './evidence.json', '--expected-head', HEAD, '--now', NOW, '--max-age-seconds', '3600'], { stdout: { write: (v) => { stdout += v; } }, stderr: { write() {} } }, { stat: () => ({ size: Buffer.byteLength(raw), isFile: () => true }), readFile: () => { reads += 1; return raw; } });
  assert.equal(exit, 0); assert.equal(reads, 1); assert.equal(JSON.parse(stdout).passed, true);
});
